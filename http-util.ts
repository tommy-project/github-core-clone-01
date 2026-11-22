// Small HTTP helpers shared by the REST, GraphQL, MCP and git handlers:
// JSON replies (always application/json with a request id), body reading,
// and the bearer-token check against MAKEFUN_SHOP_TOKEN.

import type { IncomingMessage, ServerResponse } from 'node:http';

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  // Encode once: Buffer.from gives the bytes and their length in a single
  // pass, instead of JSON.stringify + a second Buffer.byteLength scan.
  const body = value === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value), 'utf8');
  sendCachedJson(res, status, body, extraHeaders);
}

/**
 * Send a pre-serialized JSON body (e.g. a memoized GET response) with a
 * FRESH request id — the id must stay unique per reply, so it is never part
 * of a cached body. Headers and framing are identical to sendJson.
 */
export function sendCachedJson(res: ServerResponse, status: number, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  };
  headers['content-length'] = String(body.length);
  res.writeHead(status, headers);
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    // A body that arrives in one chunk (the common case: 1.2 KiB push packs,
    // small REST/GraphQL JSON) needs no copy — Buffer.concat would copy it.
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * The bearer check. The trial's token arrives in MAKEFUN_SHOP_TOKEN; when
 * that variable is absent (local development) any non-empty bearer token is
 * accepted, so the server can still be exercised by hand.
 *
 * Fast path: the header the suite sends is exactly `Bearer <token>`, so one
 * string comparison against the prebuilt expected header answers the common
 * case. Anything else falls through to the exact previous logic (slice +
 * trim + compare), so behavior is unchanged.
 */
let cachedExpectedHeader: string | null = null;
let cachedExpectedToken: string | undefined;
export function checkAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected !== undefined) {
    if (cachedExpectedToken !== expected) {
      cachedExpectedToken = expected;
      cachedExpectedHeader = `Bearer ${expected}`;
    }
    if (header === cachedExpectedHeader) return true;
  }
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (!presented) return false;
  if (expected) return presented === expected;
  return true;
}

export function authError(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' }, { 'www-authenticate': 'Bearer realm="github-core-clone"' });
}
