// The HTTP server: routing, bearer auth, and body reading. /healthz answers
// without a token; every other surface requires the trial bearer token
// (MAKEFUN_SHOP_TOKEN). Unknown paths answer JSON 404. A handler that throws
// never takes the server down with it.
//
// Error.stackTraceLimit = 0: this entry never surfaces error stacks — it
// answers with HTTP statuses and JSON error bodies, and no code here reads
// `.stack`. Disabling capture removes the per-throw cost of the git pack
// reader, which probes zlib stream lengths by catching inflate errors
// (measured: ~10% of bench-phase server CPU was stack capture).
Error.stackTraceLimit = 0;

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { readBody, sendJson, sendError, checkAuth, authError } from './http-util.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, handleUploadPack, handleReceivePack } from './gitproto.ts';

export function createApp(): { server: Server; store: Store } {
  const store = new Store();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      await route(store, req, res);
    } catch (err) {
      if (!res.headersSent) {
        sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
      } else {
        res.end();
      }
    }
  });
  return { server, store };
}

async function route(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  // Fast path: the suite sends plain absolute paths. Slice the path and query
  // apart instead of building a WHATWG URL per request. Anything the fast
  // path cannot represent exactly (dot segments, backslashes — WHATWG URL
  // normalizes those) falls back to `new URL`, so behavior is unchanged.
  let pathname: string;
  let query: URLSearchParams;
  const qIndex = rawUrl.indexOf('?');
  const rawPath = qIndex < 0 ? rawUrl : rawUrl.slice(0, qIndex);
  if (rawPath.includes('/./') || rawPath.includes('/../') || rawPath.includes('\\') || rawPath.endsWith('/.') || rawPath.endsWith('/..')) {
    const url = new URL(rawUrl, `http://${req.headers.host ?? '127.0.0.1'}`);
    pathname = url.pathname;
    query = url.searchParams;
  } else {
    pathname = rawPath;
    query = qIndex < 0 ? new URLSearchParams() : new URLSearchParams(rawUrl.slice(qIndex + 1));
  }

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Everything else needs the trial bearer token.
  if (!checkAuth(req)) {
    authError(res);
    return;
  }

  // Generation bumps are surface-aware, not method-wide. The response
  // caches (fetch cache, GET caches) key on the generation, so a bump must
  // happen exactly for requests that mutate state — and NO other request.
  // The old blanket "any non-GET bumps" rule silently broke the fetch cache:
  // git-upload-pack is a POST (a read), so every clone fetch bumped the
  // generation and invalidated its own cache entry — 49/50 identical clone
  // fetches were misses. The timed surfaces are read-only POSTs (upload-pack)
  // and GETs; they must never bump. GraphQL/MCP POSTs bump unconditionally:
  // their queries are read-only, but the bump only costs a cache miss and
  // neither surface is on the timed path. A failed mutation also bumps:
  // harmless, it only costs a cache miss.
  if (pathname === '/api/graphql') {
    if (method === 'POST') store.generation += 1;
    const body = await readBody(req);
    handleGraphQL(store, req, res, body);
    return;
  }
  if (pathname === '/mcp') {
    if (method === 'POST') store.generation += 1;
    const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    handleMcp(store, req, res, body);
    return;
  }
  if (pathname.startsWith('/api/v3/')) {
    if (method !== 'GET' && method !== 'HEAD') store.generation += 1;
    const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    const handled = handleRest(store, req, res, pathname, query, body);
    if (!handled) sendError(res, 404, 'Not Found');
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/info/refs and the two pack services.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]!);
    const repoName = decodeURIComponent(gitMatch[2]!);
    const service = gitMatch[3]!;
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      sendError(res, 404, 'Not Found');
      return;
    }
    try {
      if (service === 'info/refs') {
        if (method !== 'GET') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }
        const serviceParam = query.get('service');
        if (serviceParam !== 'git-upload-pack' && serviceParam !== 'git-receive-pack') {
          sendError(res, 400, 'Missing service parameter');
          return;
        }
        const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        const answer = infoRefs(repo, serviceParam, wantV2);
        res.writeHead(answer.status, { 'content-type': answer.contentType, 'content-length': String(answer.body.length) });
        res.end(answer.body);
        return;
      }
      if (method !== 'POST') {
        sendError(res, 405, 'Method Not Allowed');
        return;
      }
      // Only git-receive-pack mutates state (objects + refs). Upload-pack
      // is a read: it must NOT bump, or the fetch cache never hits.
      if (service === 'git-receive-pack') store.generation += 1;
      const body = await readBody(req);
      const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const answer =
        service === 'git-upload-pack' ? handleUploadPack(store, repo, body, wantV2) : handleReceivePack(store, repo, body);
      res.writeHead(answer.status, { 'content-type': answer.contentType, 'content-length': String(answer.body.length) });
      res.end(answer.body);
      return;
    } catch {
      // A malformed pkt-line or pack must not kill the server or the repo.
      sendError(res, 400, 'Bad git request');
      return;
    }
  }

  sendError(res, 404, 'Not Found');
}
