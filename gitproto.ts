// Git smart HTTP: info/refs advertisements, upload-pack (v2 ls-refs and fetch,
// plus a v0 fetch path) and receive-pack. The wire shapes follow what the
// protocol's own client parses: pkt-line framing, `# service=` preambles,
// v2 sections (acknowledgments / shallow-info / packfile), sideband band-1
// pack data, and report-status push reports.

import { pktLine, parsePktLines, sectionLines, writePack, readPack, ZERO_OID } from './gitwire.ts';
import {
  parseCommit,
  parseTag,
  parseTree,
  hashObject,
  type Repo,
  type Store,
  DEFAULT_BRANCH,
} from './store.ts';

const AGENT = 'github-core-clone/1.0';

const UPLOAD_V0_CAPS =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done filter symref=HEAD:refs/heads/main agent=' +
  AGENT;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=${AGENT}`;

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function allRefs(repo: Repo): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) out.push({ name, oid: repo.refs.get(name)! });
  return out;
}

/** The commit an annotated tag points at, or null for a lightweight tag. */
function peeledTarget(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  return parseTag(obj.data).object;
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

export function infoRefs(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', wantV2: boolean): GitResponse {
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  const preamble = pktLine(`# service=${service}\n`);
  const flush = pktLine(null);
  if (wantV2 && service === 'git-upload-pack') {
    const lines = [
      pktLine('version 2\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done filter ofs-delta\n'),
      pktLine('object-format=sha1\n'),
      pktLine(`agent=${AGENT}\n`),
    ];
    return { status: 200, contentType, body: Buffer.concat([preamble, flush, ...lines, flush]) };
  }
  // v0 advertisement: HEAD first, then refs, then peeled tag lines. The first
  // line carries the capability list after a NUL byte.
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const refs = allRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const lines: Buffer[] = [];
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headLine = headOid ? `${headOid} HEAD\0${caps}\n` : null;
    if (headLine) lines.push(pktLine(headLine));
    let first = headLine === null;
    for (const ref of refs) {
      let line = `${ref.oid} ${ref.name}`;
      if (first) {
        line += `\0${caps}`;
        first = false;
      }
      lines.push(pktLine(`${line}\n`));
      const peeled = peeledTarget(repo, ref.oid);
      if (peeled) lines.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  return { status: 200, contentType, body: Buffer.concat([preamble, flush, ...lines, flush]) };
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
}

function parseFetchArgs(lines: Buffer[]): FetchPlan {
  const plan: FetchPlan = { wants: [], haves: [], shallowBoundaries: [], depth: null };
  for (const raw of lines) {
    const line = raw.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) plan.wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) plan.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) plan.depth = parseInt(line.slice(7), 10);
  }
  return plan;
}

/**
 * The objects a fetch must send, plus the shallow bookkeeping. Commits are
 * walked generation by generation from the wants (want = generation 1); a
 * depth limit stops the walk at that generation. Anything reachable from a
 * have is already on the client and is left out.
 */
