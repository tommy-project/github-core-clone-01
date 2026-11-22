// A small GraphQL executor for exactly the documents gh and github-mcp-server
// send: viewer/repository/node/__type reads, the issue and pull request
// connections with cursor pagination, and the five mutations. It is a real
// parser and executor (not a document matcher): it tokenizes the query,
// resolves variables, validates fields against the schema it advertises, and
// answers unknown fields with a 200 + errors array, as GitHub does.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError } from './http-util.ts';
import {
  VIEWER_LOGIN,
  VIEWER_NAME,
  VIEWER_EMAIL,
  parseGlobalId,
  globalId,
  type Store,
  type Repo,
  type Issue,
  type Pull,
  type IssueComment,
} from './store.ts';

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string };

function tokenize(document: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (i < document.length) {
    const ch = document[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < document.length && document[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && document.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < document.length && document[j] !== '"') {
        if (document[j] === '\\' && j + 1 < document.length) {
          const escaped = document[j + 1]!;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          value += document[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (document[j] === '-') j += 1;
      while (j < document.length && /[0-9]/.test(document[j]!)) j += 1;
      if (document[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < document.length && /[0-9]/.test(document[j]!)) j += 1;
      }
      const text = document.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: parseFloat(text) } : { kind: 'int', value: parseInt(text, 10) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < document.length && isNameChar(document[j]!)) j += 1;
      tokens.push({ kind: 'name', value: document.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

export type GqlValue =
  | string
  | number
  | boolean
  | null
  | { __variable: string }
  | { __enum: string }
  | GqlValue[]
  | { [key: string]: GqlValue };

export interface FieldSelection {
  kind: 'field';
  name: string;
  alias: string;
  args: Record<string, GqlValue>;
  selections: Selection[];
}

export interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string | null;
  selections: Selection[];
}

export type Selection = FieldSelection | FragmentSelection;

export interface Operation {
  opType: 'query' | 'mutation';
  name: string | null;
  variableDefs: Record<string, { defaultValue?: GqlValue }>;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, saw ${token.kind} ${JSON.stringify((token as { value?: unknown }).value)}`);
  }

  private peekPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, saw ${token.kind}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ opType: 'query', name: null, variableDefs: {}, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        const maybeName = this.peek();
        if (maybeName?.kind === 'name') {
          name = this.next().value as string;
        }
        const variableDefs = this.peekPunct('(') ? this.parseVariableDefinitions() : {};
        operations.push({ opType: token.value as 'query' | 'mutation', name, variableDefs, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        // Named fragments are not used by the suite's documents; skip the definition.
        this.next();
        this.expectName();
        this.expectName();
        this.parseSelectionSet();
        continue;
      }
      throw new Error(`unexpected token ${token.kind} ${JSON.stringify((token as { value?: unknown }).value)}`);
    }
    return operations;
  }

  private parseVariableDefinitions(): Record<string, { defaultValue?: GqlValue }> {
    const defs: Record<string, { defaultValue?: GqlValue }> = {};
    this.expectPunct('(');
    while (!this.peekPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.peekPunct('=')) {
        this.next();
        defs[name] = { defaultValue: this.parseValue() };
      } else {
        defs[name] = {};
      }
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): void {
    if (this.peekPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peekPunct('!')) this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.peekPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peekPunct('...')) {
      this.next();
      let typeCondition: string | null = null;
      const token = this.peek();
      if (token?.kind === 'name' && token.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      // Directives, if any, are skipped.
      while (this.peekPunct('@')) {
        this.next();
        this.expectName();
        if (this.peekPunct('(')) this.parseArguments();
      }
      return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias = first;
    let name = first;
    if (this.peekPunct(':')) {
      this.next();
      name = this.expectName();
    }
    const args = this.peekPunct('(') ? this.parseArguments() : {};
    while (this.peekPunct('@')) {
      this.next();
      this.expectName();
      if (this.peekPunct('(')) this.parseArguments();
    }
    const selections = this.peekPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    this.expectPunct('(');
    while (!this.peekPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { __variable: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (!this.peekPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return values;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, GqlValue> = {};
      while (!this.peekPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        object[name] = this.parseValue();
      }
      this.expectPunct('}');
      return object;
    }
    if (token.kind === 'string' || token.kind === 'int' || token.kind === 'float') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    throw new Error(`unexpected value token ${token.kind}`);
  }
}

// ---------------------------------------------------------------------------
// schema: the fields each type answers (also what __type reports)
// ---------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'createdAt', 'updatedAt', 'url', 'isPrivate', 'fork',
  ],
  Ref: ['name', 'target'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'author', 'additions', 'deletions', 'changedFiles',
  ],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const SCHEMA_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

type View =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User' }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'IssueComment'; repo: Repo; comment: IssueComment }
  | { __typename: 'IssueConnection'; nodes: { repo: Repo; issue: Issue }[]; pageInfo: PageInfoValue; totalCount: number }
  | { __typename: 'PullRequestConnection'; nodes: { repo: Repo; pull: Pull }[]; pageInfo: PageInfoValue; totalCount: number }
  | { __typename: 'PullRequestFileConnection'; nodes: Record<string, unknown>[]; pageInfo: PageInfoValue; totalCount: number }
  | { __typename: 'CreateIssuePayload'; issue: { repo: Repo; issue: Issue } | null }
  | { __typename: 'CloseIssuePayload'; issue: { repo: Repo; issue: Issue } | null }
  | { __typename: 'CreatePullRequestPayload'; pullRequest: { repo: Repo; pull: Pull } | null }
  | { __typename: 'MergePullRequestPayload'; pullRequest: { repo: Repo; pull: Pull } | null }
  | { __typename: 'AddCommentPayload'; commentEdge: { node: { repo: Repo; comment: IssueComment } | null } | null }
  | { __typename: 'IssueCommentEdge'; node: { repo: Repo; comment: IssueComment } | null }
  | { __typename: '__Type'; name: string; kind: string };

interface PageInfoValue {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function resolveValue(value: GqlValue, ctx: ExecContext): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, ctx));
  if ('__variable' in value) {
    const name = (value as { __variable: string }).__variable;
    return ctx.variables[name] ?? null;
  }
  if ('__enum' in value) return (value as { __enum: string }).__enum;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = resolveValue(entry, ctx);
  return out;
}

function resolveArgs(args: Record<string, GqlValue>, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, ctx);
  return out;
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return -1;
    const index = parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(index) ? index : -1;
  } catch {
    return -1;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.state === 'open') return 'OPEN';
  if (pull.state === 'merged') return 'MERGED';
  return 'CLOSED';
}

function repoView(repo: Repo): View {
  return { __typename: 'Repository', repo };
}

function issueView(repo: Repo, issue: Issue): View {
  return { __typename: 'Issue', repo, issue };
}

function pullView(repo: Repo, pull: Pull): View {
  return { __typename: 'PullRequest', repo, pull };
}

function findRepoByGlobalId(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  const dbId = parseInt(parsed.key, 10);
  if (!Number.isFinite(dbId)) return null;
  return store.findRepoByDbId(dbId) ?? null;
}

function findIssueByGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Issue') return null;
  const [dbIdText, numberText] = parsed.key.split(':');
  const dbId = parseInt(dbIdText ?? '', 10);
  const number = parseInt(numberText ?? '', 10);
  if (!Number.isFinite(dbId) || !Number.isFinite(number)) return null;
  const repo = store.findRepoByDbId(dbId);
  if (!repo) return null;
  const issue = repo.issues.get(number);
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'PullRequest') return null;
  const [dbIdText, numberText] = parsed.key.split(':');
  const dbId = parseInt(dbIdText ?? '', 10);
  const number = parseInt(numberText ?? '', 10);
  if (!Number.isFinite(dbId) || !Number.isFinite(number)) return null;
  const repo = store.findRepoByDbId(dbId);
  if (!repo) return null;
  const pull = repo.pulls.get(number);
  return pull ? { repo, pull } : null;
}

/** Resolve one field of an object view. Returns null for an unknown field (and records the error). */
function resolveField(ctx: ExecContext, view: View, field: string, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  switch (view.__typename) {
    case 'Query': {
      if (field === 'viewer') return { __typename: 'User' } as View;
      if (field === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoView(repo) : null;
      }
      if (field === 'node') {
        const parsed = typeof args.id === 'string' ? parseGlobalId(args.id) : null;
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const repo = store.findRepoByDbId(parseInt(parsed.key, 10));
          return repo ? repoView(repo) : null;
        }
        if (parsed.kind === 'Issue') {
          const found = findIssueByGlobalId(store, args.id);
          return found ? issueView(found.repo, found.issue) : null;
        }
        if (parsed.kind === 'PullRequest') {
          const found = findPullByGlobalId(store, args.id);
          return found ? pullView(found.repo, found.pull) : null;
        }
        return null;
      }
      if (field === '__type') {
        const name = String(args.name ?? '');
        if (SCHEMA_FIELDS[name]) return { __typename: '__Type', name, kind: 'OBJECT' } as View;
        if (SCHEMA_ENUM_VALUES[name]) return { __typename: '__Type', name, kind: 'ENUM' } as View;
        return null;
      }
      if (field === '__schema') return null;
      break;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(store, input.repositoryId);
        if (!repo) return { __typename: 'CreateIssuePayload', issue: null } as View;
        const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return { __typename: 'CreateIssuePayload', issue: issueView(repo, issue) } as View;
      }
      if (field === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGlobalId(store, input.issueId);
        if (!found) return { __typename: 'CloseIssuePayload', issue: null } as View;
        found.issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: issueView(found.repo, found.issue) } as View;
      }
      if (field === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(store, input.repositoryId);
        if (!repo) return { __typename: 'CreatePullRequestPayload', pullRequest: null } as View;
        const pull = store.createPull(repo, String(input.title ?? ''), '', String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
        return { __typename: 'CreatePullRequestPayload', pullRequest: pull ? pullView(repo, pull) : null } as View;
      }
      if (field === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findPullByGlobalId(store, input.pullRequestId);
        if (!found || found.pull.state !== 'open') {
          return { __typename: 'MergePullRequestPayload', pullRequest: found ? pullView(found.repo, found.pull) : null } as View;
        }
        store.mergePull(found.repo, found.pull);
        return { __typename: 'MergePullRequestPayload', pullRequest: pullView(found.repo, found.pull) } as View;
      }
      if (field === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGlobalId(store, input.subjectId);
        if (!found) return { __typename: 'AddCommentPayload', commentEdge: null } as View;
        const comment: IssueComment = { id: ++found.repo.commentSeq, body: String(input.body ?? ''), seq: found.repo.commentSeq };
        found.issue.comments.push(comment);
        const node = { __typename: 'IssueComment', repo: found.repo, comment } as View;
        return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node } as View } as View;
      }
      break;
    }
    case 'User': {
      if (field === 'login') return VIEWER_LOGIN;
      if (field === 'name') return VIEWER_NAME;
      if (field === 'email') return VIEWER_EMAIL;
      if (field === 'id') return globalId('User', '1000');
      if (field === 'databaseId') return 1000;
      break;
    }
    case 'Repository': {
      const repo = view.repo;
      if (field === 'id') return store.repoGlobalId(repo);
      if (field === 'databaseId') return repo.dbId;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field === 'owner') return { __typename: 'User' } as View;
      if (field === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip ? ({ __typename: 'Ref', name: repo.defaultBranch } as View) : null;
      }
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'description') return repo.description;
      if (field === 'isPrivate') return repo.isPrivate;
      if (field === 'fork') return false;
      if (field === 'url') return `/${repo.owner}/${repo.name}`;
      if (field === 'createdAt' || field === 'updatedAt') return new Date(1735689600 * 1000).toISOString();
      if (field === 'issue') {
        const number = args.number as number | undefined;
        const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
        return issue ? issueView(repo, issue) : null;
      }
      if (field === 'issues') return issuesConnection(repo, args);
      if (field === 'pullRequest') {
        const number = args.number as number | undefined;
        const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
        return pull ? pullView(repo, pull) : null;
      }
      if (field === 'pullRequests') return pullsConnection(repo, args);
      break;
    }
    case 'Ref': {
      if (field === 'name') return view.name;
      if (field === 'target') return null;
      break;
    }
    case 'Issue': {
      const issue = view.issue;
      if (field === 'id') return store.issueGlobalId(view.repo, issue);
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'body') return issue.body;
      if (field === 'state') return issueState(issue);
      if (field === 'url') return `/${view.repo.owner}/${view.repo.name}/issues/${issue.number}`;
      if (field === 'createdAt' || field === 'updatedAt') return new Date(1735689600 * 1000).toISOString();
      if (field === 'author') return { __typename: 'User' } as View;
      if (field === 'labels') return [];
      if (field === 'comments') return [];
      break;
    }
    case 'PullRequest': {
      const pull = view.pull;
      if (field === 'id') return store.pullGlobalId(view.repo, pull);
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'body') return pull.body;
      if (field === 'state') return pullState(pull);
      if (field === 'merged') return pull.merged;
      if (field === 'mergeable') return pull.state === 'open' ? store.mergeable(view.repo, pull) : 'UNKNOWN';
      if (field === 'headRefName') return pull.headRef;
      if (field === 'baseRefName') return pull.baseRef;
      if (field === 'headRef') return { __typename: 'Ref', name: pull.headRef } as View;
      if (field === 'baseRef') return { __typename: 'Ref', name: pull.baseRef } as View;
      if (field === 'createdAt' || field === 'updatedAt') return new Date(1735689600 * 1000).toISOString();
      if (field === 'author') return { __typename: 'User' } as View;
      if (field === 'files') {
        const files = store.pullFiles(view.repo, pull);
        const first = typeof args.first === 'number' ? args.first : files.length;
        const nodes = files.slice(0, first).map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions, changes: file.changes, status: file.status }));
        return {
          __typename: 'PullRequestFileConnection',
          nodes,
          pageInfo: { hasNextPage: files.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: files.length,
        } as View;
      }
      if (field === 'additions' || field === 'deletions' || field === 'changedFiles') {
        const files = store.pullFiles(view.repo, pull);
        if (field === 'additions') return files.reduce((sum, file) => sum + file.additions, 0);
        if (field === 'deletions') return files.reduce((sum, file) => sum + file.deletions, 0);
        return files.length;
      }
      break;
    }
    case 'IssueComment': {
      const comment = view.comment;
      if (field === 'id') return store.commentGlobalId(view.repo, comment);
      if (field === 'body') return comment.body;
      if (field === 'author') return { __typename: 'User' } as View;
      if (field === 'createdAt') return new Date(1735689600 * 1000).toISOString();
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection': {
      if (field === 'nodes') return view.nodes;
      if (field === 'edges') return (view.nodes as unknown[]).map((node) => ({ node, cursor: '' }));
      if (field === 'pageInfo') return view.pageInfo;
      if (field === 'totalCount') return view.totalCount;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field === 'issue') return view.issue;
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return view.pullRequest;
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return view.commentEdge;
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'IssueCommentEdge': {
      if (field === 'node') return view.node;
      if (field === 'cursor') return '';
      break;
    }
    case '__Type': {
      if (field === 'name') return view.name;
      if (field === 'kind') return view.kind;
      if (field === 'fields') {
        const names = SCHEMA_FIELDS[view.name] ?? [];
        return names.map((name) => ({ name, description: null }));
      }
      if (field === 'enumValues') {
        const names = SCHEMA_ENUM_VALUES[view.name] ?? [];
        return names.map((name) => ({ name, description: null }));
      }
      break;
    }
  }
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${view.__typename}".` });
  return null;
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): View {
  let issues = [...repo.issues.values()];
  const states = args.states as unknown[] | undefined;
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((state) => String(state)));
    issues = issues.filter((issue) => wanted.has(issueState(issue)));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  if (orderBy && String(orderBy.field ?? '') === 'CREATED_AT') {
    issues.sort((a, b) => (String(orderBy.direction ?? 'ASC') === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  } else {
    issues.sort((a, b) => a.seq - b.seq);
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const afterIndex = decodeCursor(args.after);
  const start = afterIndex + 1;
  const slice = issues.slice(start, start + first);
  const endIndex = start + slice.length - 1;
  const pageInfo: PageInfoValue = {
    hasNextPage: start + slice.length < issues.length,
    hasPreviousPage: start > 0,
    startCursor: slice.length ? encodeCursor(start) : null,
    endCursor: slice.length ? encodeCursor(endIndex) : null,
  };
  return {
    __typename: 'IssueConnection',
    nodes: slice.map((issue) => issueView(repo, issue)),
    pageInfo,
    totalCount: issues.length,
  } as View;
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): View {
  let pulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open');
  pulls.sort((a, b) => b.seq - a.seq);
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const afterIndex = decodeCursor(args.after);
  const start = afterIndex + 1;
  const slice = pulls.slice(start, start + first);
  const endIndex = start + slice.length - 1;
  const pageInfo: PageInfoValue = {
    hasNextPage: start + slice.length < pulls.length,
    hasPreviousPage: start > 0,
    startCursor: slice.length ? encodeCursor(start) : null,
    endCursor: slice.length ? encodeCursor(endIndex) : null,
  };
  return {
    __typename: 'PullRequestConnection',
    nodes: slice.map((pull) => pullView(repo, pull)),
    pageInfo,
    totalCount: pulls.length,
  } as View;
}

/** Project a selection set onto a resolved value, returning the response object. */
function project(ctx: ExecContext, value: unknown, typeName: string, selections: Selection[]): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return value;
  const view = value as View & Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      const nested = project(ctx, value, typeName, selection.selections);
      if (nested !== null && typeof nested === 'object') Object.assign(out, nested);
      continue;
    }
    if (selection.name === '__typename') {
      out[selection.alias] = typeName;
      continue;
    }
    const allowed = SCHEMA_FIELDS[typeName] ?? [];
    if (!allowed.includes(selection.name)) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[selection.alias] = null;
      continue;
    }
    const args = resolveArgs(selection.args, ctx);
    const resolved = resolveField(ctx, view, selection.name, args);
    out[selection.alias] = projectSelection(ctx, resolved, selection.selections);
  }
  return out;
}

/** Project a resolved field value: scalars pass through, objects recurse, lists map. */
function projectSelection(ctx: ExecContext, resolved: unknown, selections: Selection[]): unknown {
  if (resolved === null || resolved === undefined) return null;
  if (Array.isArray(resolved)) {
    return resolved.map((entry) => projectSelection(ctx, entry, selections));
  }
  if (typeof resolved === 'object') {
    const view = resolved as View & Record<string, unknown>;
    if (typeof view.__typename === 'string') {
      if (selections.length === 0) return resolved;
      return project(ctx, resolved, view.__typename, selections);
    }
    // Plain objects (pageInfo, __Field entries): project their keys directly.
    if (selections.length === 0) return resolved;
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragment') continue;
      if (selection.name === '__typename') {
        out[selection.alias] = null;
        continue;
      }
      out[selection.alias] = projectSelection(ctx, (resolved as Record<string, unknown>)[selection.name] ?? null, selection.selections);
    }
    return out;
  }
  return resolved;
}

function executeOperation(store: Store, operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: { message: string }[] } {
  const ctx: ExecContext = { store, variables, errors: [] };
  for (const [name, def] of Object.entries(operation.variableDefs)) {
    if (ctx.variables[name] === undefined && def.defaultValue !== undefined) {
      ctx.variables[name] = resolveValue(def.defaultValue, ctx);
    }
  }
  const root: View = operation.opType === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = project(ctx, root, root.__typename, operation.selections) as Record<string, unknown>;
  return { data: data ?? {}, errors: ctx.errors };
}

export function executeGraphQL(store: Store, document: string, variables: Record<string, unknown>, operationName?: string): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(document)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL syntax error' }] };
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'No operations in document' }] };
  let operation = operations[0]!;
  if (operationName) {
    const named = operations.find((entry) => entry.name === operationName);
    if (named) operation = named;
  }
  return executeOperation(store, operation, { ...variables });
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export function handleGraphQL(store: Store, req: IncomingMessage, res: ServerResponse, body: Buffer): boolean {
  if (req.method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendError(res, 400, 'Problems parsing JSON');
    return true;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'Expected a GraphQL operation object' }] };
    }
    const query = (entry as Record<string, unknown>).query;
    const variables = (entry as Record<string, unknown>).variables;
    const operationName = (entry as Record<string, unknown>).operationName;
    if (typeof query !== 'string') return { data: null, errors: [{ message: 'Expected a query string' }] };
    const result = executeGraphQL(store, query, (variables ?? {}) as Record<string, unknown>, typeof operationName === 'string' ? operationName : undefined);
    const out: Record<string, unknown> = { data: result.data };
    if (result.errors.length) out.errors = result.errors;
    return out;
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return true;
  }
  sendJson(res, 200, runOne(parsed));
  return true;
}
