// The forge's in-memory store: git objects, refs, repositories, issues and pull
// requests. Everything lives in process memory; a trial starts from an empty
// forge and the suite builds what it needs through the API.
//
// Determinism: no wall clock and no unseeded randomness anywhere in here.
// Commit timestamps come from MAKEFUN_TRIAL_NOW (the trial's fixed "now"),
// falling back to a constant, so a live run and its replay build identical
// objects. Ordering uses insertion sequence numbers, never a clock.

import { createHash } from 'node:crypto';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

/** The login the trial's bearer token names (the kit's published scenario). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

/** Seconds since the epoch the forge stamps on objects it creates itself. */
export function trialNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return 1735689600; // 2025-01-01T00:00:00Z
}

/** An identity line as git writes it: "Name <email> <ts> +0000". */
export function identityLine(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${trialNowSec()} +0000`;
}

// ---------------------------------------------------------------------------
// git object ids and parsing
// ---------------------------------------------------------------------------

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries ordered by name, directories as if named "name/". */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

export function buildCommitData(fields: { tree: string; parents: string[]; message: string }): Buffer {
  const stamp = identityLine();
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${stamp}`);
  lines.push(`committer ${stamp}`);
  const msg = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

/** Opaque Relay-style global ids: base64 of a typed key, never the raw number. */
const globalIdCache = new Map<string, string>();
export function globalId(kind: string, key: string): string {
  const cacheKey = `${kind}:${key}`;
  const cached = globalIdCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const id = Buffer.from(cacheKey, 'utf8').toString('base64');
  globalIdCache.set(cacheKey, id);
  return id;
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// repository model
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: IssueComment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Repo {
  dbId: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** One counter for issues and pull requests together, as GitHub numbers them. */
  numberSeq: number;
  commentSeq: number;
  createdSeq: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private dbSeq = 1;
  private repoSeq = 1;
  /**
   * Bumped by the HTTP layer on every mutating (non-GET/HEAD) request. Caches
   * key their entries by this, so any mutation invalidates them. Git objects
   * are content-addressed and immutable, so a cache hit under the same
   * generation is always correct.
   */
  generation = 0;
  /** Memoized upload-pack fetch responses, keyed by (generation, repo, args). */
  fetchCache = new Map<string, Buffer>();
  /** Memoized GET response bodies, keyed by (generation, endpoint, id). */
  getCache = new Map<string, Buffer>();

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  createRepo(owner: string, name: string, opts: { description?: string; isPrivate?: boolean }): Repo | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      dbId: this.dbSeq++,
      name,
      owner,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      numberSeq: 0,
      commentSeq: 0,
      createdSeq: this.repoSeq++,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Every repository the viewer owns, in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === VIEWER_LOGIN)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  repoGlobalId(repo: Repo): string {
    return globalId('Repository', String(repo.dbId));
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return globalId('Issue', `${repo.dbId}:${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return globalId('PullRequest', `${repo.dbId}:${pull.number}`);
  }

  commentGlobalId(repo: Repo, comment: IssueComment): string {
    return globalId('IssueComment', `${repo.dbId}:${comment.id}`);
  }

  findRepoByDbId(dbId: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.dbId === dbId) return repo;
    return undefined;
  }

  // -------------------------------------------------------------------------
  // git object store (per repository)
  // -------------------------------------------------------------------------

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  putBlob(repo: Repo, content: Buffer): string {
    return this.putObject(repo, 'blob', content);
  }

  /** Build (and store) the tree for a path -> content map; returns the root oid. */
  treeFromFiles(repo: Repo, files: Map<string, Buffer>): string {
    // Group files by their first path segment, recursively.
    const build = (paths: Map<string, Buffer>): string => {
      const direct = new Map<string, Buffer>();
      const grouped = new Map<string, Map<string, Buffer>>();
      for (const [path, content] of paths) {
        const slash = path.indexOf('/');
        if (slash < 0) direct.set(path, content);
        else {
          const head = path.slice(0, slash);
          const rest = path.slice(slash + 1);
          let sub = grouped.get(head);
          if (!sub) {
            sub = new Map();
            grouped.set(head, sub);
          }
          sub.set(rest, content);
        }
      }
      const entries: TreeEntry[] = [];
      for (const [name, content] of direct) {
        entries.push({ mode: '100644', name, oid: this.putBlob(repo, content) });
      }
      for (const [name, sub] of grouped) {
        entries.push({ mode: '40000', name, oid: build(sub) });
      }
      return this.putObject(repo, 'tree', buildTreeData(entries));
    };
    return build(files);
  }

  /** The path -> content map of a tree, walking nested directories. */
  filesFromTree(repo: Repo, treeOid: string): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else {
          const blob = repo.objects.get(entry.oid);
          if (blob) out.set(path, blob.data);
        }
      }
    };
    walk(treeOid, '');
    return out;
  }

  filesAtCommit(repo: Repo, commitOid: string): Map<string, Buffer> {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return new Map();
    return this.filesFromTree(repo, parseCommit(obj.data).tree);
  }

  createCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    return this.putObject(repo, 'commit', buildCommitData({ tree: treeOid, parents, message }));
  }

  /** All objects reachable from the tips, following commits, trees and tags. */
  reachable(repo: Repo, tips: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const view = parseCommit(obj.data);
        stack.push(view.tree);
        for (const parent of view.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return seen;
  }

  /** True when `ancestor` is reachable from `tip` (or equal to it). */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const stack = [tip];
    const seen = new Set<string>();
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** The newest-first list of commits reachable from a tip (parents after children). */
  commitList(repo: Repo, tip: string | undefined): string[] {
    if (!tip) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      const parents = parseCommit(obj.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
    }
    return out;
  }

  /** The best merge base of two tips on a linear history: the first common ancestor. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsOfB = new Set(this.commitList(repo, b));
    for (const oid of this.commitList(repo, a)) {
      if (ancestorsOfB.has(oid)) return oid;
    }
    return null;
  }

  /** Resolve a ref name or a raw oid to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (/^[0-9a-f]{40}$/i.test(ref)) return repo.objects.has(ref.toLowerCase()) ? ref.toLowerCase() : null;
    if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
    if (repo.refs.has(ref)) return repo.refs.get(ref)!;
    return null;
  }

  refTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  // -------------------------------------------------------------------------
  // contents commits
  // -------------------------------------------------------------------------

  /**
   * Commit one file change on a branch. Returns the commit and blob ids, or
   * an error string ('not-found' | 'stale-sha'). A missing branch means the
   * default branch of an unborn repository.
   */
  commitFile(
    repo: Repo,
    branch: string | undefined,
    path: string,
    content: Buffer | null,
    message: string,
    expectedSha?: string,
  ): { commitSha: string; blobSha: string } | string {
    const branchName = branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branchName}`;
    const tip = repo.refs.get(refName);
    if (branch !== undefined && tip === undefined && branch !== repo.defaultBranch) return 'not-found';
    const files = tip ? this.filesAtCommit(repo, tip) : new Map<string, Buffer>();
    if (expectedSha !== undefined) {
      const current = files.get(path);
      const currentSha = current ? hashObject('blob', current) : undefined;
      if (currentSha !== expectedSha.toLowerCase()) return 'stale-sha';
    }
    let blobSha = '';
    if (content === null) {
      files.delete(path);
    } else {
      blobSha = this.putBlob(repo, content);
      files.set(path, content);
    }
    const tree = this.treeFromFiles(repo, files);
    const parents = tip ? [tip] : [];
    const commitSha = this.createCommit(repo, tree, parents, message);
    repo.refs.set(refName, commitSha);
    return { commitSha, blobSha };
  }

  // -------------------------------------------------------------------------
  // issues and pull requests
  // -------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = ++repo.numberSeq;
    const issue: Issue = { number, title, body, state: 'open', labels: [...labels], seq: number, comments: [] };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = this.refTip(repo, headRef);
    const baseSha = this.refTip(repo, baseRef);
    if (headSha === undefined || baseSha === undefined) return null;
    const number = ++repo.numberSeq;
    const pull: Pull = {
      number,
      title,
      body,
      state: 'open',
      headRef,
      headSha,
      baseRef,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: number,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** File-level three-way merge; null when head and base both changed a path differently. */
  mergePull(repo: Repo, pull: Pull): { commitSha: string } | null {
    const baseTip = this.refTip(repo, pull.baseRef);
    if (baseTip === undefined) return null;
    const headTip = pull.headSha;
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseFiles = base ? this.filesAtCommit(repo, base) : new Map<string, Buffer>();
    const headFiles = this.filesAtCommit(repo, headTip);
    const baseTipFiles = this.filesAtCommit(repo, baseTip);
    const result = new Map<string, Buffer>(baseTipFiles);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...baseTipFiles.keys()]);
    for (const path of paths) {
      const inBase = baseFiles.get(path);
      const inHead = headFiles.get(path);
      const inTip = baseTipFiles.get(path);
      const headChanged = !buffersEqual(inBase, inHead);
      const baseChanged = !buffersEqual(inBase, inTip);
      if (headChanged && baseChanged && !buffersEqual(inHead, inTip)) return null;
      if (headChanged) {
        if (inHead === undefined) result.delete(path);
        else result.set(path, inHead);
      }
    }
    const tree = this.treeFromFiles(repo, result);
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const commitSha = this.createCommit(repo, tree, [baseTip, headTip], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
    pull.state = 'merged';
    pull.merged = true;
    pull.mergedAt = new Date(trialNowSec() * 1000).toISOString();
    pull.mergeCommitSha = commitSha;
    return { commitSha };
  }

  /** MERGEABLE when a merge would succeed, CONFLICTING when it would not. */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const baseTip = this.refTip(repo, pull.baseRef);
    if (baseTip === undefined) return 'UNKNOWN';
    const base = this.mergeBase(repo, pull.headSha, baseTip);
    const baseFiles = base ? this.filesAtCommit(repo, base) : new Map<string, Buffer>();
    const headFiles = this.filesAtCommit(repo, pull.headSha);
    const baseTipFiles = this.filesAtCommit(repo, baseTip);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...baseTipFiles.keys()]);
    for (const path of paths) {
      const inBase = baseFiles.get(path);
      const inHead = headFiles.get(path);
      const inTip = baseTipFiles.get(path);
      if (!buffersEqual(inBase, inHead) && !buffersEqual(inBase, inTip) && !buffersEqual(inHead, inTip)) {
        return 'CONFLICTING';
      }
    }
    return 'MERGEABLE';
  }

  /** Changed files between the merge base and the head, with line counts. */
  pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const baseTip = this.refTip(repo, pull.baseRef);
    const base = baseTip ? this.mergeBase(repo, pull.headSha, baseTip) : null;
    const baseFiles = base ? this.filesAtCommit(repo, base) : new Map<string, Buffer>();
    const headFiles = this.filesAtCommit(repo, pull.headSha);
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const oldBuf = baseFiles.get(path);
      const newBuf = headFiles.get(path);
      if (buffersEqual(oldBuf, newBuf)) continue;
      const oldLines = oldBuf ? countLines(oldBuf) : 0;
      const newLines = newBuf ? countLines(newBuf) : 0;
      const status = oldBuf === undefined ? 'added' : newBuf === undefined ? 'removed' : 'modified';
      const additions = status === 'removed' ? 0 : newLines;
      const deletions = status === 'added' ? 0 : oldLines;
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }
}

export function buffersEqual(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.equals(b);
}

export function countLines(buf: Buffer): number {
  const text = buf.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}
