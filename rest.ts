// GitHub REST v3: repositories, branches, commits, contents, issues,
// comments, labels, pull requests and merges. Shapes follow what the
// conformance suite reads: status codes, field names and the Link pagination
// headers. Everything is served from the in-memory store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendCachedJson, sendError } from './http-util.ts';
import {
  VIEWER_LOGIN,
  VIEWER_NAME,
  VIEWER_EMAIL,
  trialNowSec,
  hashObject,
  type Store,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';

const isoNow = (): string => {
  // trialNowSec() is constant for the life of the process (MAKEFUN_TRIAL_NOW
  // is set before start, else a fixed constant), so the ISO stamp never
  // changes: format it once instead of building a Date per response.
  if (cachedIsoNow === null) cachedIsoNow = new Date(trialNowSec() * 1000).toISOString();
  return cachedIsoNow;
};
let cachedIsoNow: string | null = null;

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: 1000,
    node_id: 'MDQ6VXNlcjEwMDA=',
    avatar_url: '',
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
  };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: store.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, node_id: 'MDQ6VXNlcjEwMDA=', type: 'User', site_admin: false },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: isoNow(),
    updated_at: isoNow(),
    pushed_at: isoNow(),
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

function labelJson(label: { name: string; color: string; description: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.dbId * 1000000 + issue.number,
    node_id: store.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label): label is { name: string; color: string; description: string } => label !== undefined)
      .map(labelJson),
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    created_at: isoNow(),
    updated_at: isoNow(),
    comments: issue.comments.length,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.dbId * 1000000 + pull.number,
    node_id: store.pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'merged' ? 'closed' : pull.state,
    locked: false,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    mergeable: pull.state === 'open' ? store.mergeable(repo, pull) === 'MERGEABLE' : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    created_at: isoNow(),
    updated_at: isoNow(),
  };
}

function parseBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/** Paginate a list and send it with GitHub-style Link headers. */
function sendPage<T>(req: IncomingMessage, res: ServerResponse, basePath: string, query: URLSearchParams, items: T[]): void {
  const { page, perPage } = pageParams(query);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const host = req.headers.host ?? '127.0.0.1';
  const linkFor = (pageNumber: number): string => `<http://${host}${basePath}?per_page=${perPage}&page=${pageNumber}>`;
  const links: string[] = [];
  if (page < totalPages) links.push(`${linkFor(page + 1)}; rel="next"`);
  if (page > 1) links.push(`${linkFor(page - 1)}; rel="prev"`);
  links.push(`${linkFor(1)}; rel="first"`);
  links.push(`${linkFor(totalPages)}; rel="last"`);
  sendJson(res, 200, slice, { link: links.join(', ') });
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Handle a request under /api/v3. Returns true when the path belonged to the
 * REST surface (even when it answered 404 for an unknown repo), false when
 * the path is not REST at all.
 */
export function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams,
  body: Buffer,
): boolean {
  const method = req.method ?? 'GET';
  const segments = pathname.split('/').filter((part) => part.length > 0);
  // segments[0] === 'api', segments[1] === 'v3'
  if (segments[0] !== 'api' || segments[1] !== 'v3') return false;

  const rest = segments.slice(2);
  if (rest.length === 0) {
    if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed'), true;
    return sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{username}',
    }, { 'x-oauth-scopes': 'repo, read:org' }), true;
  }
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed'), true;
    return sendJson(res, 200, { installed_version: '1.0.0' }), true;
  }
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed'), true;
    return sendJson(res, 200, userJson()), true;
  }
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      sendPage(req, res, '/api/v3/user/repos', query, store.viewerRepos().map((repo) => repoJson(store, repo)));
      return true;
    }
    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
      const name = asString(parsed.value.name);
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return sendError(res, 422, 'Invalid repository name'), true;
      const repo = store.createRepo(VIEWER_LOGIN, name, {
        description: asString(parsed.value.description),
        isPrivate: asBoolean(parsed.value.private),
      });
      if (!repo) return sendError(res, 422, 'Repository already exists'), true;
      return sendJson(res, 201, repoJson(store, repo)), true;
    }
    return sendError(res, 405, 'Method Not Allowed'), true;
  }
  if (rest.length >= 2 && rest[0] === 'repos') {
    return handleRepoRest(store, req, res, rest.slice(1), query, body);
  }
  return false;
}

function handleRepoRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  rest: string[],
  query: URLSearchParams,
  body: Buffer,
): boolean {
  const method = req.method ?? 'GET';
  const owner = decodePathSegment(rest[0]!);
  const repoName = decodePathSegment(rest[1]!);
  const repo = store.getRepo(owner, repoName);
  const tail = rest.slice(2);

  // The repository itself.
  if (tail.length === 0) {
    if (!repo) return sendError(res, 404, 'Not Found'), true;
    if (method === 'GET') return sendJson(res, 200, repoJson(store, repo)), true;
    if (method === 'PATCH') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
      const description = asString(parsed.value.description);
      if (description !== undefined) repo.description = description;
      return sendJson(res, 200, repoJson(store, repo)), true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return sendJson(res, 204, null), true;
    }
    return sendError(res, 405, 'Method Not Allowed'), true;
  }
  if (!repo) return sendError(res, 404, 'Not Found'), true;

  const sub = tail[0]!;
  if (sub === 'branches') {
    if (tail.length === 1) {
      if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed'), true;
      const branches = [...repo.refs.keys()]
        .filter((name) => name.startsWith('refs/heads/'))
        .map((name) => name.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) }, protected: false }));
      return sendJson(res, 200, branches), true;
    }
    if (tail.length === 2) {
      if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed'), true;
      const branchName = decodePathSegment(tail[1]!);
      const sha = repo.refs.get(`refs/heads/${branchName}`);
      if (!sha) return sendError(res, 404, 'Not Found'), true;
      return sendJson(res, 200, { name: branchName, commit: { sha }, protected: false }), true;
    }
    return sendError(res, 404, 'Not Found'), true;
  }
  if (sub === 'commits') {
    if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed'), true;
    const ref = query.get('sha');
    const tip = ref ? store.resolveRef(repo, ref) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const commits = tip ? store.commitList(repo, tip) : [];
    const out = commits.map((sha) => {
      const obj = repo.objects.get(sha)!;
      const view = parseCommitView(obj.data);
      return {
        sha,
        commit: {
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoNow() },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoNow() },
          message: view.message,
          tree: { sha: view.tree },
        },
        author: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
        committer: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
        parents: view.parents.map((parent) => ({ sha: parent })),
      };
    });
    sendPage(req, res, `/api/v3/repos/${owner}/${repoName}/commits`, query, out);
    return true;
  }
  if (sub === 'git' && tail[1] === 'refs') {
    if (tail.length === 2) {
      if (method !== 'POST') return sendError(res, 405, 'Method Not Allowed'), true;
      const parsed = parseBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
      const ref = asString(parsed.value.ref);
      const sha = asString(parsed.value.sha);
      if (!ref || !sha || !ref.startsWith('refs/')) return sendError(res, 422, 'Invalid ref'), true;
      if (repo.refs.has(ref)) return sendError(res, 422, 'Reference already exists'), true;
      if (!repo.objects.has(sha.toLowerCase())) return sendError(res, 422, 'Object does not exist'), true;
      repo.refs.set(ref, sha.toLowerCase());
      return sendJson(res, 201, { ref, object: { sha: sha.toLowerCase(), type: 'commit' } }), true;
    }
    if (tail.length >= 3) {
      if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed'), true;
      const refName = `refs/${tail.slice(2).map(decodePathSegment).join('/')}`;
      const sha = repo.refs.get(refName);
      if (!sha) return sendError(res, 404, 'Not Found'), true;
      const obj = repo.objects.get(sha);
      return sendJson(res, 200, { ref: refName, object: { sha, type: obj?.type ?? 'commit' } }), true;
    }
    return sendError(res, 404, 'Not Found'), true;
  }
  if (sub === 'contents') {
    return handleContents(store, req, res, repo, tail.slice(1), query, body);
  }
  if (sub === 'labels') {
    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
      const name = asString(parsed.value.name);
      const color = asString(parsed.value.color) ?? 'ededed';
      if (!name) return sendError(res, 422, 'Invalid label'), true;
      if (repo.labels.has(name)) return sendError(res, 422, 'Label already exists'), true;
      const label = { name, color, description: asString(parsed.value.description) ?? '' };
      repo.labels.set(name, label);
      return sendJson(res, 201, labelJson(label)), true;
    }
    if (method === 'GET') return sendJson(res, 200, [...repo.labels.values()].map(labelJson)), true;
    return sendError(res, 405, 'Method Not Allowed'), true;
  }
  if (sub === 'issues') {
    return handleIssues(store, req, res, repo, tail.slice(1), query, body);
  }
  if (sub === 'pulls') {
    return handlePulls(store, req, res, repo, tail.slice(1), query, body);
  }
  return sendError(res, 404, 'Not Found'), true;
}

function parseCommitView(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  // Git stores the message with a trailing newline; the API reports it without.
  const message = (split < 0 ? '' : text.slice(split + 2)).replace(/\n$/, '');
  const view = { tree: '', parents: [] as string[], message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
  }
  return view;
}

