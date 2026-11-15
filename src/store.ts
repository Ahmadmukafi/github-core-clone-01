// store.ts — the forge's whole state, in memory. One process, one trial: no disk
// writes anywhere in the hot path (that is also what makes the timed workloads fast).
// Repositories belong to the token's login; every other owner 404s, never 403s.

import { hashObject, relayId, trialNowIso, trialNowSec, VIEWER_EMAIL, VIEWER_LOGIN } from './util.ts';
import {
  applyTreeWrites,
  buildCommit,
  diffTrees,
  flattenTree,
  mergeBase,
  parseCommit,
  parseTree,
  readTreePath,
  reachableCommits,
  type FileChange,
  type GitObject,
} from './objects.ts';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextNumber: number;
}

export class Store {
  repos = new Map<string, Repo>();
  private reposById = new Map<number, Repo>();
  private nextRepoId = 1;
  private nextObjectId = 1;
  private nextCommentId = 1;

  // -- repositories ----------------------------------------------------------

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.id - b.id);
  }

  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string }): Repo {
    const now = trialNowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      fullName: `${owner}/${name}`,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(this.key(owner, name));
    if (repo) this.reposById.delete(repo.id);
    return this.repos.delete(this.key(owner, name));
  }

  // -- objects ---------------------------------------------------------------

  putObject(repo: Repo, obj: GitObject): string {
    const oid = hashObject(obj.type, obj.data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  // -- refs ------------------------------------------------------------------

  refName(branch: string): string {
    return `refs/heads/${branch}`;
  }

  getBranchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(this.refName(branch)) ?? null;
  }

  setBranch(repo: Repo, branch: string, oid: string): void {
    repo.refs.set(this.refName(branch), oid);
  }

  deleteBranch(repo: Repo, branch: string): boolean {
    return repo.refs.delete(this.refName(branch));
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, oid] of [...repo.refs.entries()].sort()) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha: oid });
    }
    return out;
  }

  // -- issues ----------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const found = repo.labels.find((l) => l.name === name);
      if (!found) return { error: `label ${JSON.stringify(name)} does not exist` };
      labels.push(found);
    }
    const now = trialNowIso();
    const issue: Issue = {
      id: this.nextObjectId,
      number: repo.nextNumber,
      title,
      body: body ?? '',
      state: 'open',
      labels,
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    this.nextObjectId += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((i) => i.number === number);
  }

  listIssues(repo: Repo, opts: { state?: string; sort?: string; direction?: string }): Issue[] {
    let list = [...repo.issues];
    const state = opts.state ?? 'open';
    if (state !== 'all') list = list.filter((i) => i.state === state);
    const asc = (opts.direction ?? 'desc') === 'asc';
    list.sort((a, b) => (asc ? a.number - b.number : b.number - a.number));
    return list;
  }

  createLabel(repo: Repo, name: string, color: string, description?: string): Label | { error: string } {
    if (repo.labels.some((l) => l.name === name)) return { error: `label ${JSON.stringify(name)} already exists` };
    const label: Label = { id: this.nextObjectId, name, color: color ?? 'ededed', description: description ?? '' };
    this.nextObjectId += 1;
    repo.labels.push(label);
    return label;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const now = trialNowIso();
    const comment: Comment = { id: this.nextCommentId, body, createdAt: now, updatedAt: now };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // -- pull requests -----------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
    const headSha = this.getBranchTip(repo, head);
    if (headSha === null) return { error: `head branch ${JSON.stringify(head)} does not exist` };
    const baseSha = this.getBranchTip(repo, base);
    if (baseSha === null) return { error: `base branch ${JSON.stringify(base)} does not exist` };
    const dupe = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
    if (dupe) return { error: `a pull request from ${head} into ${base} is already open` };
    const now = trialNowIso();
    const pull: Pull = {
      id: this.nextObjectId,
      number: repo.nextNumber,
      title,
      body: body ?? '',
      state: 'open',
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
    };
    this.nextObjectId += 1;
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((p) => p.number === number);
  }

  listPulls(repo: Repo, state?: string): Pull[] {
    const wanted = state ?? 'open';
    const list = wanted === 'all' ? [...repo.pulls] : repo.pulls.filter((p) => p.state === wanted);
    return list.sort((a, b) => b.number - a.number);
  }

  /** Files changed between the merge-base and the head (what /pulls/{n}/files lists). */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const headTip = this.getBranchTip(repo, pull.head) ?? pull.headSha;
    const baseTip = this.getBranchTip(repo, pull.base) ?? pull.baseSha;
    const base = mergeBase(this.objectStore(repo), headTip, baseTip);
    const store = this.objectStore(repo);
    const headCommit = store.getObject(headTip);
    if (!headCommit || headCommit.type !== 'commit') return [];
    const headTree = parseCommit(headCommit.data).tree;
    const baseTree = base ? parseCommit(store.getObject(base)!.data).tree : null;
    if (baseTree === null) return [];
    return diffTrees(store, baseTree, headTree);
  }

  /** Whether the pull request can merge cleanly right now (three-way check). */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open') return false;
    return this.mergeConflict(repo, pull) === null;
  }

  /** The conflicting path, or null when the merge is clean. */
  mergeConflict(repo: Repo, pull: Pull): string | null {
    const store = this.objectStore(repo);
    const headTip = this.getBranchTip(repo, pull.head) ?? pull.headSha;
    const baseTip = this.getBranchTip(repo, pull.base) ?? pull.baseSha;
    const base = mergeBase(store, headTip, baseTip);
    if (base === null) return null;
    const headTree = parseCommit(store.getObject(headTip)!.data).tree;
    const baseTree = parseCommit(store.getObject(baseTip)!.data).tree;
    const mergeTree = parseCommit(store.getObject(base)!.data).tree;
    const headFlat = flattenTree(store, headTree);
    const baseFlat = flattenTree(store, baseTree);
    const mergeFlat = flattenTree(store, mergeTree);
    const paths = new Set([...headFlat.keys(), ...baseFlat.keys(), ...mergeFlat.keys()]);
    for (const path of paths) {
      const m = mergeFlat.get(path);
      const h = headFlat.get(path);
      const b = baseFlat.get(path);
      const headChanged = (h?.oid ?? null) !== (m?.oid ?? null);
      const baseChanged = (b?.oid ?? null) !== (m?.oid ?? null);
      if (headChanged && baseChanged && (h?.oid ?? null) !== (b?.oid ?? null)) return path;
    }
    return null;
  }

  /**
   * Squash-merge an open pull request onto its base branch. Returns the merge
   * commit's oid, or an error string ('not-found' | 'closed' | 'conflict').
   */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: string } {
    if (pull.state !== 'open') return { error: 'closed' };
    const conflict = this.mergeConflict(repo, pull);
    if (conflict !== null) return { error: 'conflict' };
    const store = this.objectStore(repo);
    const headTip = this.getBranchTip(repo, pull.head) ?? pull.headSha;
    const baseTip = this.getBranchTip(repo, pull.base) ?? pull.baseSha;
    const base = mergeBase(store, headTip, baseTip);
    const headTree = parseCommit(store.getObject(headTip)!.data).tree;
    const baseTree = parseCommit(store.getObject(baseTip)!.data).tree;
    const mergeTree = base ? parseCommit(store.getObject(base)!.data).tree : null;
    // Apply the head's changes (vs the merge-base) onto the base tree.
    const headFlat = flattenTree(store, headTree);
    const mergeFlat = mergeTree ? flattenTree(store, mergeTree) : new Map();
    const writes = new Map<string, { oid: string; mode: string } | null>();
    const paths = new Set([...headFlat.keys(), ...mergeFlat.keys()]);
    for (const path of paths) {
      const h = headFlat.get(path);
      const m = mergeFlat.get(path);
      if ((h?.oid ?? null) !== (m?.oid ?? null)) writes.set(path, h ? { oid: h.oid, mode: h.mode } : null);
    }
    const put = (obj: GitObject): string => this.putObject(repo, obj);
    const newTree = applyTreeWrites(store, put, baseTree, writes);
    const now = trialNowSec();
    const ident = `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${now} +0000`;
    const commitData = buildCommit({
      tree: newTree,
      parents: [baseTip],
      author: ident,
      committer: ident,
      message: pull.title,
    });
    const mergeSha = this.putObject(repo, { type: 'commit', data: commitData });
    this.setBranch(repo, pull.base, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = trialNowIso();
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = trialNowIso();
    return { sha: mergeSha };
  }

  // -- contents ---------------------------------------------------------------

  private objectStore(repo: Repo): { getObject(oid: string): GitObject | undefined } {
    return { getObject: (oid: string) => repo.objects.get(oid) };
  }

  /**
   * Commit one file write on a branch (creating the branch at the default tip
   * when it does not exist yet). Returns the commit sha and the blob sha.
   */
  commitFile(
    repo: Repo,
    opts: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
  ): { commitSha: string; contentSha: string } | { error: string; status: number } {
    const branch = opts.branch ?? repo.defaultBranch;
    let tip = this.getBranchTip(repo, branch);
    if (tip === null) {
      if (opts.branch === undefined) {
        // Unborn repository: the first commit has no parent.
      } else {
        // A new branch starts at the default branch's tip.
        const baseTip = this.getBranchTip(repo, repo.defaultBranch);
        if (baseTip === null) return { error: 'the repository has no commits yet', status: 422 };
        this.setBranch(repo, branch, baseTip);
        tip = baseTip;
      }
    }
    const store = this.objectStore(repo);
    const baseTree = tip ? parseCommit(store.getObject(tip)!.data).tree : null;
    const blobOid = this.putObject(repo, { type: 'blob', data: opts.content });
    if (opts.sha !== undefined) {
      // Updating an existing file: the sha must be the blob the branch holds now.
      const current = baseTree ? readTreePath(store, baseTree, opts.path) : null;
      if (!current || current.oid !== opts.sha) {
        return { error: `sha ${opts.sha} does not match the current blob`, status: 409 };
      }
    } else if (baseTree) {
      const current = readTreePath(store, baseTree, opts.path);
      if (current) {
        // Creating over an existing path without a sha is a conflict.
        return { error: `file ${opts.path} already exists`, status: 422 };
      }
    }
    const writes = new Map<string, { oid: string; mode: string } | null>();
    writes.set(opts.path, { oid: blobOid, mode: '100644' });
    const put = (obj: GitObject): string => this.putObject(repo, obj);
    const newTree = applyTreeWrites(store, put, baseTree, writes);
    const now = trialNowSec();
    const ident = `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${now} +0000`;
    const commitData = buildCommit({
      tree: newTree,
      parents: tip ? [tip] : [],
      author: ident,
      committer: ident,
      message: opts.message,
    });
    const commitSha = this.putObject(repo, { type: 'commit', data: commitData });
    this.setBranch(repo, branch, commitSha);
    return { commitSha, contentSha: blobOid };
  }

  /**
   * Delete one file on the default branch (or `branch`). Returns the commit sha.
   */
  deleteFile(
    repo: Repo,
    opts: { path: string; message: string; branch?: string; sha?: string },
  ): { commitSha: string } | { error: string; status: number } {
    const branch = opts.branch ?? repo.defaultBranch;
    const tip = this.getBranchTip(repo, branch);
    if (tip === null) return { error: 'the repository has no commits yet', status: 404 };
    const store = this.objectStore(repo);
    const baseTree = parseCommit(store.getObject(tip)!.data).tree;
    const current = readTreePath(store, baseTree, opts.path);
    if (!current) return { error: `file ${opts.path} does not exist`, status: 404 };
    if (opts.sha !== undefined && opts.sha !== current.oid) {
      return { error: `sha ${opts.sha} does not match the current blob`, status: 409 };
    }
    const writes = new Map<string, { oid: string; mode: string } | null>();
    writes.set(opts.path, null);
    const put = (obj: GitObject): string => this.putObject(repo, obj);
    const newTree = applyTreeWrites(store, put, baseTree, writes);
    const now = trialNowSec();
    const ident = `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${now} +0000`;
    const commitData = buildCommit({
      tree: newTree,
      parents: [tip],
      author: ident,
      committer: ident,
      message: opts.message,
    });
    const commitSha = this.putObject(repo, { type: 'commit', data: commitData });
    this.setBranch(repo, branch, commitSha);
    return { commitSha };
  }

  /** Read a path out of a branch's tip tree (file blob or directory listing). */
  readPath(
    repo: Repo,
    path: string,
    ref?: string,
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: Array<{ name: string; path: string; sha: string; type: 'file' | 'dir' }> } | null {
    const branch = ref ?? repo.defaultBranch;
    // `ref` may be a branch name or a raw commit oid.
    let tip = this.getBranchTip(repo, branch);
    if (tip === null && /^[0-9a-f]{40}$/.test(branch)) tip = branch;
    if (tip === null) return null;
    const store = this.objectStore(repo);
    const commit = store.getObject(tip);
    if (!commit || commit.type !== 'commit') return null;
    const rootTree = parseCommit(commit.data).tree;
    const segments = path.split('/').filter((s) => s !== '');
    let treeOid = rootTree;
    for (let i = 0; i < segments.length; i += 1) {
      const entries = parseTree(store.getObject(treeOid)?.data ?? Buffer.alloc(0));
      const entry = entries.find((e) => e.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') {
          const dirEntries = parseTree(store.getObject(entry.oid)?.data ?? Buffer.alloc(0));
          return {
            kind: 'dir',
            entries: dirEntries.map((e) => ({
              name: e.name,
              path: [...segments.slice(0, i), e.name].join('/'),
              sha: e.oid,
              type: e.mode === '40000' ? ('dir' as const) : ('file' as const),
            })),
          };
        }
        const blob = store.getObject(entry.oid);
        if (!blob) return null;
        return { kind: 'file', oid: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    // The path is the repository root: list its entries.
    const entries = parseTree(store.getObject(rootTree)?.data ?? Buffer.alloc(0));
    return {
      kind: 'dir',
      entries: entries.map((e) => ({
        name: e.name,
        path: e.name,
        sha: e.oid,
        type: e.mode === '40000' ? ('dir' as const) : ('file' as const),
      })),
    };
  }

  /** Commits reachable from a branch (or the default branch), newest first. */
  listCommits(repo: Repo, ref?: string): Array<{ sha: string; message: string; time: number }> {
    const branch = ref ?? repo.defaultBranch;
    let tip = this.getBranchTip(repo, branch);
    if (tip === null && /^[0-9a-f]{40}$/.test(branch)) tip = branch;
    if (tip === null) return [];
    const store = this.objectStore(repo);
    const commits = reachableCommits(store, [tip]);
    return [...commits.entries()]
      .map(([sha, info]) => ({ sha, message: info.message.replace(/\n$/, ''), time: info.time }))
      .sort((a, b) => b.time - a.time || 0);
  }

  // -- Relay ids ---------------------------------------------------------------

  repoRelayId(repo: Repo): string {
    return relayId('Repository', String(repo.id));
  }

  issueRelayId(repo: Repo, issue: Issue): string {
    return relayId('Issue', `${repo.id}:${issue.number}`);
  }

  pullRelayId(repo: Repo, pull: Pull): string {
    return relayId('PullRequest', `${repo.id}:${pull.number}`);
  }

  commentRelayId(repo: Repo, issue: Issue, comment: Comment): string {
    return relayId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`);
  }

  findByRelayId(id: string): { repo: Repo; issue?: Issue; pull?: Pull; comment?: Comment } | null {
    const parsed = parseRelayIdLocal(id);
    if (!parsed) return null;
    const [repoId, number, commentId] = parsed.key.split(':');
    const repo = [...this.repos.values()].find((r) => String(r.id) === repoId);
    if (!repo) return null;
    if (parsed.kind === 'Repository') return { repo };
    if (parsed.kind === 'Issue') {
      const issue = repo.issues.find((i) => String(i.number) === number);
      return issue ? { repo, issue } : null;
    }
    if (parsed.kind === 'PullRequest') {
      const pull = repo.pulls.find((p) => String(p.number) === number);
      return pull ? { repo, pull } : null;
    }
    if (parsed.kind === 'IssueComment') {
      const issue = repo.issues.find((i) => String(i.number) === number);
      const comment = issue?.comments.find((c) => String(c.id) === commentId);
      return issue && comment ? { repo, issue, comment } : null;
    }
    return null;
  }
}

function parseRelayIdLocal(id: string): { kind: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { kind: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}
