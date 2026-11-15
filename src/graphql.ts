// graphql.ts — a small, dependency-free GraphQL v4 executor for the shapes gh
// (githubv4) and github-mcp-server actually send: viewer/repository/issue/pull
// reads, Relay node(id:), __type introspection, the five mutations, operation
// batching, and cursor pagination. Unknown fields are GraphQL errors on a 200,
// never an HTTP error; an unknown repository is data.repository = null.

import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, b64urlDecode, b64urlEncode, parseRelayId, relayId } from './util.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

// -------------------------------------------------------------------------------------------
// Document parsing (tokenizer + recursive descent, the GraphQL subset the clients send)
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface ArgumentNode { name: string; value: ValueNode }
interface DirectiveNode { name: string; args: ArgumentNode[] }
type SelectionNode =
  | { kind: 'field'; name: string; alias: string | null; args: ArgumentNode[]; directives: DirectiveNode[]; selections: SelectionNode[] | null }
  | { kind: 'fragmentSpread'; name: string; directives: DirectiveNode[] }
  | { kind: 'inlineFragment'; typeCondition: string | null; directives: DirectiveNode[]; selections: SelectionNode[] };

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

interface FragmentNode { name: string; typeCondition: string; selections: SelectionNode[] }

interface DocumentNode { operations: OperationNode[]; fragments: Map<string, FragmentNode> }

class ParseError extends Error {}