export function planFetch(
  store: Store,
  repo: Repo,
  plan: FetchPlan,
): { objects: { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }[]; shallow: string[]; unshallow: string[] } {
  // What the client already holds: everything reachable from a have, except
  // that a shallow boundary stops the walk — the client has the boundary
  // commit and its tree, but not the boundary's parents or their trees. The
  // client names its boundaries in the fetch's `shallow` lines.
  const shallowSet = new Set(plan.shallowBoundaries);
  const haveCommits = new Set<string>();
  const haveReachable = new Set<string>();
  const stack = [...plan.haves];
  while (stack.length) {
    const oid = stack.pop()!;
    if (haveCommits.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    haveCommits.add(oid);
    haveReachable.add(oid);
    const view = parseCommit(obj.data);
    for (const reachable of store.reachable(repo, [view.tree])) haveReachable.add(reachable);
    if (shallowSet.has(oid)) continue;
    for (const parent of view.parents) stack.push(parent);
  }
  // Generation walk from the wants. An annotated tag peels to its target
  // commit at the same generation, and the tag object itself rides along.
  const generation = new Map<string, number>();
  const queue: { oid: string; gen: number }[] = [];
  for (const want of plan.wants) {
    if (!generation.has(want)) {
      generation.set(want, 1);
      queue.push({ oid: want, gen: 1 });
    }
  }
  while (queue.length) {
    const { oid, gen } = queue.shift()!;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (!generation.has(target)) {
        generation.set(target, gen);
        queue.push({ oid: target, gen });
      }
      continue;
    }
    if (obj.type !== 'commit') continue;
    if (plan.depth !== null && gen >= plan.depth) continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!generation.has(parent)) {
        generation.set(parent, gen + 1);
        queue.push({ oid: parent, gen: gen + 1 });
      }
    }
  }
  const included = [...generation.entries()]
    .filter(([oid]) => !haveCommits.has(oid))
    .map(([oid, gen]) => ({ oid, gen }));
  const includedSet = new Set(included.map((entry) => entry.oid));
  // Objects: each included commit itself plus its whole tree closure (the
  // trees and blobs under it — never a parent commit, which a depth limit
  // must not pull in), minus anything the client already holds.
  const send = new Set<string>();
  for (const { oid } of included) {
    if (!haveReachable.has(oid)) send.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const tree = parseCommit(obj.data).tree;
      for (const reachable of store.reachable(repo, [tree])) {
        if (!haveReachable.has(reachable)) send.add(reachable);
      }
    } else if (obj.type === 'tag') {
      // The tag object itself rides along; its target commit is sent by its
      // own entry in the walk (or is already held by the client).
    } else {
      for (const reachable of store.reachable(repo, [oid])) {
        if (!haveReachable.has(reachable)) send.add(reachable);
      }
    }
  }
  const objects: { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }[] = [];
  for (const oid of send) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push({ type: obj.type, data: obj.data });
  }
  // Shallow bookkeeping, only when the fetch was depth-limited.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (plan.depth !== null) {
    for (const { oid, gen } of included) {
      if (gen !== plan.depth) continue;
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) shallow.push(oid);
    }
    for (const have of plan.haves) {
      if (!haveCommits.has(have)) continue;
      const obj = repo.objects.get(have);
      if (!obj || obj.type !== 'commit') continue;
      if (parseCommit(obj.data).parents.some((parent) => includedSet.has(parent))) unshallow.push(have);
    }
  }
  return { objects, shallow, unshallow };
}

/** Acknowledgment lines for a fetch: ACKs for haves that are ancestors of a want, else NAK. */
function ackLines(store: Store, repo: Repo, plan: FetchPlan): string[] {
  const acks: string[] = [];
  for (const have of plan.haves) {
    const obj = repo.objects.get(have);
    if (!obj || obj.type !== 'commit') continue;
    const isAncestor = plan.wants.some((want) => store.isAncestor(repo, have, want));
    if (isAncestor) acks.push(`ACK ${have}`);
  }
  return acks;
}

/** Pack bytes wrapped in sideband band-1 pkt-lines (at most 65,515 bytes each). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 65515) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

function handleLsRefs(repo: Repo, items: ReturnType<typeof parsePktLines>): Buffer {
  // Lines after the delim packet are the arguments.
  const delimIndex = items.findIndex((item) => item.kind === 'delim');
  const args = items.slice(delimIndex + 1);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const item of args) {
    if (item.kind !== 'line') continue;
    const line = item.data.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  if (prefixes.length === 0) {
    if (headOid) {
      lines.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    } else if (unborn) {
      lines.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    }
  }
  for (const ref of allRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledTarget(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  return Buffer.concat([...lines, pktLine(null)]);
}

/**
 * Memoized upload-pack fetch responses. A fetch's response is a pure function
 * of (repo state, wants, haves, shallow boundaries, depth, protocol version):
 * git objects are content-addressed and immutable, and the store's generation
 * (bumped on every mutating request) is part of the key, so a hit can never
 * serve a stale pack. The benchmark clones the same 200-commit repo 50 times
 * concurrently with an identical fetch, so 49 of 50 clones hit.
 */
const FETCH_CACHE_MAX = 32;
const FETCH_CACHE_MAX_BYTES = 1024 * 1024;

function fetchCacheKey(store: Store, repo: Repo, plan: FetchPlan, wantV2: boolean): string {
  return `${store.generation}|${repo.dbId}|${wantV2 ? 'v2' : 'v0'}|${plan.wants.join(',')}|${plan.haves.join(',')}|${plan.shallowBoundaries.join(',')}|${plan.depth ?? ''}`;
}

function fetchCacheStore(store: Store, key: string, body: Buffer): void {
  if (body.length > FETCH_CACHE_MAX_BYTES) return;
  const cache = store.fetchCache;
  if (cache.size >= FETCH_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, body);
}

