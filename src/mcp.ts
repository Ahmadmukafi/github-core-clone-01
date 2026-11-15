// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0, plain JSON
// bodies) at POST /mcp. Modern era first: `server/discover` (2026-07-28) with no
// handshake; the legacy `initialize` + `notifications/initialized` handshake is
// also answered for older clients. Six tools: create_repo, get_repo, create_issue,
// list_issues, create_pull_request, merge_pull_request. Tool results carry both a
// text block (JSON) and structuredContent; a tool failure is isError:true, never
// an HTTP 500. The tool list is a module constant, so tools/list is byte-identical
// on every call.

import { VIEWER_LOGIN } from './util.ts';
import type { Repo, Store } from './store.ts';
import { repoJson, issueJson, pullJson } from './rest-shapes.ts';

export const MCP_REVISION = '2026-07-28';
export const MCP_LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_NAME = 'github-core-clone-forge';
export const SERVER_VERSION = '1.0.0';

const SERVER_INFO = { name: SERVER_NAME, version: SERVER_VERSION };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The one tool list: a constant, so every tools/list answer is byte-identical. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository (defaults to the authenticated user).' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
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
        owner: { type: 'string', description: 'The repository owner.' },
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
        owner: { type: 'string', description: 'The repository owner.' },
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
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch (with the changes).' },
        base: { type: 'string', description: 'The base branch (to merge into).' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge an open pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

interface JsonRpcError { code: number; message: string; data?: unknown }

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, error: JsonRpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function toolResult(structured: unknown, isError = false): Record<string, unknown> {
  const text = typeof structured === 'string' ? structured : JSON.stringify(structured);
  return { content: [{ type: 'text', text }], structuredContent: structured, isError };
}

function toolFailure(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

/** Resolve a repo argument pair; null when the owner or the repo is unknown. */
function findRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = args.owner;
  const repo = args.repo;
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, repo) ?? null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOL_MAP.get(name);
  if (!def) return { __rpcError: { code: -32602, message: `unknown tool ${JSON.stringify(name)}` } };
  const missing = def.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    return { __toolResult: toolFailure(`missing required argument(s): ${missing.join(', ')}`) };
  }
  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER_LOGIN;
      if (owner !== VIEWER_LOGIN) return { __toolResult: toolFailure(`cannot create a repository for owner ${JSON.stringify(owner)}`) };
      if (!/^[A-Za-z0-9._-]+$/.test(repoName)) return { __toolResult: toolFailure(`invalid repository name ${JSON.stringify(repoName)}`) };
      if (store.getRepo(owner, repoName)) return { __toolResult: toolFailure(`repository ${JSON.stringify(repoName)} already exists`) };
      const repo = store.createRepo(owner, repoName, {
        private: typeof args.private === 'boolean' ? args.private : undefined,
        description: typeof args.description === 'string' ? args.description : undefined,
      });
      return { __toolResult: toolResult(repoJson(repo)) };
    }
    case 'get_repo': {
      const repo = findRepo(store, args);
      if (!repo) return { __toolResult: toolFailure(`repository ${JSON.stringify(`${args.owner}/${args.repo}`)} not found`) };
      return { __toolResult: toolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = findRepo(store, args);
      if (!repo) return { __toolResult: toolFailure(`repository ${JSON.stringify(`${args.owner}/${args.repo}`)} not found`) };
      const created = store.createIssue(repo, args.title as string, typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) return { __toolResult: toolFailure(created.error) };
      return { __toolResult: toolResult(issueJson(repo, created)) };
    }
    case 'list_issues': {
      const repo = findRepo(store, args);
      if (!repo) return { __toolResult: toolFailure(`repository ${JSON.stringify(`${args.owner}/${args.repo}`)} not found`) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = store.listIssues(repo, { state }).map((i) => issueJson(repo, i));
      return { __toolResult: toolResult({ issues }) };
    }
    case 'create_pull_request': {
      const repo = findRepo(store, args);
      if (!repo) return { __toolResult: toolFailure(`repository ${JSON.stringify(`${args.owner}/${args.repo}`)} not found`) };
      const created = store.createPull(repo, args.title as string, typeof args.body === 'string' ? args.body : '', args.head as string, args.base as string);
      if ('error' in created) return { __toolResult: toolFailure(created.error) };
      return { __toolResult: toolResult(pullJson(repo, created)) };
    }
    case 'merge_pull_request': {
      const repo = findRepo(store, args);
      if (!repo) return { __toolResult: toolFailure(`repository ${JSON.stringify(`${args.owner}/${args.repo}`)} not found`) };
      const number = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : NaN;
      const pull = store.getPull(repo, number);
      if (!pull) return { __toolResult: toolFailure(`pull request #${String(args.pull_number)} not found`) };
      const result = store.mergePull(repo, pull);
      if ('error' in result) return { __toolResult: toolFailure(`cannot merge pull request #${number}: ${result.error}`) };
      return { __toolResult: toolResult({ merged: true, sha: result.sha, number: pull.number }) };
    }
    default:
      return { __rpcError: { code: -32602, message: `unknown tool ${JSON.stringify(name)}` } };
  }
}

