// git-http.ts — git smart HTTP: info/refs advertisements, upload-pack (protocol
// v2 and v0) and receive-pack (v0). The wire shapes here are exactly the ones the
// suite's git client speaks: pkt-line framing, sideband-64k packfiles, report-status.

import { decodePktLines, decodePktLinesUntilFlush, encodePktLines, pktLine, sidebandPackets, PKT_DELIM, PKT_FLUSH } from './pkt.ts';
import {
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  reachableObjects,
  writePack,
  type GitObject,
} from './objects.ts';
import { ZERO_OID, hashObject } from './util.ts';
import type { Repo, Store } from './store.ts';

const UPLOAD_CAPS_V2 = ['agent=forge/1.0', 'ls-refs', 'fetch=shallow', 'object-format=sha1'];
const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow multi_ack agent=forge/1.0 symref=HEAD:refs/heads/main';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs agent=forge/1.0 symref=HEAD:refs/heads/main';

export interface GitContext {
  store: Store;
}

function sortedRefs(repo: Repo): Array<{ oid: string; name: string }> {
  const out: Array<{ oid: string; name: string }> = [];
  for (const [name, oid] of [...repo.refs.entries()].sort()) out.push({ oid, name });
  return out;
}

/** The v0 ref advertisement lines for a service (HEAD first, then branches, tags). */
function v0RefLines(repo: Repo): string[] {
  const lines: string[] = [];
  const main = repo.refs.get('refs/heads/main');
  const refs = sortedRefs(repo);
  if (main === undefined && refs.length === 0) return lines; // caller adds capabilities^{}
  if (main !== undefined) lines.push(`${main} HEAD`);
  for (const ref of refs) {
    if (ref.name === 'refs/heads/main') continue;
    lines.push(`${ref.oid} ${ref.name}`);
    if (ref.name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(ref.oid);
      if (obj && obj.type === 'tag') {
        const target = parseTag(obj.data).object;
        lines.push(`${target} ${ref.name}^{}`);
      }
    }
  }
  if (main !== undefined) {
    // refs/heads/main itself, after HEAD.
    lines.splice(1, 0, `${main} refs/heads/main`);
  }
  return lines;
}

function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const lines = v0RefLines(repo);
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, i) => {
      parts.push(pktLine(i === 0 ? `${line}\0${caps}\n` : `${line}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertisementV2(): Buffer {
  const parts: Buffer[] = [pktLine('version 2\n')];
  for (const cap of UPLOAD_CAPS_V2) parts.push(pktLine(`${cap}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(repo: Repo, service: string, gitProtocol: string | null): { status: number; contentType: string; body: Buffer } {
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertisementV0(repo, 'git-receive-pack') };
  }
  if (service !== 'git-upload-pack') {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: `unknown service ${service}` })) };
  }
  if (gitProtocol === '2' || gitProtocol === 'version=2' || (gitProtocol !== null && gitProtocol.includes('version=2'))) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisementV2() };
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisementV0(repo, 'git-upload-pack') };
}

// -------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

