// objects.ts — the git object model: blobs, trees, commits, tags; packfiles;
// reachability, merge-bases and tree diffs. Everything is byte-exact: objects are
// stored as the raw bytes the client pushed, never re-encoded.

import { createInflate, deflateSync } from 'node:zlib';
import { hashObject, isOid, sha1Hex } from './util.ts';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Committer timestamp (seconds), for ordering. */
  time: number;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a commit object's bytes. Throws on a malformed commit. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let time = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) {
      committer = line.slice(10);
      const m = committer.match(/ (\d+) [+-]\d{4}$/);
      if (m) time = Number(m[1]);
    }
  }
  if (!isOid(tree)) throw new Error('commit has no tree');
  return { tree, parents, author, committer, message, time };
}

/** Build a commit object's bytes. The message is stored with one trailing newline. */
export function buildCommit(info: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const p of info.parents) lines.push(`parent ${p}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  const msg = info.message.endsWith('\n') ? info.message : `${info.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
}

/** Parse a tree object's bytes into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) throw new Error('tree entry has no mode');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry truncated');
    const mode = data.toString('utf8', off, sp);
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Encode tree entries. Git sorts by name, directories as if suffixed with '/'. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tag object's bytes: {object, type, tag, tagger, message}. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; message: string } {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message };
}

// -------------------------------------------------------------------------------------------
// Packs
// -------------------------------------------------------------------------------------------

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

function typeName(code: number): ObjectType | null {
  if (code === OBJ_COMMIT) return 'commit';
  if (code === OBJ_TREE) return 'tree';
  if (code === OBJ_BLOB) return 'blob';
  if (code === OBJ_TAG) return 'tag';
  return null;
}

function typeCode(type: ObjectType): number {
  if (type === 'commit') return OBJ_COMMIT;
  if (type === 'tree') return OBJ_TREE;
  if (type === 'blob') return OBJ_BLOB;
  return OBJ_TAG;
}

/** Read a packfile's variable-length size prefix. Returns [value, bytesConsumed]. */
function readVarint(buf: Buffer, off: number): [number, number] {
  let value = buf[off] & 0x0f;
  let shift = 4;
  let n = 1;
  while (buf[off + n - 1] & 0x80) {
    value |= (buf[off + n] & 0x7f) << shift;
    shift += 7;
    n += 1;
  }
  return [value, n];
}

/** Read an OFS_DELTA base offset (git's offset encoding). */
function readOfsOffset(buf: Buffer, off: number): [number, number] {
  let byte = buf[off];
  let value = byte & 0x7f;
  let n = 1;
  while (byte & 0x80) {
    byte = buf[off + n];
    value = ((value + 1) << 7) | (byte & 0x7f);
    n += 1;
  }
  return [value, n];
}

/** Apply a git delta to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off];
      off += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readDeltaVarint();
  const targetSize = readDeltaVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} != ${base.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { copyOff |= delta[off] << (8 * i); off += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { copySize |= delta[off] << (8 * i); off += 1; }
      if (copySize === 0) copySize = 0x10000;
      if (copyOff + copySize > base.length || written + copySize > targetSize) throw new Error('delta copy out of range');
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (off + op > delta.length || written + op > targetSize) throw new Error('delta insert out of range');
      delta.copy(out, written, off, off + op);
      off += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Inflate exactly one zlib stream starting at `off`. The stream ends after the
 * first complete deflate stream; `bytesWritten` is the input the inflater consumed.
 */
function inflateOne(buf: Buffer, off: number, expectedSize: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const inf = createInflate();
    const chunks: Buffer[] = [];
    let done = false;
    inf.on('data', (c: Buffer) => chunks.push(c));
    inf.on('error', (err: Error) => {
      if (!done) { done = true; reject(err); }
    });
    inf.on('end', () => {
      if (done) return;
      done = true;
      const data = Buffer.concat(chunks);
      if (data.length !== expectedSize) {
        reject(new Error(`inflated ${data.length} bytes, expected ${expectedSize}`));
        return;
      }
      resolve({ data, consumed: (inf as unknown as { bytesWritten: number }).bytesWritten });
    });
    inf.write(buf.subarray(off));
    inf.end();
  });
}

