// Git wire formats: pkt-line framing and packfiles (read and write).
// Written from the protocol's own rules: a pkt-line is a 4-hex-digit length
// (including the 4 length bytes) followed by that many payload bytes, "0000"
// is a flush packet, and a pack is PACK v2 with type/size varints, zlib
// bodies and a SHA-1 trailer. Deltas are resolved on read; on write every
// object is stored whole (no deltas), which the protocol accepts.

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { hashObject, type ObjType } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Encode one pkt-line. Pass null for a flush packet ("0000"). */
export function pktLine(data: string | Buffer | null): Buffer {
  if (data === null) return Buffer.from('0000', 'utf8');
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'), payload]);
}

/** A parsed pkt-line stream: lines (without the length prefix) and flushes. */
export type PktItem = { kind: 'line'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' };

export function parsePktLines(buf: Buffer): PktItem[] {
  const items: PktItem[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const size = parseInt(buf.subarray(offset, offset + 4).toString('utf8'), 16);
    if (!Number.isFinite(size) || size < 0) break;
    if (size === 0) {
      items.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (size === 1) {
      items.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (offset + size > buf.length) break;
    items.push({ kind: 'line', data: buf.subarray(offset + 4, offset + size) });
    offset += size;
  }
  return items;
}

/** The packets of one pkt-line section, stopping at (and dropping) the flush. */
export function sectionLines(items: PktItem[], start: number): { lines: Buffer[]; next: number } {
  const lines: Buffer[] = [];
  let i = start;
  while (i < items.length) {
    const item = items[i]!;
    if (item.kind === 'flush') return { lines, next: i + 1 };
    if (item.kind === 'line') lines.push(item.data);
    i += 1;
  }
  return { lines, next: i };
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

export interface PackObject {
  oid: string;
  type: ObjType;
  data: Buffer;
}

const TYPE_TO_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a packfile holding the given objects, whole (no deltas). */
export function writePack(objects: { type: ObjType; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [Buffer.from('PACK', 'utf8')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  chunks.push(version);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  chunks.push(count);
  for (const obj of objects) {
    const code = TYPE_TO_CODE[obj.type]!;
    const compressed = deflateSync(obj.data);
    const size = obj.data.length;
    // Type/size varint: first byte holds 4 size bits + 3 type bits + cont bit,
    // following bytes hold 7 size bits each, little-endian groups.
    const first = (code << 4) | (size & 0x0f);
    const varint: number[] = [];
    let remaining = size >> 4;
    varint.push(remaining > 0 ? first | 0x80 : first);
    while (remaining > 0) {
      const byte = remaining & 0x7f;
      remaining >>= 7;
      varint.push(remaining > 0 ? byte | 0x80 : byte);
    }
    chunks.push(Buffer.from(varint));
    chunks.push(compressed);
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Parse a packfile, resolving OFS_DELTA (6) and REF_DELTA (7) entries. */
export function readPack(buf: Buffer): PackObject[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('utf8') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = buf.readUInt32BE(8);
  let offset = 12;
  const raw: { type: number; data: Buffer; baseOid?: string; baseOffset?: number; offset: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = buf[offset++];
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (type === 6) {
      byte = buf[offset++];
      let base = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[offset++];
        base = ((base + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - base;
    } else if (type === 7) {
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    // One inflate gives both the object bytes and, via the engine's
    // bytesWritten, the exact number of compressed input bytes the zlib
    // stream consumed (trailing bytes are not counted). That replaces the
    // old zlibConsumed binary search (~10 extra inflateSync calls per
    // object, ~30 per push pack). If a future Node stops exposing the
    // counter, fall back to the binary search so parsing stays correct.
    const { buffer: inflated, engine } = inflateSync(buf.subarray(offset), { info: true });
    if (inflated.length !== size) throw new Error('pack entry size mismatch');
    const consumed = typeof engine?.bytesWritten === 'number' && engine.bytesWritten > 0
      ? engine.bytesWritten
      : zlibConsumed(buf.subarray(offset), size);
    offset += consumed;
    raw.push({ type, data: inflated, baseOid, baseOffset, offset: start });
  }
  // Resolve deltas in offset order (bases always precede their deltas).
  const byOffset = new Map<number, PackObject>();
  const byOid = new Map<string, PackObject>();
  const out: PackObject[] = [];
  for (const entry of raw) {
    let resolved: PackObject;
    if (entry.type === 6 || entry.type === 7) {
      const base = entry.type === 6 ? byOffset.get(entry.baseOffset!) : byOid.get(entry.baseOid!);
      if (!base) throw new Error('pack delta base missing');
      const data = applyDelta(base.data, entry.data);
      resolved = { oid: hashObject(base.type, data), type: base.type, data };
    } else {
      const type = CODE_TO_TYPE[entry.type]!;
      resolved = { oid: hashObject(type, entry.data), type, data: entry.data };
    }
    byOffset.set(entry.offset, resolved);
    byOid.set(resolved.oid, resolved);
    out.push(resolved);
  }
  return out;
}

/** Bytes of a zlib stream needed to produce `expected` bytes of output. */
function zlibConsumed(compressed: Buffer, expected: number): number {
  // Inflate incrementally in a small loop: try growing lengths until the
  // output size matches. Zlib streams here are short, so a binary search on
  // the input length is cheap and exact.
  let lo = 1;
  let hi = compressed.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const out = inflateSync(compressed.subarray(0, mid));
      if (out.length >= expected) hi = mid;
      else lo = mid + 1;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

/** Apply a git binary delta (source size, target size, copy/insert ops). */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    while (true) {
      const byte = delta[offset++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) return value;
    }
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const chunks: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset++]!;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (opcode & (1 << i)) copyOffset |= delta[offset++]! << (8 * i);
      }
      for (let i = 0; i < 3; i += 1) {
        if (opcode & (0x10 << i)) copySize |= delta[offset++]! << (8 * i);
      }
      if (copySize === 0) copySize = 0x10000;
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode !== 0) {
      chunks.push(delta.subarray(offset, offset + opcode));
      offset += opcode;
      produced += opcode;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(chunks);
  if (result.length !== targetSize || produced !== targetSize) {
    throw new Error('delta target size mismatch');
  }
  return result;
}