/** The object set a fetch must send, with its shallow boundary information. */
function computeFetch(
  repo: Repo,
  args: FetchArgs,
): { objects: GitObject[]; shallow: string[]; unshallow: string[]; acks: string[] } {
  const store = { getObject: (oid: string) => repo.objects.get(oid) };
  const wants = args.wants.filter((w) => repo.objects.has(w));
  // Exclusion: what the client already holds. A have that is also an old shallow
  // boundary excludes only itself and its tree (its parents are unknown to the
  // client); any other have excludes its full closure.
  const exclude = new Set<string>();
  const shallowSet = new Set(args.shallow);
  for (const have of args.haves) {
    const obj = repo.objects.get(have);
    if (!obj) continue;
    if (shallowSet.has(have)) {
      exclude.add(have);
      if (obj.type === 'commit') {
        const tree = parseCommit(obj.data).tree;
        const stack = [tree];
        while (stack.length > 0) {
          const t = stack.pop()!;
          const tobj = repo.objects.get(t);
          if (!tobj) continue;
          exclude.add(t);
          if (tobj.type === 'tree') for (const e of parseTree(tobj.data)) stack.push(e.oid);
        }
      } else if (obj.type === 'tag') {
        exclude.add(parseTag(obj.data).object);
      }
    } else {
      const { objects } = reachableObjects(store, [have]);
      for (const oid of objects) exclude.add(oid);
    }
  }
  const { objects, boundary } = reachableObjects(store, wants, {
    stopAt: args.depth ?? undefined,
  });
  // Subtract what the client already holds. The walk itself runs unexcluded:
  // a shallow holder does not know an old boundary's parents, so the walk must
  // travel through the boundary to reach them — the exclusion is a set
  // subtraction on the result, never a stop sign for the traversal.
  for (const oid of exclude) objects.delete(oid);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (args.depth !== null) {
    for (const b of boundary) shallow.push(b);
    // An old boundary that is now interior (its parents are included) unshallows.
    for (const old of args.shallow) {
      if (boundary.has(old)) continue;
      const obj = repo.objects.get(old);
      if (!obj || obj.type !== 'commit') continue;
      // Interior when the old boundary itself was walked (it is a want's ancestor
      // within the new depth) — i.e. it is reachable from a want at depth < depth.
      const walked = reachableObjects(store, wants, { stopAt: args.depth }).objects;
      if (walked.has(old)) unshallow.push(old);
    }
  }
  // Acknowledgments: the first have that is an ancestor-or-equal of a want.
  const acks: string[] = [];
  for (const have of args.haves) {
    if (wants.some((w) => isAncestor(store, have, w))) {
      acks.push(have);
      break;
    }
  }
  const list: GitObject[] = [];
  for (const oid of objects) {
    const obj = repo.objects.get(oid);
    if (obj) list.push(obj);
  }
  // Deterministic pack order: commits, then trees, then blobs, then tags, by oid.
  const rank = (t: string): number => (t === 'commit' ? 0 : t === 'tree' ? 1 : t === 'blob' ? 2 : 3);
  list.sort((a, b) => {
    const ra = rank(a.type);
    const rb = rank(b.type);
    if (ra !== rb) return ra - rb;
    return hashOf(a) < hashOf(b) ? -1 : 1;
  });
  return { objects: list, shallow, unshallow, acks };
}

function hashOf(obj: GitObject): string {
  return hashObject(obj.type, obj.data);
}

/** POST /{owner}/{repo}.git/git-upload-pack — v2 ls-refs / fetch, or a v0 fetch. */
export async function handleUploadPack(
  repo: Repo,
  body: Buffer,
): Promise<{ status: number; contentType: string; body: Buffer }> {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line stream' })) };
  }
  const first = packets.find((p) => p.kind === 'data');
  const firstText = first ? first.payload.toString('utf8') : '';
  if (firstText.startsWith('command=')) {
    const command = firstText.slice('command='.length).trim();
    if (command === 'ls-refs') return handleLsRefs(repo, packets);
    if (command === 'fetch') return handleFetchV2(repo, packets);
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: `unknown command ${command}` })) };
  }
  return handleFetchV0(repo, packets);
}

function parseV2Args(packets: ReturnType<typeof decodePktLines>): string[] {
  // Args follow the delim packet up to the flush.
  const args: string[] = [];
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') { afterDelim = true; continue; }
    if (p.kind === 'flush') break;
    if (afterDelim && p.kind === 'data') args.push(p.payload.toString('utf8').trim());
  }
  return args;
}