/**
 * Read a whole packfile (version 2/3) and resolve every object, including OFS_DELTA
 * and REF_DELTA chains. `resolveBase` supplies objects the pack references from
 * outside itself (thin packs); without it a dangling delta base is an error.
 */
export async function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Promise<PackReadResult> {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // Verify the trailer checksum (SHA-1 of everything before the last 20 bytes).
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1Hex(pack.subarray(0, pack.length - 20));
  if (actual !== trailer) throw new Error(`pack trailer ${trailer} != ${actual}`);
  interface RawEntry {
    type: number;
    data: Buffer;
    baseOid?: string;
    baseOffset?: number;
    offset: number;
  }
  const raw: RawEntry[] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    const typeCode0 = (pack[off] >> 4) & 0x07;
    const [size, n] = readVarint(pack, off);
    off += n;
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeCode0 === OBJ_OFS_DELTA) {
      const [o, m] = readOfsOffset(pack, off);
      baseOffset = entryOffset - o;
      off += m;
    } else if (typeCode0 === OBJ_REF_DELTA) {
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const { data, consumed } = await inflateOne(pack, off, size);
    off += consumed;
    raw.push({ type: typeCode0, data, baseOid, baseOffset, offset: entryOffset });
  }
  // Resolve entries (deltas may chain; resolve recursively with memoisation).
  const byOffset = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  let deltaCount = 0;
  const resolveEntry = (entry: RawEntry, seen: Set<number>): GitObject => {
    const cached = byOffset.get(entry.offset);
    if (cached) return cached;
    if (seen.has(entry.offset)) throw new Error('delta cycle in pack');
    seen.add(entry.offset);
    let obj: GitObject;
    if (entry.type === OBJ_OFS_DELTA || entry.type === OBJ_REF_DELTA) {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) base = byOffset.get(entry.baseOffset) ?? resolveOffset(entry.baseOffset, seen);
      else if (entry.baseOid !== undefined) base = byOid.get(entry.baseOid) ?? resolveBase?.(entry.baseOid);
      if (!base) throw new Error('delta base not found in pack');
      const data = applyDelta(base.data, entry.data);
      obj = { type: base.type, data };
    } else {
      const type = typeName(entry.type);
      if (!type) throw new Error(`unknown pack object type ${entry.type}`);
      obj = { type, data: entry.data };
    }
    byOffset.set(entry.offset, obj);
    byOid.set(hashObject(obj.type, obj.data), obj);
    return obj;
  };
  const resolveOffset = (offset: number, seen: Set<number>): GitObject | undefined => {
    const entry = raw.find((e) => e.offset === offset);
    if (!entry) return undefined;
    return resolveEntry(entry, seen);
  };
  const objects = new Map<string, GitObject>();
  for (const entry of raw) {
    const obj = resolveEntry(entry, new Set());
    objects.set(hashObject(obj.type, obj.data), obj);
  }
  return { objects, deltaCount };
}

/** Write a packfile of plain (undelted) objects, version 2, with a SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  parts.push(head);
  for (const obj of list) {
    const code = typeCode(obj.type);
    const size = obj.data.length;
    // Type + size varint: first byte holds type in bits 4-6 and 4 size bits.
    const headerBytes: number[] = [];
    let remaining = size;
    headerBytes.push(((code & 0x07) << 4) | (remaining & 0x0f));
    remaining >>= 4;
    while (remaining > 0) {
      headerBytes[headerBytes.length - 1] |= 0x80;
      headerBytes.push(remaining & 0x7f);
      remaining >>= 7;
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

// -------------------------------------------------------------------------------------------
// Reachability, merge bases and tree diffs
// -------------------------------------------------------------------------------------------

/** Minimal read access to an object store (the store module implements this). */
export interface ObjectStore {
  getObject(oid: string): GitObject | undefined;
}