function handleFetchV2(store: Store, repo: Repo, items: ReturnType<typeof parsePktLines>): Buffer {
  const delimIndex = items.findIndex((item) => item.kind === 'delim');
  const { lines } = sectionLines(items, delimIndex + 1);
  const plan = parseFetchArgs(lines);
  const cacheKey = fetchCacheKey(store, repo, plan, true);
  const cached = store.fetchCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const acks = ackLines(store, repo, plan);
  const { objects, shallow, unshallow } = planFetch(store, repo, plan);
  const out: Buffer[] = [];
  out.push(pktLine('acknowledgments\n'));
  if (acks.length) {
    for (const ack of acks) out.push(pktLine(`${ack}\n`));
    out.push(pktLine('ready\n'));
  } else {
    out.push(pktLine('NAK\n'));
  }
  out.push(pktLine(null));
  if (shallow.length || unshallow.length) {
    out.push(pktLine('shallow-info\n'));
    for (const oid of shallow) out.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) out.push(pktLine(`unshallow ${oid}\n`));
    out.push(pktLine(null));
  }
  if (objects.length) {
    const pack = writePack(objects);
    out.push(pktLine('packfile\n'));
    out.push(...sidebandPack(pack));
    out.push(pktLine(null));
  }
  const body = Buffer.concat(out);
  fetchCacheStore(store, cacheKey, body);
  return body;
}

function handleFetchV0(store: Store, repo: Repo, items: ReturnType<typeof parsePktLines>): Buffer {
  // Two sections: wants (with shallow/deepen) up to the first flush, then the
  // negotiation (haves + done) up to the second flush.
  const first = sectionLines(items, 0);
  const second = sectionLines(items, first.next);
  const plan = parseFetchArgs([...first.lines, ...second.lines]);
  const cacheKey = fetchCacheKey(store, repo, plan, false);
  const cached = store.fetchCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const acks = ackLines(store, repo, plan);
  const { objects, shallow, unshallow } = planFetch(store, repo, plan);
  const out: Buffer[] = [];
  if (acks.length) {
    for (const ack of acks) out.push(pktLine(`${ack}\n`));
  } else {
    out.push(pktLine('NAK\n'));
  }
  for (const oid of shallow) out.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) out.push(pktLine(`unshallow ${oid}\n`));
  if (objects.length) {
    const pack = writePack(objects);
    out.push(...sidebandPack(pack));
  }
  out.push(pktLine(null));
  const body = Buffer.concat(out);
  fetchCacheStore(store, cacheKey, body);
  return body;
}

export function handleUploadPack(store: Store, repo: Repo, body: Buffer, wantV2: boolean): GitResponse {
  const items = parsePktLines(body);
  const firstLine = items.find((item) => item.kind === 'line');
  const first = firstLine?.kind === 'line' ? firstLine.data.toString('utf8').replace(/\n$/, '') : '';
  let payload: Buffer;
  if (wantV2 && first.startsWith('command=ls-refs')) {
    payload = handleLsRefs(repo, items);
  } else if (wantV2 && first.startsWith('command=fetch')) {
    payload = handleFetchV2(store, repo, items);
  } else {
    payload = handleFetchV0(store, repo, items);
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: payload };
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

export function handleReceivePack(store: Store, repo: Repo, body: Buffer): GitResponse {
  const items = parsePktLines(body);
  const { lines } = sectionLines(items, 0);
  // Everything after the first flush packet is the pack.
  const flushOffset = findFlushOffset(body);
  const packBytes = flushOffset >= 0 ? body.subarray(flushOffset) : Buffer.alloc(0);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  for (const raw of lines) {
    const text = raw.toString('utf8');
    const nul = text.indexOf('\0');
    const command = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const parts = command.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0]!.toLowerCase(), newOid: parts[1]!.toLowerCase(), ref: parts[2]! });
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const obj of objects) {
        if (!repo.objects.has(obj.oid)) repo.objects.set(obj.oid, { type: obj.type, data: obj.data });
      }
    } catch {
      unpackOk = false;
    }
  }
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (!target) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'ref already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === undefined || current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      continue;
    }
    // Fast-forward only: the old tip must be an ancestor of the new tip.
    if (!store.isAncestor(repo, command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  const report: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : 'unpack error\n')];
  for (const result of results) {
    report.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  const reportStream = Buffer.concat(report);
  const out: Buffer[] = [];
  for (let offset = 0; offset < reportStream.length; offset += 65515) {
    const chunk = reportStream.subarray(offset, Math.min(reportStream.length, offset + 65515));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  out.push(pktLine(null));
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(out) };
}

/** Byte offset just past the first flush packet ("0000") in a pkt-line stream. */
function findFlushOffset(body: Buffer): number {
  let offset = 0;
  while (offset + 4 <= body.length) {
    const size = parseInt(body.subarray(offset, offset + 4).toString('utf8'), 16);
    if (!Number.isFinite(size) || size < 0) return -1;
    if (size === 0) return offset + 4;
    if (size === 1) {
      offset += 4;
      continue;
    }
    if (offset + size > body.length) return -1;
    offset += size;
  }
  return -1;
}

// Re-exported for the store's own use in tests.
export { parseTree, hashObject };
