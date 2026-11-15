// rest.ts — GitHub REST v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests. Every reply is application/json and carries
// a non-empty X-GitHub-Request-Id (added by the server layer); errors are JSON
// with a string message; a repository under another owner is 404, never 403.

import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN } from './util.ts';
import type { Repo, Store } from './store.ts';
import { commentJson, issueJson, labelJson, pullJson, repoJson } from './rest-shapes.ts';

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** The request's own absolute base (for Link headers), e.g. http://127.0.0.1:4123 */
  origin: string;
  /** Raw request body (may be empty). */
  body: Buffer;
  /** The Authorization header's bearer token, or null. */
  token: string | null;
}

export interface RestReply {
  status: number;
  headers: Record<string, string>;
  body: string; // already serialised ('' for 204)
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): RestReply {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(value) };
}

function err(status: number, message: string): RestReply {
  return json(status, { message });
}

function parseBody(req: RestRequest): { ok: true; value: Record<string, unknown> } | { ok: false; reply: RestReply } {
  if (req.body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(req.body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reply: err(400, 'request body must be a JSON object') };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reply: err(400, 'malformed JSON body') };
  }
}

/** Paginate a list: returns the page and the Link header value ('' when done). */
function paginate<T>(items: T[], req: RestRequest, basePath: string): { page: T[]; link: string } {
  const perPage = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(req.query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${req.origin}${basePath}?${q.toString()}`;
  };
  if (pageNum < totalPages) links.push(`<${urlFor(pageNum + 1)}>; rel="next"`);
  if (totalPages > 1) links.push(`<${urlFor(totalPages)}>; rel="last"`);
  if (pageNum > 1) links.push(`<${urlFor(1)}>; rel="first"`);
  return { page, link: links.join(', ') };
}

function linkHeaders(link: string): Record<string, string> {
  return link === '' ? {} : { link };
}

// -- the router ------------------------------------------------------------------

export async function handleRest(store: Store, req: RestRequest): Promise<RestReply> {
  const seg = req.segments;
  const method = req.method;

  // API root.
  if (seg.length === 0) {
    if (method !== 'GET') return err(405, 'method not allowed');
    return json(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_repositories_url: '/api/v3/user/repos',
      meta_url: '/api/v3/meta',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return err(405, 'method not allowed');
    return json(200, { installed_version: '1.0.0', verifiable: true });
  }

  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return err(405, 'method not allowed');
    return json(200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: 'ada iversen', email: VIEWER_EMAIL, type: 'User' });
  }

  if (seg[0] === 'user' && seg[1] === 'repos') {
    if (seg.length !== 2) return err(404, 'Not Found');
    if (method === 'GET') {
      const { page, link } = paginate(store.listRepos(VIEWER_LOGIN).map(repoJson), req, '/api/v3/user/repos');
      return json(200, page, linkHeaders(link));
    }
    if (method === 'POST') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.reply;
      const name = parsed.value.name;
      if (typeof name !== 'string' || name === '') return err(422, 'name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, `invalid repository name ${JSON.stringify(name)}`);
      if (store.getRepo(VIEWER_LOGIN, name)) return err(422, `repository ${JSON.stringify(name)} already exists`);
      const repo = store.createRepo(VIEWER_LOGIN, name, {
        private: typeof parsed.value.private === 'boolean' ? parsed.value.private : undefined,
        description: typeof parsed.value.description === 'string' ? parsed.value.description : undefined,
      });
      return json(201, repoJson(repo));
    }
    return err(405, 'method not allowed');
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1];
    const name = seg[2];
    const rest = seg.slice(3);
    if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');
    const repo = store.getRepo(owner, name);
    if (rest.length === 0) {
      if (method === 'GET') {
        if (!repo) return err(404, 'Not Found');
        return json(200, repoJson(repo));
      }
      if (method === 'PATCH') {
        if (!repo) return err(404, 'Not Found');
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.reply;
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
        repo.updatedAt = new Date().toISOString();
        return json(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        if (!repo) return err(404, 'Not Found');
        store.deleteRepo(owner, name);
        return { status: 204, headers: {}, body: '' };
      }
      return err(405, 'method not allowed');
    }
    if (!repo) return err(404, 'Not Found');
    return handleRepoSub(store, repo, rest, req);
  }

  return err(404, 'Not Found');
}

async function handleRepoSub(store: Store, repo: Repo, rest: string[], req: RestRequest): Promise<RestReply> {
  const method = req.method;
  const basePath = `/api/v3/repos/${repo.fullName}`;

  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = store.listBranches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha }, protected: false }));
      const { page, link } = paginate(branches, req, `${basePath}/branches`);
      return json(200, page, linkHeaders(link));
    }
    if (rest.length === 2 && method === 'GET') {
      const tip = store.getBranchTip(repo, rest[1]);
      if (tip === null) return err(404, 'Not Found');
      return json(200, { name: rest[1], commit: { sha: tip }, protected: false });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const sha = req.query.get('sha') ?? undefined;
      const commits = store.listCommits(repo, sha).map((c) => ({
        sha: c.sha,
        commit: { message: c.message, author: { name: VIEWER_LOGIN, email: VIEWER_EMAIL }, committer: { name: VIEWER_LOGIN, email: VIEWER_EMAIL } },
        author: { login: VIEWER_LOGIN, id: VIEWER_ID },
        committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
      }));
      const { page, link } = paginate(commits, req, `${basePath}/commits`);
      return json(200, page, linkHeaders(link));
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'GET') {
      const refs = [...repo.refs.entries()].sort().map(([ref, oid]) => ({ ref, object: { sha: oid, type: 'commit' } }));
      return json(200, refs);
    }
    if (rest.length === 2 && method === 'POST') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.reply;
      const ref = parsed.value.ref;
      const sha = parsed.value.sha;
      if (typeof ref !== 'string' || !ref.startsWith('refs/heads/')) return err(422, 'ref must be a branch ref');
      if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'sha must be a 40-char object id');
      if (repo.refs.has(ref)) return err(422, `ref ${ref} already exists`);
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'commit') return err(422, 'sha is not a commit');
      repo.refs.set(ref, sha);
      return json(201, { ref, object: { sha, type: 'commit' } });
    }
    if (rest.length === 4 && rest[2] === 'heads' && method === 'GET') {
      const ref = `refs/heads/${rest[3]}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return err(404, 'Not Found');
      return json(200, { ref, object: { sha: oid, type: 'commit' } });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const ref = req.query.get('ref') ?? undefined;
      const found = store.readPath(repo, path, ref);
      if (!found) return err(404, 'Not Found');
      if (found.kind === 'file') {
        return json(200, {
          type: 'file',
          encoding: 'base64',
          size: found.data.length,
          name: path.split('/').pop() ?? path,
          path,
          content: found.data.toString('base64'),
          sha: found.oid,
        });
      }
      return json(200, found.entries.map((e) => ({ type: e.type, size: 0, name: e.name, path: e.path, sha: e.sha })));
    }
    if (method === 'PUT') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.reply;
      const message = typeof parsed.value.message === 'string' ? parsed.value.message : '';
      const contentB64 = parsed.value.content;
      if (typeof contentB64 !== 'string') return err(422, 'content is required');
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        return err(422, 'content is not valid base64');
      }
      const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : undefined;
      const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
      const existing = store.readPath(repo, path, branch);
      const result = store.commitFile(repo, { path, content, message, branch, sha });
      if ('error' in result) return err(result.status, result.error);
      const status = existing && existing.kind === 'file' ? 200 : 201;
      return json(status, {
        content: { name: path.split('/').pop() ?? path, path, sha: result.contentSha, size: content.length, encoding: 'base64' },
        commit: { sha: result.commitSha, message },
      });
    }
    if (method === 'DELETE') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.reply;
      const message = typeof parsed.value.message === 'string' ? parsed.value.message : '';
      const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
      const result = store.deleteFile(repo, { path, message, sha });
      if ('error' in result) return err(result.status, result.error);
      return json(200, { commit: { sha: result.commitSha, message } });
    }
    return err(405, 'method not allowed');
  }

  if (rest[0] === 'labels') {
    if (method === 'GET') return json(200, repo.labels.map(labelJson));
    if (method === 'POST') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.reply;
      const name = parsed.value.name;
      if (typeof name !== 'string' || name === '') return err(422, 'name is required');
      const color = typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed';
      const result = store.createLabel(repo, name, color, typeof parsed.value.description === 'string' ? parsed.value.description : undefined);
      if ('error' in result) return err(422, result.error);
      return json(201, labelJson(result));
    }
    return err(405, 'method not allowed');
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const list = store.listIssues(repo, {
          state: req.query.get('state') ?? undefined,
          sort: req.query.get('sort') ?? undefined,
          direction: req.query.get('direction') ?? undefined,
        }).map((i) => issueJson(repo, i));
        const { page, link } = paginate(list, req, `${basePath}/issues`);
        return json(200, page, linkHeaders(link));
      }
      if (method === 'POST') {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.reply;
        const title = parsed.value.title;
        if (typeof title !== 'string' || title === '') return err(422, 'title is required');
        const body = typeof parsed.value.body === 'string' ? parsed.value.body : '';
        const labels = Array.isArray(parsed.value.labels) ? parsed.value.labels.filter((l): l is string => typeof l === 'string') : [];
        const created = store.createIssue(repo, title, body, labels);
        if ('error' in created) return err(422, created.error);
        return json(201, issueJson(repo, created));
      }
      return err(405, 'method not allowed');
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
    const issue = store.getIssue(repo, number);
    if (rest.length === 2) {
      if (!issue) return err(404, 'Not Found');
      if (method === 'GET') return json(200, issueJson(repo, issue));
      if (method === 'PATCH') {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.reply;
        if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
        if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
        if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
        issue.updatedAt = new Date().toISOString();
        return json(200, issueJson(repo, issue));
      }
      return err(405, 'method not allowed');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (!issue) return err(404, 'Not Found');
      if (method === 'GET') {
        const { page, link } = paginate(issue.comments.map((c) => commentJson(repo, issue, c)), req, `${basePath}/issues/${number}/comments`);
        return json(200, page, linkHeaders(link));
      }
      if (method === 'POST') {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.reply;
        const body = parsed.value.body;
        if (typeof body !== 'string' || body === '') return err(422, 'body is required');
        const comment = store.addComment(repo, issue, body);
        return json(201, commentJson(repo, issue, comment));
      }
      return err(405, 'method not allowed');
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const list = store.listPulls(repo, req.query.get('state') ?? undefined).map((p) => pullJson(repo, p));
        const { page, link } = paginate(list, req, `${basePath}/pulls`);
        return json(200, page, linkHeaders(link));
      }
      if (method === 'POST') {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.reply;
        const title = parsed.value.title;
        const head = parsed.value.head;
        const base = parsed.value.base;
        if (typeof title !== 'string' || title === '') return err(422, 'title is required');
        if (typeof head !== 'string' || head === '') return err(422, 'head is required');
        if (typeof base !== 'string' || base === '') return err(422, 'base is required');
        const created = store.createPull(repo, title, typeof parsed.value.body === 'string' ? parsed.value.body : '', head, base);
        if ('error' in created) return err(422, created.error);
        return json(201, pullJson(repo, created));
      }
      return err(405, 'method not allowed');
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
    const pull = store.getPull(repo, number);
    if (rest.length === 2) {
      if (!pull) return err(404, 'Not Found');
      if (method === 'GET') return json(200, pullJson(repo, pull));
      return err(405, 'method not allowed');
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (!pull) return err(404, 'Not Found');
      const files = store.pullFiles(repo, pull).map((f) => ({
        filename: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.additions + f.deletions,
      }));
      return json(200, files);
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (!pull) return err(404, 'Not Found');
      const result = store.mergePull(repo, pull);
      if ('error' in result) {
        if (result.error === 'closed') return err(405, 'pull request is already closed');
        return err(405, 'merge conflict');
      }
      return json(200, { merged: true, sha: result.sha, message: `Merge pull request #${pull.number} from ${pull.head}` });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