export interface McpResult {
  /** HTTP status. 202 with an empty body is a notification acknowledgement. */
  status: number;
  body: string;
}

/** POST /mcp — one JSON-RPC request (or a notification) per body. */
export function handleMcp(store: Store, body: Buffer): McpResult {
  let request: unknown;
  try {
    request = JSON.parse(body.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: JSON.stringify(rpcError(null, { code: -32700, message: 'Parse error: the request body is not valid JSON' })),
    };
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return {
      status: 400,
      body: JSON.stringify(rpcError(null, { code: -32600, message: 'Invalid Request: expected a JSON-RPC request object' })),
    };
  }
  const req = request as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = 'id' in req ? req.id : undefined;
  const method = req.method;
  if (typeof method !== 'string') {
    return { status: 400, body: JSON.stringify(rpcError(id ?? null, { code: -32600, message: 'Invalid Request: method is required' })) };
  }
  // Notifications carry no id and get no JSON-RPC answer (HTTP 202, empty body).
  if (id === undefined) {
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return { status: 202, body: '' };
    }
    return { status: 202, body: '' };
  }
  const params = (req.params !== null && typeof req.params === 'object' && !Array.isArray(req.params))
    ? (req.params as Record<string, unknown>)
    : {};

  if (method === 'server/discover') {
    return {
      status: 200,
      body: JSON.stringify(rpcResult(id, {
        supportedVersions: [MCP_REVISION, ...MCP_LEGACY_REVISIONS],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      })),
    };
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = [MCP_REVISION, ...MCP_LEGACY_REVISIONS].includes(offered) ? offered : MCP_REVISION;
    return {
      status: 200,
      body: JSON.stringify(rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })),
    };
  }
  if (method === 'ping') {
    return { status: 200, body: JSON.stringify(rpcResult(id, {})) };
  }
  if (method === 'tools/list') {
    return { status: 200, body: JSON.stringify(rpcResult(id, { tools: TOOLS })) };
  }
  if (method === 'tools/call') {
    const toolName = params.name;
    const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
      ? (params.arguments as Record<string, unknown>)
      : {};
    if (typeof toolName !== 'string' || toolName === '') {
      return { status: 200, body: JSON.stringify(rpcError(id, { code: -32602, message: 'tools/call requires a tool name' })) };
    }
    const outcome = callTool(store, toolName, args);
    if ('__rpcError' in outcome) {
      return { status: 200, body: JSON.stringify(rpcError(id, outcome.__rpcError as JsonRpcError)) };
    }
    return { status: 200, body: JSON.stringify(rpcResult(id, outcome.__toolResult)) };
  }
  return { status: 200, body: JSON.stringify(rpcError(id, { code: -32601, message: `Method not found: ${method}` })) };
}