function tokenize(source: string): Array<{ type: string; value: string }> {
  const tokens: Array<{ type: string; value: string }> = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (ch === '.' && source.slice(i, i + 3) === '...') { tokens.push({ type: '...', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@&|'.includes(ch)) { tokens.push({ type: ch, value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') { out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16)); j += 4; }
          else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new ParseError('unterminated string');
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ type: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push({ type: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ type: 'EOF', value: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Array<{ type: string; value: string }>;
  constructor(tokens: Array<{ type: string; value: string }>) {
    this.tokens = tokens;
  }

  private peek(): { type: string; value: string } { return this.tokens[this.pos]!; }
  private next(): { type: string; value: string } { return this.tokens[this.pos++]!; }
  private expect(type: string): { type: string; value: string } {
    const t = this.next();
    if (t.type !== type) throw new ParseError(`expected ${type}, got ${t.type} (${t.value})`);
    return t;
  }
  private eat(type: string): boolean {
    if (this.peek().type === type) { this.pos += 1; return true; }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().type !== 'EOF') {
      const t = this.peek();
      if (t.type === '{') {
        operations.push({ kind: 'query', name: null, variableDefinitions: [], selections: this.parseSelectionSet() });
      } else if (t.type === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().type === 'name') name = this.next().value;
        const variableDefinitions = this.parseVariableDefinitions();
        const selections = this.parseSelectionSet();
        operations.push({ kind, name, variableDefinitions, selections });
      } else if (t.type === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expect('name').value;
        this.expect('name'); // 'on'
        const typeCondition = this.expect('name').value;
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
      } else {
        throw new ParseError(`unexpected token ${t.type} (${t.value}) at document top level`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (!this.eat('(')) return defs;
    while (!this.eat(')')) {
      this.expect('$');
      const name = this.expect('name').value;
      this.expect(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.eat('=')) defaultValue = this.parseValue(true);
      defs.push({ name, defaultValue });
    }
    return defs;
  }

  private parseType(): void {
    if (this.eat('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.expect('name');
    }
    this.eat('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (!this.eat('}')) {
      if (this.peek().type === 'EOF') throw new ParseError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().type === '...') {
      this.next();
      if (this.peek().type === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expect('name').value;
        const directives = this.parseDirectives();
        return { kind: 'inlineFragment', typeCondition, directives, selections: this.parseSelectionSet() };
      }
      if (this.peek().type === 'name') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'fragmentSpread', name, directives };
      }
      const directives = this.parseDirectives();
      return { kind: 'inlineFragment', typeCondition: null, directives, selections: this.parseSelectionSet() };
    }
    let name = this.expect('name').value;
    let alias: string | null = null;
    if (this.eat(':')) {
      alias = name;
      name = this.expect('name').value;
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    const selections = this.peek().type === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, directives, selections };
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    if (!this.eat('(')) return args;
    while (!this.eat(')')) {
      const name = this.expect('name').value;
      this.expect(':');
      args.push({ name, value: this.parseValue(false) });
    }
    return args;
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.eat('@')) {
      const name = this.expect('name').value;
      directives.push({ name, args: this.parseArguments() });
    }
    return directives;
  }

  private parseValue(isConst: boolean): ValueNode {
    const t = this.peek();
    if (t.type === '$') {
      if (isConst) throw new ParseError('variable in a constant value');
      this.next();
      return { kind: 'variable', name: this.expect('name').value };
    }
    if (t.type === 'string') { this.next(); return { kind: 'string', value: t.value }; }
    if (t.type === 'number') {
      this.next();
      return t.value.includes('.') || /[eE]/.test(t.value)
        ? { kind: 'float', value: Number(t.value) }
        : { kind: 'int', value: Number(t.value) };
    }
    if (t.type === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (!this.eat(']')) values.push(this.parseValue(isConst));
      return { kind: 'list', values };
    }
    if (t.type === '{') {
      this.next();
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.eat('}')) {
        const name = this.expect('name').value;
        this.expect(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      return { kind: 'object', fields };
    }
    if (t.type === 'name') {
      this.next();
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new ParseError(`unexpected value token ${t.type} (${t.value})`);
  }
}

function valueFromNode(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => valueFromNode(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueFromNode(f.value, variables);
      return out;
    }
  }
}

function argsMap(args: ArgumentNode[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) out[a.name] = valueFromNode(a.value, variables);
  return out;
}

function directiveApplies(directives: DirectiveNode[], variables: Record<string, unknown>): boolean {
  for (const d of directives) {
    const args = argsMap(d.args, variables);
    if (d.name === 'skip' && args.if === true) return false;
    if (d.name === 'include' && args.if === false) return false;
  }
  return true;
}

// -------------------------------------------------------------------------------------------
// The schema the introspection probes read (only the types the clients name)
// -------------------------------------------------------------------------------------------

interface IntrospectField { name: string; description?: string }
interface IntrospectType { name: string; kind: 'OBJECT' | 'ENUM' | 'SCALAR'; fields?: IntrospectField[]; enumValues?: string[] }

const SCHEMA_TYPES: Record<string, IntrospectType> = {
  Query: { name: 'Query', kind: 'OBJECT', fields: [{ name: 'viewer' }, { name: 'repository' }, { name: 'node' }, { name: '__type' }, { name: '__schema' }] },
  Mutation: { name: 'Mutation', kind: 'OBJECT', fields: [{ name: 'createIssue' }, { name: 'closeIssue' }, { name: 'createPullRequest' }, { name: 'mergePullRequest' }, { name: 'addComment' }] },
  Repository: {
    name: 'Repository', kind: 'OBJECT',
    fields: [
      { name: 'id' }, { name: 'databaseId' }, { name: 'name' }, { name: 'nameWithOwner' }, { name: 'owner' },
      { name: 'defaultBranchRef' }, { name: 'viewerPermission' }, { name: 'hasIssuesEnabled' }, { name: 'issue' },
      { name: 'issues' }, { name: 'pullRequests' }, { name: 'pullRequest' }, { name: 'createdAt' }, { name: 'updatedAt' },
      { name: 'description' }, { name: 'url' }, { name: 'isPrivate' },
    ],
  },
  Issue: {
    name: 'Issue', kind: 'OBJECT',
    fields: [
      { name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'state' }, { name: 'body' },
      { name: 'createdAt' }, { name: 'updatedAt' }, { name: 'author' }, { name: 'repository' }, { name: 'url' },
      { name: 'labels' }, { name: 'comments' },
    ],
  },
  PullRequest: {
    name: 'PullRequest', kind: 'OBJECT',
    fields: [
      { name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'body' }, { name: 'state' }, { name: 'merged' },
      { name: 'mergeable' }, { name: 'headRefName' }, { name: 'baseRefName' }, { name: 'headRefOid' }, { name: 'baseRefOid' },
      { name: 'files' }, { name: 'createdAt' }, { name: 'updatedAt' }, { name: 'author' }, { name: 'repository' }, { name: 'url' },
    ],
  },
  User: { name: 'User', kind: 'OBJECT', fields: [{ name: 'id' }, { name: 'login' }, { name: 'name' }, { name: 'email' }, { name: 'url' }] },
  Ref: { name: 'Ref', kind: 'OBJECT', fields: [{ name: 'id' }, { name: 'name' }, { name: 'target' }] },
  IssueConnection: { name: 'IssueConnection', kind: 'OBJECT', fields: [{ name: 'nodes' }, { name: 'edges' }, { name: 'pageInfo' }, { name: 'totalCount' }] },
  IssueEdge: { name: 'IssueEdge', kind: 'OBJECT', fields: [{ name: 'node' }, { name: 'cursor' }] },
  PullRequestConnection: { name: 'PullRequestConnection', kind: 'OBJECT', fields: [{ name: 'nodes' }, { name: 'edges' }, { name: 'pageInfo' }, { name: 'totalCount' }] },
  PullRequestEdge: { name: 'PullRequestEdge', kind: 'OBJECT', fields: [{ name: 'node' }, { name: 'cursor' }] },
  PullRequestChangedFileConnection: { name: 'PullRequestChangedFileConnection', kind: 'OBJECT', fields: [{ name: 'nodes' }, { name: 'edges' }, { name: 'pageInfo' }, { name: 'totalCount' }] },
  PullRequestChangedFile: { name: 'PullRequestChangedFile', kind: 'OBJECT', fields: [{ name: 'path' }, { name: 'additions' }, { name: 'deletions' }, { name: 'changeType' }] },
  PageInfo: { name: 'PageInfo', kind: 'OBJECT', fields: [{ name: 'hasNextPage' }, { name: 'hasPreviousPage' }, { name: 'startCursor' }, { name: 'endCursor' }] },
  IssueComment: { name: 'IssueComment', kind: 'OBJECT', fields: [{ name: 'id' }, { name: 'body' }, { name: 'author' }, { name: 'createdAt' }, { name: 'updatedAt' }] },
  IssueCommentEdge: { name: 'IssueCommentEdge', kind: 'OBJECT', fields: [{ name: 'node' }, { name: 'cursor' }] },
  Node: { name: 'Node', kind: 'OBJECT', fields: [{ name: 'id' }] },
  IssueState: { name: 'IssueState', kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { name: 'PullRequestState', kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { name: 'MergeableState', kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { name: 'RepositoryPermission', kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { name: 'SearchType', kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'PACKAGE', 'MARKETPLACE', 'TOPIC'] },
  IssueOrderField: { name: 'IssueOrderField', kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { name: 'OrderDirection', kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { name: 'PullRequestMergeMethod', kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  String: { name: 'String', kind: 'SCALAR' },
  Int: { name: 'Int', kind: 'SCALAR' },
  Boolean: { name: 'Boolean', kind: 'SCALAR' },
  ID: { name: 'ID', kind: 'SCALAR' },
};

// -------------------------------------------------------------------------------------------
// Global ids (Relay): base64 of "Kind:payload" — opaque and stable across reads
// -------------------------------------------------------------------------------------------

export function repoGlobalId(repo: Repo): string {
  return relayId('Repository', String(repo.id));
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return relayId('Issue', `${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return relayId('PullRequest', `${repo.id}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return relayId('IssueComment', `${repo.id}:${issue.number}:${commentId}`);
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  const parsed = parseRelayId(id);
  if (!parsed) return null;
  return { kind: parsed.kind, parts: parsed.key.split(':') };
}

function cursorFor(number: number): string {
  return b64urlEncode(`cursor:${number}`);
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const text = b64urlDecode(cursor);
  if (text === null) return null;
  const m = text.match(/^cursor:(\d+)$/);
  return m ? Number(m[1]) : null;
}

// -------------------------------------------------------------------------------------------
// Execution
// -------------------------------------------------------------------------------------------

interface GqlObj { __typename: string; data: unknown }

interface GqlContext {
  store: Store;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

const UNRESOLVED = Symbol('unresolved');
const FIELD_ERROR = Symbol('field-error');

function obj(typename: string, data: unknown): GqlObj {
  return { __typename: typename, data };
}

function repoObj(repo: Repo): GqlObj { return obj('Repository', repo); }
function issueObj(repo: Repo, issue: Issue): GqlObj { return obj('Issue', { repo, issue }); }
function pullObj(repo: Repo, pull: Pull): GqlObj { return obj('PullRequest', { repo, pull }); }
function userObj(): GqlObj { return obj('User', null); }

function pageInfoObj(hasNextPage: boolean, endCursor: string | null, startCursor: string | null): GqlObj {
  return obj('PageInfo', { hasNextPage, endCursor, startCursor });
}

function connectionObj(typename: string, nodes: GqlObj[], cursors: string[], hasNextPage: boolean, totalCount: number): GqlObj {
  const endCursor = cursors.length > 0 ? cursors[cursors.length - 1]! : null;
  const startCursor = cursors.length > 0 ? cursors[0]! : null;
  const edgeTypename = typename === 'IssueConnection' ? 'IssueEdge' : typename === 'PullRequestConnection' ? 'PullRequestEdge' : 'PullRequestChangedFileEdge';
  const edges = nodes.map((node, i) => obj(edgeTypename, { node, cursor: cursors[i]! }));
  return obj(typename, { nodes, edges, pageInfo: pageInfoObj(hasNextPage, endCursor, startCursor), totalCount });
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObj {
  const states = (Array.isArray(args.states) ? args.states : ['OPEN']) as string[];
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const dir = orderBy.direction === 'ASC' ? 1 : -1;
  let list = repo.issues.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  list = [...list].sort((a, b) => dir * (a.number - b.number));
  const after = numberFromCursor(typeof args.after === 'string' ? args.after : null);
  if (after !== null) list = list.filter((i) => (dir === -1 ? i.number < after : i.number > after));
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = list.slice(0, Math.max(0, first));
  const hasNextPage = list.length > page.length;
  return connectionObj('IssueConnection', page.map((i) => issueObj(repo, i)), page.map((i) => cursorFor(i.number)), hasNextPage, list.length);
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): GqlObj {
  const list = [...repo.pulls]
    .filter((p) => p.state === 'open')
    .sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = list.slice(0, Math.max(0, first));
  return connectionObj('PullRequestConnection', page.map((p) => pullObj(repo, p)), page.map((p) => cursorFor(p.number)), list.length > page.length, list.length);
}

function filesConnection(store: Store, repo: Repo, pull: Pull, args: Record<string, unknown>): GqlObj {
  const files = store.pullFiles(repo, pull);
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = files.slice(0, Math.max(0, first));
  const nodes = page.map((f) => obj('PullRequestChangedFile', f));
  return connectionObj('PullRequestChangedFileConnection', nodes, page.map((f) => cursorFor(f.path.length)), files.length > page.length, files.length);
}

function typeObj(name: string): GqlObj {
  return obj('__Type', SCHEMA_TYPES[name]!);
}

function resolveField(parent: GqlObj, name: string, args: Record<string, unknown>, ctx: GqlContext): unknown {
  const { store } = ctx;
  switch (parent.__typename) {
    case 'Query': {
      if (name === 'viewer') return userObj();
      if (name === 'repository') {
        const owner = args.owner as string | undefined;
        const repoName = args.name as string | undefined;
        if (typeof owner !== 'string' || typeof repoName !== 'string') return { [FIELD_ERROR]: 'repository requires owner and name' };
        const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
        return repo ? repoObj(repo) : null;
      }
      if (name === 'node') {
        const id = args.id as string | undefined;
        if (typeof id !== 'string') return { [FIELD_ERROR]: 'node requires id' };
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = store.getRepoById(Number(decoded.parts[0]));
          return repo ? repoObj(repo) : null;
        }
        if (decoded.kind === 'Issue') {
          const repo = store.getRepoById(Number(decoded.parts[0]));
          const issue = repo ? store.getIssue(repo, Number(decoded.parts[1])) : undefined;
          return repo && issue ? issueObj(repo, issue) : null;
        }
        if (decoded.kind === 'PullRequest') {
          const repo = store.getRepoById(Number(decoded.parts[0]));
          const pull = repo ? store.getPull(repo, Number(decoded.parts[1])) : undefined;
          return repo && pull ? pullObj(repo, pull) : null;
        }
        return null;
      }
      if (name === '__type') {
        const typeName = args.name as string | undefined;
        if (typeof typeName !== 'string') return { [FIELD_ERROR]: '__type requires name' };
        return SCHEMA_TYPES[typeName] ? typeObj(typeName) : null;
      }
      if (name === '__schema') return obj('__Schema', null);
      return UNRESOLVED;
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (name === 'createIssue') {
        const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
        const repo = decoded?.kind === 'Repository' ? store.getRepoById(Number(decoded.parts[0])) : undefined;
        if (!repo) return { [FIELD_ERROR]: 'createIssue: unknown repository' };
        if (typeof input.title !== 'string' || input.title === '') return { [FIELD_ERROR]: 'createIssue: title is required' };
        const created = store.createIssue(repo, input.title, typeof input.body === 'string' ? input.body : '', []);
        if ('error' in created) return { [FIELD_ERROR]: `createIssue: ${created.error}` };
        return obj('CreateIssuePayload', { issue: issueObj(repo, created) });
      }
      if (name === 'closeIssue') {
        const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
        const repo = decoded?.kind === 'Issue' ? store.getRepoById(Number(decoded.parts[0])) : undefined;
        const issue = repo ? store.getIssue(repo, Number(decoded!.parts[1])) : undefined;
        if (!repo || !issue) return { [FIELD_ERROR]: 'closeIssue: unknown issue' };
        issue.state = 'closed';
        issue.updatedAt = new Date().toISOString();
        return obj('CloseIssuePayload', { issue: issueObj(repo, issue) });
      }
      if (name === 'createPullRequest') {
        const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
        const repo = decoded?.kind === 'Repository' ? store.getRepoById(Number(decoded.parts[0])) : undefined;
        if (!repo) return { [FIELD_ERROR]: 'createPullRequest: unknown repository' };
        const created = store.createPull(
          repo,
          typeof input.title === 'string' ? input.title : '',
          typeof input.body === 'string' ? input.body : '',
          typeof input.headRefName === 'string' ? input.headRefName : '',
          typeof input.baseRefName === 'string' ? input.baseRefName : '',
        );
        if ('error' in created) return { [FIELD_ERROR]: `createPullRequest: ${created.error}` };
        return obj('CreatePullRequestPayload', { pullRequest: pullObj(repo, created) });
      }
      if (name === 'mergePullRequest') {
        const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
        const repo = decoded?.kind === 'PullRequest' ? store.getRepoById(Number(decoded.parts[0])) : undefined;
        const pull = repo ? store.getPull(repo, Number(decoded!.parts[1])) : undefined;
        if (!repo || !pull) return { [FIELD_ERROR]: 'mergePullRequest: unknown pull request' };
        const result = store.mergePull(repo, pull);
        if ('error' in result) return { [FIELD_ERROR]: `mergePullRequest: ${result.error}` };
        return obj('MergePullRequestPayload', { pullRequest: pullObj(repo, pull) });
      }
      if (name === 'addComment') {
        const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
        const repo = decoded?.kind === 'Issue' ? store.getRepoById(Number(decoded.parts[0])) : undefined;
        const issue = repo ? store.getIssue(repo, Number(decoded!.parts[1])) : undefined;
        if (!repo || !issue) return { [FIELD_ERROR]: 'addComment: unknown subject' };
        if (typeof input.body !== 'string' || input.body === '') return { [FIELD_ERROR]: 'addComment: body is required' };
        const comment = store.addComment(repo, issue, input.body);
        const node = obj('IssueComment', { repo, issue, comment });
        const edge = obj('IssueCommentEdge', { node, cursor: cursorFor(comment.id) });
        return obj('AddCommentPayload', { commentEdge: edge, subject: issueObj(repo, issue) });
      }
      return UNRESOLVED;
    }
    case 'Repository': {
      const repo = parent.data as Repo;
      switch (name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.fullName;
        case 'owner': return userObj();
        case 'defaultBranchRef': return obj('Ref', { repo, name: repo.defaultBranch });
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'description': return repo.description;
        case 'url': return `https://github.com/${repo.fullName}`;
        case 'isPrivate': return repo.private;
        case 'issue': {
          const issue = store.getIssue(repo, Number(args.number));
          return issue ? issueObj(repo, issue) : null;
        }
        case 'issues': return issuesConnection(repo, args);
        case 'pullRequests': return pullsConnection(repo, args);
        case 'pullRequest': {
          const pull = store.getPull(repo, Number(args.number));
          return pull ? pullObj(repo, pull) : null;
        }
        default: return UNRESOLVED;
      }
    }
    case 'Issue': {
      const { repo, issue } = parent.data as { repo: Repo; issue: Issue };
      switch (name) {
        case 'id': return issueGlobalId(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body': return issue.body;
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'author': return userObj();
        case 'repository': return repoObj(repo);
        case 'url': return `https://github.com/${repo.fullName}/issues/${issue.number}`;
        case 'labels': return issue.labels.map((l) => obj('Label', l));
        case 'comments': return obj('IssueCommentConnection', { nodes: issue.comments.map((c) => obj('IssueComment', { repo, issue, comment: c })) });
        default: return UNRESOLVED;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = parent.data as { repo: Repo; pull: Pull };
      switch (name) {
        case 'id': return pullGlobalId(repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return pull.merged;
        case 'mergeable': return pull.state !== 'open' ? 'UNKNOWN' : store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'headRefName': return pull.head;
        case 'baseRefName': return pull.base;
        case 'headRefOid': return pull.headSha;
        case 'baseRefOid': return pull.baseSha;
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'author': return userObj();
        case 'repository': return repoObj(repo);
        case 'url': return `https://github.com/${repo.fullName}/pull/${pull.number}`;
        case 'files': return filesConnection(store, repo, pull, args);
        default: return UNRESOLVED;
      }
    }
    case 'User': {
      switch (name) {
        case 'id': return relayId('User', String(VIEWER_ID));
        case 'login': return VIEWER_LOGIN;
        case 'name': return 'ada iversen';
        case 'email': return VIEWER_EMAIL;
        case 'url': return `https://github.com/${VIEWER_LOGIN}`;
        default: return UNRESOLVED;
      }
    }
    case 'Ref': {
      const { repo, name: refName } = parent.data as { repo: Repo; name: string };
      switch (name) {
        case 'id': return relayId('Ref', `${repo.id}:${refName}`);
        case 'name': return refName;
        case 'target': {
          const oid = repo.refs.get(`refs/heads/${refName}`) ?? repo.refs.get(refName);
          return oid ? obj('Commit', { oid }) : null;
        }
        default: return UNRESOLVED;
      }
    }
    case 'Commit': {
      const { oid } = parent.data as { oid: string };
      if (name === 'oid') return oid;
      if (name === 'id') return relayId('Commit', oid);
      return UNRESOLVED;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'IssueCommentConnection': {
      const data = parent.data as { nodes: GqlObj[]; edges: GqlObj[]; pageInfo: GqlObj; totalCount?: number };
      switch (name) {
        case 'nodes': return data.nodes;
        case 'edges': return data.edges;
        case 'pageInfo': return data.pageInfo;
        case 'totalCount': return data.totalCount ?? data.nodes.length;
        default: return UNRESOLVED;
      }
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge':
    case 'IssueCommentEdge': {
      const data = parent.data as { node: GqlObj; cursor: string };
      if (name === 'node') return data.node;
      if (name === 'cursor') return data.cursor;
      return UNRESOLVED;
    }
    case 'PageInfo': {
      const data = parent.data as { hasNextPage: boolean; endCursor: string | null; startCursor: string | null };
      switch (name) {
        case 'hasNextPage': return data.hasNextPage;
        case 'hasPreviousPage': return false;
        case 'startCursor': return data.startCursor;
        case 'endCursor': return data.endCursor;
        default: return UNRESOLVED;
      }
    }
    case 'PullRequestChangedFile': {
      const f = parent.data as { path: string; status: string; additions: number; deletions: number };
      switch (name) {
        case 'path': return f.path;
        case 'additions': return f.additions;
        case 'deletions': return f.deletions;
        case 'changeType': return f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED';
        default: return UNRESOLVED;
      }
    }
    case 'IssueComment': {
      const { repo, issue, comment } = parent.data as { repo: Repo; issue: Issue; comment: { id: number; body: string; createdAt: string; updatedAt: string } };
      switch (name) {
        case 'id': return commentGlobalId(repo, issue, comment.id);
        case 'body': return comment.body;
        case 'author': return userObj();
        case 'createdAt': return comment.createdAt;
        case 'updatedAt': return comment.updatedAt;
        default: return UNRESOLVED;
      }
    }
    case 'Label': {
      const label = parent.data as { name: string; color: string; description?: string };
      switch (name) {
        case 'name': return label.name;
        case 'color': return label.color;
        case 'description': return label.description ?? null;
        default: return UNRESOLVED;
      }
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const data = parent.data as { issue: GqlObj };
      if (name === 'issue') return data.issue;
      return UNRESOLVED;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const data = parent.data as { pullRequest: GqlObj };
      if (name === 'pullRequest') return data.pullRequest;
      return UNRESOLVED;
    }
    case 'AddCommentPayload': {
      const data = parent.data as { commentEdge: GqlObj; subject: GqlObj };
      if (name === 'commentEdge') return data.commentEdge;
      if (name === 'subject') return data.subject;
      return UNRESOLVED;
    }
    case '__Type': {
      const t = SCHEMA_TYPES[(parent.data as IntrospectType).name]!;
      switch (name) {
        case 'name': return t.name;
        case 'kind': return t.kind;
        case 'description': return null;
        case 'fields': return t.kind === 'OBJECT' ? (t.fields ?? []).map((f) => obj('__Field', f)) : null;
        case 'enumValues': return t.kind === 'ENUM' ? (t.enumValues ?? []).map((v) => obj('__EnumValue', { name: v })) : null;
        case 'interfaces': return [];
        case 'possibleTypes': return null;
        default: return UNRESOLVED;
      }
    }
    case '__Field': {
      const f = parent.data as IntrospectField;
      if (name === 'name') return f.name;
      if (name === 'description') return f.description ?? null;
      if (name === 'args') return [];
      if (name === 'type') return obj('__Type', SCHEMA_TYPES.String!);
      return UNRESOLVED;
    }
    case '__EnumValue': {
      const v = parent.data as { name: string };
      if (name === 'name') return v.name;
      if (name === 'description') return null;
      return UNRESOLVED;
    }
    case '__Schema': {
      switch (name) {
        case 'types': return Object.keys(SCHEMA_TYPES).map((n) => typeObj(n));
        case 'queryType': return typeObj('Query');
        case 'mutationType': return typeObj('Mutation');
        case 'description': return null;
        default: return UNRESOLVED;
      }
    }
    default:
      return UNRESOLVED;
  }
}

function executeSelectionSet(parent: GqlObj, selections: SelectionNode[], ctx: GqlContext, fragments: Map<string, FragmentNode>, variables: Record<string, unknown>, path: Array<string | number>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragmentSpread') {
      if (!directiveApplies(sel.directives, variables)) continue;
      const frag = fragments.get(sel.name);
      if (!frag) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".`, path: [...path] });
        continue;
      }
      const sub = executeSelectionSet(parent, frag.selections, ctx, fragments, variables, path);
      Object.assign(result, sub);
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      if (!directiveApplies(sel.directives, variables)) continue;
      if (sel.typeCondition !== null && sel.typeCondition !== parent.__typename) continue;
      const sub = executeSelectionSet(parent, sel.selections, ctx, fragments, variables, path);
      Object.assign(result, sub);
      continue;
    }
    // Field.
    if (!directiveApplies(sel.directives, variables)) continue;
    const responseKey = sel.alias ?? sel.name;
    const fieldPath = [...path, responseKey];
    const args = argsMap(sel.args, variables);
    const value = resolveField(parent, sel.name, args, ctx);
    if (value === UNRESOLVED) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${parent.__typename}".`, path: fieldPath });
      result[responseKey] = null;
      continue;
    }
    if (value !== null && typeof value === 'object' && FIELD_ERROR in (value as Record<symbol, unknown>)) {
      ctx.errors.push({ message: String((value as Record<symbol, unknown>)[FIELD_ERROR]), path: fieldPath });
      result[responseKey] = null;
      continue;
    }
    if (sel.selections === null) {
      if (value !== null && typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
        ctx.errors.push({ message: `Field "${sel.name}" of type "${parent.__typename}" must have a selection of subfields.`, path: fieldPath });
        result[responseKey] = null;
      } else {
        result[responseKey] = value;
      }
      continue;
    }
    if (value === null) {
      result[responseKey] = null;
      continue;
    }
    if (Array.isArray(value)) {
      result[responseKey] = value.map((item, i) => {
        if (item === null) return null;
        if (typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
          return executeSelectionSet(item as GqlObj, sel.selections!, ctx, fragments, variables, [...fieldPath, i]);
        }
        return item;
      });
      continue;
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      result[responseKey] = executeSelectionSet(value as GqlObj, sel.selections, ctx, fragments, variables, fieldPath);
      continue;
    }
    result[responseKey] = value;
  }
  return result;
}

export interface GraphqlResult {
  status: number;
  body: string;
}

/** Run one operation document against the store. */
function runOperation(store: Store, operation: unknown): Record<string, unknown> {
  const ctx: GqlContext = { store, errors: [] };
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    return { data: null, errors: [{ message: 'each operation must be a JSON object with a query string' }] };
  }
  const op = operation as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof op.query !== 'string') {
    return { data: null, errors: [{ message: 'query is required and must be a string' }] };
  }
  let doc: DocumentNode;
  try {
    doc = new Parser(tokenize(op.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'failed to parse the query' }] };
  }
  const variables = (op.variables !== null && typeof op.variables === 'object' && !Array.isArray(op.variables))
    ? { ...(op.variables as Record<string, unknown>) }
    : {};
  let operationNode: OperationNode | undefined;
  if (typeof op.operationName === 'string') {
    operationNode = doc.operations.find((o) => o.name === op.operationName);
    if (!operationNode) return { data: null, errors: [{ message: `Unknown operation named "${op.operationName}".` }] };
  } else if (doc.operations.length === 1) {
    operationNode = doc.operations[0]!;
  } else if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'the document holds no operation' }] };
  } else {
    return { data: null, errors: [{ message: 'the document holds several operations but no operationName was given' }] };
  }
  for (const def of operationNode.variableDefinitions) {
    if (!(def.name in variables) && def.defaultValue !== null) {
      variables[def.name] = valueFromNode(def.defaultValue, variables);
    }
  }
  const root: GqlObj = obj(operationNode.kind === 'mutation' ? 'Mutation' : 'Query', null);
  const data = executeSelectionSet(root, operationNode.selections, ctx, doc.fragments, variables, []);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** POST /api/graphql — one operation or a JSON array of operations (batched). */
export function handleGraphql(store: Store, body: Buffer): GraphqlResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ data: null, errors: [{ message: 'malformed JSON body' }] }) };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((op) => runOperation(store, op));
    return { status: 200, body: JSON.stringify(results) };
  }
  return { status: 200, body: JSON.stringify(runOperation(store, parsed)) };
}