/** All commits reachable from `tips` (following parents), newest-first by time. */
export function reachableCommits(store: ObjectStore, tips: Iterable<string>): Map<string, CommitInfo> {
  const out = new Map<string, CommitInfo>();
  const queue: string[] = [...tips];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    out.set(oid, info);
    for (const p of info.parents) if (!seen.has(p)) queue.push(p);
  }
  return out;
}

/**
 * Every object reachable from `tips`: the commits, their trees (recursively) and
 * blobs, plus tag objects peeled to their targets. `stopAt` limits how deep the
 * commit walk goes: a commit at depth `stopAt` is included but its parents are
 * not traversed (shallow clones). Returns the object ids and the boundary commits.
 */
export function reachableObjects(
  store: ObjectStore,
  tips: Iterable<string>,
  opts: { stopAt?: number; exclude?: Set<string> } = {},
): { objects: Set<string>; boundary: Set<string> } {
  const objects = new Set<string>();
  const boundary = new Set<string>();
  const exclude = opts.exclude ?? new Set<string>();
  // The exclusion closure: everything reachable from the excluded tips.
  const excluded = new Set<string>();
  if (exclude.size > 0) {
    const q: string[] = [...exclude];
    while (q.length > 0) {
      const oid = q.pop()!;
      if (excluded.has(oid)) continue;
      excluded.add(oid);
      const obj = store.getObject(oid);
      if (!obj) continue;
      if (obj.type === 'commit') {
        const info = parseCommit(obj.data);
        objects.delete(oid);
        q.push(...info.parents);
        const treeObjs = collectTreeObjects(store, info.tree);
        for (const t of treeObjs) excluded.add(t);
      } else if (obj.type === 'tag') {
        q.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const t of collectTreeObjects(store, oid)) excluded.add(t);
      }
    }
  }
  const addTree = (treeOid: string): void => {
    for (const oid of collectTreeObjects(store, treeOid)) {
      if (!excluded.has(oid)) objects.add(oid);
    }
  };
  const walk: Array<{ oid: string; depth: number }> = [...tips].map((oid) => ({ oid, depth: 1 }));
  const seenCommits = new Set<string>();
  while (walk.length > 0) {
    const { oid, depth } = walk.pop()!;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const obj = store.getObject(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      if (!excluded.has(oid)) objects.add(oid);
      const target = parseTag(obj.data).object;
      const targetObj = store.getObject(target);
      if (targetObj?.type === 'commit') walk.push({ oid: target, depth });
      else if (targetObj) {
        if (targetObj.type === 'tree') addTree(target);
        else if (!excluded.has(target)) objects.add(target);
      }
      continue;
    }
    if (obj.type !== 'commit') {
      if (!excluded.has(oid)) objects.add(oid);
      continue;
    }
    const info = parseCommit(obj.data);
    if (excluded.has(oid)) {
      // Held by the client: never sent — but a shallow holder does not know
      // this commit's parents, so keep walking through it (within the depth
      // limit) instead of stopping the traversal here.
      if (opts.stopAt === undefined || depth < opts.stopAt) {
        for (const p of info.parents) walk.push({ oid: p, depth: depth + 1 });
      }
      continue;
    }
    objects.add(oid);
    addTree(info.tree);
    if (opts.stopAt !== undefined && depth >= opts.stopAt) {
      boundary.add(oid);
      continue;
    }
    for (const p of info.parents) walk.push({ oid: p, depth: depth + 1 });
  }
  return { objects, boundary };
}

/** A tree and everything under it (subtrees and blobs), as object ids. */
export function collectTreeObjects(store: ObjectStore, treeOid: string): Set<string> {
  const out = new Set<string>();
  const queue = [treeOid];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (out.has(oid)) continue;
    const obj = store.getObject(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) queue.push(e.oid);
    }
  }
  return out;
}

/** Whether `maybeAncestor` is an ancestor of (or equal to) `commit`. */
export function isAncestor(store: ObjectStore, maybeAncestor: string, commit: string): boolean {
  if (maybeAncestor === commit) return true;
  const queue = [commit];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    for (const p of info.parents) {
      if (p === maybeAncestor) return true;
      queue.push(p);
    }
  }
  return false;
}

