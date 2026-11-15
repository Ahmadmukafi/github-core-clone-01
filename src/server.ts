// server.ts — the HTTP front door: one Node http server routing healthz, git smart
// HTTP, REST v3, GraphQL v4 and MCP. Bearer-token auth on every surface except
// /healthz; every reply carries a non-empty X-GitHub-Request-Id. No disk writes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { nextRequestId } from './util.ts';
import type { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;

export interface ForgeOptions {
  store: Store;
  /** The bearer token the trial expects (MAKEFUN_SHOP_TOKEN). Empty = accept any (local dev only). */
  token: string;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new Error('request body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(body);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), ...extraHeaders });
  res.end(body);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createForgeServer(options: ForgeOptions): Server {
  const { store, token } = options;
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextRequestId() });
        res.end(JSON.stringify({ message: err instanceof Error ? err.message : 'internal server error' }));
      } else {
        res.destroy();
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = nextRequestId();
    res.setHeader('x-github-request-id', requestId);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const segments = path.split('/').filter((s) => s !== '').map(decodeSegment);

    // /healthz: no auth, always 200.
    if (path === '/healthz' && method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Bearer auth on every other surface.
    const auth = req.headers.authorization ?? '';
    if (token !== '' && auth !== `Bearer ${token}`) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }

    // MCP: POST /mcp.
    if (path === '/mcp') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'method not allowed' });
        return;
      }
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 413, { message: 'request body too large' });
        return;
      }
      const outcome = handleMcp(store, body);
      if (outcome.status === 202) {
        res.writeHead(202);
        res.end();
        return;
      }
      sendBuffer(res, outcome.status, 'application/json; charset=utf-8', Buffer.from(outcome.body, 'utf8'));
      return;
    }

    // GraphQL: POST /api/graphql.
    if (path === '/api/graphql') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'method not allowed' });
        return;
      }
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 413, { message: 'request body too large' });
        return;
      }
      const outcome = handleGraphql(store, body);
      sendBuffer(res, outcome.status, 'application/json; charset=utf-8', Buffer.from(outcome.body, 'utf8'));
      return;
    }

    // REST v3: /api/v3/...
    if (segments[0] === 'api' && segments[1] === 'v3') {
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 413, { message: 'request body too large' });
        return;
      }
      const host = req.headers.host ?? '127.0.0.1';
      const origin = `http://${host}`;
      const restReq: RestRequest = {
        method,
        segments: segments.slice(2),
        query: url.searchParams,
        origin,
        body,
        token: auth.startsWith('Bearer ') ? auth.slice(7) : null,
      };
      const reply = await handleRest(store, restReq);
      if (reply.status === 204) {
        res.writeHead(204, reply.headers);
        res.end();
        return;
      }
      sendBuffer(res, reply.status, reply.headers['content-type'] ?? 'application/json; charset=utf-8', Buffer.from(reply.body, 'utf8'), reply.headers);
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/info/refs | git-upload-pack | git-receive-pack.
    if (segments.length >= 3 && segments[1] !== undefined && segments[1].endsWith('.git')) {
      const owner = segments[0]!;
      const repoName = segments[1].slice(0, -'.git'.length);
      const repo = store.getRepo(owner, repoName);
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (segments[2] === 'info' && segments[3] === 'refs' && method === 'GET') {
        const service = url.searchParams.get('service') ?? '';
        const outcome = handleInfoRefs(repo, service, req.headers['git-protocol'] ?? null);
        if (outcome.status === 200) {
          sendBuffer(res, 200, outcome.contentType, outcome.body);
        } else {
          sendBuffer(res, outcome.status, outcome.contentType, outcome.body);
        }
        return;
      }
      if (segments[2] === 'git-upload-pack' && method === 'POST') {
        let body: Buffer;
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, 413, { message: 'request body too large' });
          return;
        }
        const outcome = await handleUploadPack(repo, body);
        sendBuffer(res, outcome.status, outcome.contentType, outcome.body);
        return;
      }
      if (segments[2] === 'git-receive-pack' && method === 'POST') {
        let body: Buffer;
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, 413, { message: 'request body too large' });
          return;
        }
        const outcome = await handleReceivePack(repo, body);
        sendBuffer(res, outcome.status, outcome.contentType, outcome.body);
        return;
      }
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  return server;
}