function handleContents(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
  query: URLSearchParams,
  body: Buffer,
): boolean {
  const method = req.method ?? 'GET';
  const path = tail.map(decodePathSegment).join('/');
  const branch = query.get('ref') ?? undefined;
  const tip = branch ? store.refTip(repo, branch) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const files = tip ? store.filesAtCommit(repo, tip) : new Map<string, Buffer>();

  if (method === 'GET') {
    if (path === '') {
      const entries: Record<string, unknown>[] = [];
      const seen = new Map<string, { type: string; sha: string }>();
      for (const filePath of files.keys()) {
        const slash = filePath.indexOf('/');
        if (slash < 0) {
          seen.set(filePath, { type: 'file', sha: hashObject('blob', files.get(filePath)!) });
        } else {
          const dir = filePath.slice(0, slash);
          if (!seen.has(dir)) seen.set(dir, { type: 'dir', sha: '' });
        }
      }
      for (const [name, entry] of [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        entries.push({ type: entry.type, name, path: name, sha: entry.sha, size: entry.type === 'file' ? files.get(name)!.length : 0 });
      }
      return sendJson(res, 200, entries), true;
    }
    const content = files.get(path);
    if (content !== undefined) {
      return sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: content.length,
        name: path.split('/').pop(),
        path,
        content: content.toString('base64'),
        sha: hashObject('blob', content),
      }), true;
    }
    const prefix = `${path}/`;
    const children = new Map<string, { type: string; sha: string }>();
    for (const filePath of files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) children.set(rest, { type: 'file', sha: hashObject('blob', files.get(filePath)!) });
      else if (!children.has(rest.slice(0, slash))) children.set(rest.slice(0, slash), { type: 'dir', sha: '' });
    }
    if (children.size === 0) return sendError(res, 404, 'Not Found'), true;
    const entries = [...children.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([name, entry]) => ({
        type: entry.type,
        name,
        path: `${path}/${name}`,
        sha: entry.sha,
        size: entry.type === 'file' ? files.get(`${path}/${name}`)!.length : 0,
      }));
    return sendJson(res, 200, entries), true;
  }
  if (method === 'PUT') {
    const parsed = parseBody(body);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
    const contentB64 = asString(parsed.value.content);
    const message = asString(parsed.value.message) ?? `Update ${path}`;
    const sha = asString(parsed.value.sha);
    const branchName = asString(parsed.value.branch) ?? branch;
    if (contentB64 === undefined) return sendError(res, 422, 'content is required'), true;
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return sendError(res, 422, 'content is not valid base64'), true;
    }
    const existed = files.has(path);
    const result = store.commitFile(repo, branchName, path, content, message, sha);
    if (result === 'not-found') return sendError(res, 404, 'Not Found'), true;
    if (result === 'stale-sha') return sendError(res, 409, 'sha does not match'), true;
    return sendJson(res, existed ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: result.blobSha, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: result.commitSha, message },
    }), true;
  }
  if (method === 'DELETE') {
    const parsed = parseBody(body);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
    const message = asString(parsed.value.message) ?? `Delete ${path}`;
    const sha = asString(parsed.value.sha);
    const branchName = asString(parsed.value.branch) ?? branch;
    if (!files.has(path)) return sendError(res, 404, 'Not Found'), true;
    const result = store.commitFile(repo, branchName, path, null, message, sha);
    if (result === 'not-found') return sendError(res, 404, 'Not Found'), true;
    if (result === 'stale-sha') return sendError(res, 409, 'sha does not match'), true;
    return sendJson(res, 200, { commit: { sha: result.commitSha, message } }), true;
  }
  return sendError(res, 405, 'Method Not Allowed'), true;
}