/** A merge-base of two commits: the first common ancestor in newest-first order. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const fromA = reachableCommits(store, [a]);
  // Walk b's history newest-first; the first commit also in a's set wins.
  const queue: string[] = [b];
  const seen = new Set<string>();
  const ordered: Array<{ oid: string; time: number }> = [];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    ordered.push({ oid, time: info.time });
    for (const p of info.parents) queue.push(p);
  }
  ordered.sort((x, y) => y.time - x.time);
  for (const entry of ordered) if (fromA.has(entry.oid)) return entry.oid;
  return null;
}

/** Flatten a tree to path -> {oid, mode}. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = store.getObject(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') {
      for (const [p, v] of flattenTree(store, e.oid, path)) out.set(p, v);
    } else {
      out.set(path, { oid: e.oid, mode: e.mode });
    }
  }
  return out;
}

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}

/** The file-level diff between two trees (base -> head). */
export function diffTrees(store: ObjectStore, baseTree: string, headTree: string): FileChange[] {
  const base = flattenTree(store, baseTree);
  const head = flattenTree(store, headTree);
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const blob = store.getObject(b.oid);
      changes.push({ path, status: 'removed', additions: 0, deletions: blob ? countLinesOf(blob.data) : 0 });
    } else if (!b && h) {
      const blob = store.getObject(h.oid);
      changes.push({ path, status: 'added', additions: blob ? countLinesOf(blob.data) : 0, deletions: 0 });
    } else if (b && h && b.oid !== h.oid) {
      const oldBlob = store.getObject(b.oid);
      const newBlob = store.getObject(h.oid);
      changes.push({ path, status: 'modified', additions: newBlob ? countLinesOf(newBlob.data) : 0, deletions: oldBlob ? countLinesOf(oldBlob.data) : 0 });
    }
  }
  return changes;
}

function countLinesOf(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) n += 1;
  if (data[data.length - 1] !== 0x0a) n += 1;
  return n;
}

/**
 * Apply a set of path -> blob-oid/mode writes (null removes) onto a tree,
 * creating intermediate trees as needed. Returns the new tree's oid; new tree
 * objects are written through `put`.
 */
export function applyTreeWrites(
  store: ObjectStore,
  put: (obj: GitObject) => string,
  baseTree: string | null,
  writes: Map<string, { oid: string; mode: string } | null>,
): string {
  // Group writes by their first path segment.
  const byFirst = new Map<string, Map<string, { oid: string; mode: string } | null>>();
  const direct = new Map<string, { oid: string; mode: string } | null>();
  for (const [path, value] of writes) {
    const slash = path.indexOf('/');
    if (slash < 0) direct.set(path, value);
    else {
      const first = path.slice(0, slash);
      const rest = path.slice(slash + 1);
      let sub = byFirst.get(first);
      if (!sub) { sub = new Map(); byFirst.set(first, sub); }
      sub.set(rest, value);
    }
  }
  const baseEntries = baseTree ? parseTree(store.getObject(baseTree)?.data ?? Buffer.alloc(0)) : [];
  const entries = new Map<string, TreeEntry>();
  for (const e of baseEntries) entries.set(e.name, e);
  for (const [name, value] of direct) {
    if (value === null) entries.delete(name);
    else entries.set(name, { mode: value.mode, name, oid: value.oid });
  }
  for (const [name, sub] of byFirst) {
    const existing = entries.get(name);
    const subTree = existing && existing.mode === '40000' ? existing.oid : null;
    const newSub = applyTreeWrites(store, put, subTree, sub);
    // An emptied subtree disappears.
    const subObj = store.getObject(newSub);
    const subEntries = subObj ? parseTree(subObj.data) : [];
    if (subEntries.length === 0) entries.delete(name);
    else entries.set(name, { mode: '40000', name, oid: newSub });
  }
  const data = buildTree([...entries.values()]);
  return put({ type: 'tree', data });
}

/** Read one file's blob out of a tree (null when the path is absent or a dir). */
export function readTreePath(store: ObjectStore, treeOid: string, path: string): { oid: string; mode: string } | null {
  const flat = flattenTree(store, treeOid);
  return flat.get(path) ?? null;
}

