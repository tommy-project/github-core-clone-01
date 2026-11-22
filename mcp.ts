// MCP over streamable HTTP (plain JSON answers, no SSE): the modern
// `server/discover` handshake, the legacy `initialize` fallback, `tools/list`
// and `tools/call` for the six repository tools the agent-native arm needs.
// Stateless: every request carries its own JSON-RPC id back, and two
// concurrent calls never share state.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError } from './http-util.ts';
import { VIEWER_LOGIN, type Store, type Repo } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

function repoObject(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: store.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
  };
}

function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolFail(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** Run one tool; returns the tool result object (never throws for bad input). */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOL_MAP.get(name);
  if (!tool) return toolFail(`Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolFail(`Missing required argument: ${required}`);
    }
  }
  const owner = asString(args.owner);
  const repoName = asString(args.repo);
  if (name === 'create_repo') {
    const repoTitle = asString(args.name);
    if (!repoTitle) return toolFail('Missing required argument: name');
    const repo = store.createRepo(VIEWER_LOGIN, repoTitle, {
      description: asString(args.description),
      isPrivate: typeof args.private === 'boolean' ? args.private : undefined,
    });
    if (!repo) return toolFail(`Repository already exists: ${repoTitle}`);
    return toolOk(repoObject(store, repo));
  }
  if (owner === undefined || repoName === undefined) return toolFail('Missing required argument: owner or repo');
  const repo = store.getRepo(owner, repoName);
  if (!repo) return toolFail(`Repository not found: ${owner}/${repoName}`);
  if (name === 'get_repo') return toolOk(repoObject(store, repo));
  if (name === 'create_issue') {
    const title = asString(args.title);
    if (!title) return toolFail('Missing required argument: title');
    const issue = store.createIssue(repo, title, asString(args.body) ?? '', []);
    return toolOk({
      id: repo.dbId * 1000000 + issue.number,
      node_id: store.issueGlobalId(repo, issue),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: [],
      user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    });
  }
  if (name === 'list_issues') {
    const state = asString(args.state) ?? 'open';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    issues.sort((a, b) => b.seq - a.seq);
    return toolOk({
      issues: issues.map((issue) => ({
        id: repo.dbId * 1000000 + issue.number,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
      })),
    });
  }
  if (name === 'create_pull_request') {
    const title = asString(args.title);
    const head = asString(args.head);
    const base = asString(args.base);
    if (!title || !head || !base) return toolFail('Missing required argument: title, head or base');
    const pull = store.createPull(repo, title, asString(args.body) ?? '', head, base);
    if (!pull) return toolFail(`head or base branch does not exist: ${head} -> ${base}`);
    return toolOk({
      id: repo.dbId * 1000000 + pull.number,
      node_id: store.pullGlobalId(repo, pull),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: 'open',
      head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
      base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
      merged: false,
    });
  }
  if (name === 'merge_pull_request') {
    const number = asNumber(args.pull_number);
    if (number === undefined) return toolFail('Missing required argument: pull_number');
    const pull = repo.pulls.get(number);
    if (!pull) return toolFail(`Pull request not found: #${number}`);
    if (pull.state !== 'open') return toolFail(`Pull request #${number} is not open`);
    const merged = store.mergePull(repo, pull);
    if (!merged) return toolFail(`Pull request #${number} has merge conflicts`);
    return toolOk({
      id: repo.dbId * 1000000 + pull.number,
      number: pull.number,
      title: pull.title,
      state: 'closed',
      merged: true,
      merge_commit_sha: merged.commitSha,
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
    });
  }
  return toolFail(`Unknown tool: ${name}`);
}

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(res: ServerResponse, id: string | number | null, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(res: ServerResponse, id: string | number | null, code: number, message: string): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * Handle one POST /mcp request. Returns true when the path belonged to the
 * MCP surface. A body that is not JSON is HTTP 400 with -32700; a request
 * with no id is a notification and gets an empty 202.
 */
export function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse, body: Buffer): boolean {
  if (req.method === 'DELETE') {
    sendJson(res, 204, null);
    return true;
  }
  if (req.method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const request = parsed as RpcRequest;
  const id = request.id ?? null;
  const hasId = request.id !== undefined;
  if (!hasId) {
    // A notification (for example notifications/initialized): acknowledge, no answer.
    sendJson(res, 202, null);
    return true;
  }
  const method = request.method ?? '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  if (method === 'server/discover') {
    rpcResult(res, id, {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return true;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const chosen = requested !== null && SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    rpcResult(res, id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }
  if (method === 'tools/list') {
    rpcResult(res, id, { tools: TOOLS });
    return true;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!TOOL_MAP.has(toolName)) {
      rpcError(res, id, -32602, `Unknown tool: ${toolName}`);
      return true;
    }
    rpcResult(res, id, callTool(store, toolName, args));
    return true;
  }
  if (method === 'ping') {
    rpcResult(res, id, {});
    return true;
  }
  rpcError(res, id, -32601, `Method not found: ${method}`);
  return true;
}