function handleLsRefs(repo: Repo, packets: ReturnType<typeof decodePktLines>): { status: number; contentType: string; body: Buffer } {
  const args = parseV2Args(packets);
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const prefixes: string[] = [];
  for (const a of args) if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const main = repo.refs.get('refs/heads/main');
  if (main !== undefined && keep('HEAD')) {
    lines.push(`${main} HEAD${wantSymrefs ? ' symref-target:refs/heads/main' : ''}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantPeel && ref.name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(ref.oid);
      if (obj && obj.type === 'tag') line += ` peeled:${parseTag(obj.data).object}`;
    }
    lines.push(`${line}\n`);
  }
  const parts = lines.map((l) => pktLine(l));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

async function handleFetchV2(repo: Repo, packets: ReturnType<typeof decodePktLines>): Promise<{ status: number; contentType: string; body: Buffer }> {
  const args = parseV2Args(packets);
  const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
  for (const a of args) {
    if (a.startsWith('want ')) fetchArgs.wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) fetchArgs.haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) fetchArgs.shallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) fetchArgs.depth = Number(a.slice(7).trim());
    else if (a.startsWith('deepen-since ')) fetchArgs.deepenSince = Number(a.slice(13).trim());
    else if (a.startsWith('deepen-not ')) fetchArgs.deepenNot.push(a.slice(11).trim());
  }
  const { objects, shallow, unshallow, acks } = computeFetch(repo, fetchArgs);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  // The acknowledgments section exists only when the client sent haves: with
  // no haves there is nothing to acknowledge, and a real git client that sent
  // `done` with no haves expects the packfile section straight away (a stray
  // acknowledgments section makes it die with "expected 'packfile'").
  if (fetchArgs.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (acks.length > 0) {
      for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_DELIM);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (const p of sidebandPackets(pack, 1)) parts.push(p);
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

async function handleFetchV0(repo: Repo, packets: ReturnType<typeof decodePktLines>): Promise<{ status: number; contentType: string; body: Buffer }> {
  const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
  let seenFlush = false;
  for (const p of packets) {
    if (p.kind === 'flush') { seenFlush = true; continue; }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8');
    const nul = line.indexOf('\0');
    const text = (nul >= 0 ? line.slice(0, nul) : line).trim();
    if (!seenFlush) {
      if (text.startsWith('want ')) {
        const rest = text.slice(5).trim();
        fetchArgs.wants.push(rest.split(' ')[0]);
      } else if (text.startsWith('shallow ')) fetchArgs.shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) fetchArgs.depth = Number(text.slice(7).trim());
      else if (text.startsWith('deepen-since ')) fetchArgs.deepenSince = Number(text.slice(13).trim());
      else if (text.startsWith('deepen-not ')) fetchArgs.deepenNot.push(text.slice(11).trim());
    } else {
      if (text.startsWith('have ')) fetchArgs.haves.push(text.slice(5).trim());
    }
  }
  const { objects, shallow, unshallow, acks } = computeFetch(repo, fetchArgs);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  if (acks.length > 0) {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  for (const p of sidebandPackets(pack, 1)) parts.push(p);
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack — unpack, apply ref updates, report. */
export async function handleReceivePack(
  repo: Repo,
  body: Buffer,
): Promise<{ status: number; contentType: string; body: Buffer }> {
  let parsed;
  try {
    // Only the command lines are pkt-lines: everything after the flush is the
    // pack itself, raw binary that must never be pkt-parsed.
    parsed = decodePktLinesUntilFlush(body);
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line stream' })) };
  }
  const commands: PushCommand[] = [];
  for (const p of parsed.packets) {
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).trim();
    const m = line.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
    if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  const packBytes = body.subarray(parsed.restOffset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const { objects } = await readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }
  const reportLines: string[] = [];
  reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
  if (unpackOk) {
    const store = { getObject: (oid: string) => repo.objects.get(oid) };
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      let verdict: string | null = null; // null = ok
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) verdict = 'no such ref';
        else if (current !== cmd.oldOid) verdict = 'old value mismatch';
      } else if (!repo.objects.has(cmd.newOid)) {
        verdict = 'missing object';
      } else if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined) verdict = 'already exists';
      } else if (current === undefined) {
        verdict = 'no such ref';
      } else if (current !== cmd.oldOid) {
        verdict = 'old value mismatch';
      } else if (cmd.ref.startsWith('refs/heads/')) {
        // Fast-forward only for branches.
        if (!isAncestor(store, cmd.oldOid, cmd.newOid)) verdict = 'non-fast-forward';
      }
      if (verdict === null) {
        if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
        else repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}\n`);
      } else {
        reportLines.push(`ng ${cmd.ref} ${verdict}\n`);
      }
    }
  } else {
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpack failed\n`);
  }
  // The report is itself a pkt-line stream inside band 1, so it ends with its
  // own flush packet; a second flush then terminates the sideband stream.
  // (Without the inner flush, a real git client reads the two report lines and
  // then hits EOF waiting for the report's terminator: "remote end hung up".)
  const report = encodePktLines([...reportLines, 'flush']);
  const parts = [...sidebandPackets(report, 1), PKT_FLUSH];
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
}