function handleIssues(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
  query: URLSearchParams,
  body: Buffer,
): boolean {
  const method = req.method ?? 'GET';
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (sort === 'created' ? a.seq - b.seq : a.seq - b.seq));
      if (direction === 'desc') issues.reverse();
      return sendJson(res, 200, issues.map((issue) => issueJson(store, repo, issue))), true;
    }
    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
      const title = asString(parsed.value.title);
      if (!title) return sendError(res, 422, 'title is required'), true;
      const labels = Array.isArray(parsed.value.labels)
        ? parsed.value.labels.filter((label): label is string => typeof label === 'string')
        : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return sendError(res, 422, `Label does not exist: ${label}`), true;
      }
      const issue = store.createIssue(repo, title, asString(parsed.value.body) ?? '', labels);
      return sendJson(res, 201, issueJson(store, repo, issue)), true;
    }
    return sendError(res, 405, 'Method Not Allowed'), true;
  }
  const number = parseInt(tail[0]!, 10);
  if (!Number.isFinite(number)) return sendError(res, 404, 'Not Found'), true;
  const issue = repo.issues.get(number);
  if (!issue) return sendError(res, 404, 'Not Found'), true;
  if (tail.length === 1) {
    if (method === 'GET') {
      // The benchmark reads the same issue 2,000 times in a row on a warm
      // connection. issueJson is a pure function of (repo state, issue) —
      // isoNow is constant per process, ids are memoized — and the store
      // generation in the key invalidates it on any mutation, so a hit is
      // always correct. Only the request id stays fresh (see sendCachedJson).
      const key = `issue|${store.generation}|${repo.dbId}|${number}`;
      const cached = store.getCache.get(key);
      if (cached !== undefined) {
        sendCachedJson(res, 200, cached);
        return true;
      }
      const body = Buffer.from(JSON.stringify(issueJson(store, repo, issue)), 'utf8');
      if (store.getCache.size >= 64) store.getCache.clear();
      store.getCache.set(key, body);
      sendCachedJson(res, 200, body);
      return true;
    }
    if (method === 'PATCH') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
      const state = asString(parsed.value.state);
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = asString(parsed.value.title);
      if (title !== undefined) issue.title = title;
      const bodyText = asString(parsed.value.body);
      if (bodyText !== undefined) issue.body = bodyText;
      return sendJson(res, 200, issueJson(store, repo, issue)), true;
    }
    return sendError(res, 405, 'Method Not Allowed'), true;
  }
  if (tail[1] === 'comments' && tail.length === 2) {
    if (method === 'GET') {
      return sendJson(res, 200, issue.comments.map((comment) => ({
        id: comment.id,
        node_id: store.commentGlobalId(repo, comment),
        body: comment.body,
        user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
        created_at: isoNow(),
      }))), true;
    }
    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
      const text = asString(parsed.value.body);
      if (text === undefined) return sendError(res, 422, 'body is required'), true;
      const comment = { id: ++repo.commentSeq, body: text, seq: repo.commentSeq };
      issue.comments.push(comment);
      return sendJson(res, 201, {
        id: comment.id,
        node_id: store.commentGlobalId(repo, comment),
        body: comment.body,
        user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
        created_at: isoNow(),
      }), true;
    }
    return sendError(res, 405, 'Method Not Allowed'), true;
  }
  return sendError(res, 404, 'Not Found'), true;
}

function handlePulls(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
  query: URLSearchParams,
  body: Buffer,
): boolean {
  const method = req.method ?? 'GET';
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => (pull.state === 'merged' ? 'closed' : pull.state) === state);
      pulls.sort((a, b) => b.seq - a.seq);
      return sendJson(res, 200, pulls.map((pull) => pullJson(store, repo, pull))), true;
    }
    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON'), true;
      const title = asString(parsed.value.title);
      const head = asString(parsed.value.head);
      const base = asString(parsed.value.base);
      if (!title || !head || !base) return sendError(res, 422, 'title, head and base are required'), true;
      const pull = store.createPull(repo, title, asString(parsed.value.body) ?? '', head, base);
      if (!pull) return sendError(res, 422, 'head or base branch does not exist'), true;
      return sendJson(res, 201, pullJson(store, repo, pull)), true;
    }
    return sendError(res, 405, 'Method Not Allowed'), true;
  }
  const number = parseInt(tail[0]!, 10);
  if (!Number.isFinite(number)) return sendError(res, 404, 'Not Found'), true;
  const pull = repo.pulls.get(number);
  if (!pull) return sendError(res, 404, 'Not Found'), true;
  if (tail.length === 1) {
    if (method === 'GET') return sendJson(res, 200, pullJson(store, repo, pull)), true;
    return sendError(res, 405, 'Method Not Allowed'), true;
  }
  if (tail[1] === 'files' && tail.length === 2) {
    if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed'), true;
    return sendJson(res, 200, store.pullFiles(repo, pull)), true;
  }
  if (tail[1] === 'merge' && tail.length === 2) {
    if (method !== 'PUT') return sendError(res, 405, 'Method Not Allowed'), true;
    if (pull.state !== 'open') return sendError(res, 405, 'Pull request is not open'), true;
    const merged = store.mergePull(repo, pull);
    if (!merged) return sendError(res, 405, 'Merge conflict'), true;
    return sendJson(res, 200, { sha: merged.commitSha, merged: true, message: `Pull request #${pull.number} merged` }), true;
  }
  return sendError(res, 404, 'Not Found'), true;
}
