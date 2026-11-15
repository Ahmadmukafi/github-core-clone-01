// util.ts — small shared helpers for the forge: hashing, ids, time, text.
// Node 22 stdlib only. No state lives here; everything is a pure function.

import { createHash, randomBytes } from 'node:crypto';

/** The login the trial's bearer token names (the scenario's viewer). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** SHA-1 of a Buffer, as 40 lowercase hex chars. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of a raw object: sha1("<type> <len>\0" + bytes). */
export function hashObject(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

/** A short random request id for X-GitHub-Request-Id. */
let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `${Date.now().toString(36)}-${requestCounter.toString(36)}-${randomBytes(4).toString('hex')}`;
}

/** The trial clock: MAKEFUN_TRIAL_NOW (ms) when set, else the wall clock. */
export function trialNowMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Date.now();
}

/** ISO-8601 timestamp from the trial clock. */
export function trialNowIso(): string {
  return new Date(trialNowMs()).toISOString();
}

/** Unix seconds from the trial clock (for commit objects). */
export function trialNowSec(): number {
  return Math.floor(trialNowMs() / 1000);
}

/** Base64url without padding (for opaque Relay ids and cursors). */
export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function b64urlDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** Opaque Relay global id for a repository / issue / pull request / comment. */
export function relayId(kind: string, key: string): string {
  return b64urlEncode(`${kind}:${key}`);
}

export function parseRelayId(id: string): { kind: string; key: string } | null {
  const decoded = b64urlDecode(id);
  if (decoded === null) return null;
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return { kind: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
}

/** Lowercase-hex check for a 40-char object id. */
export const OID_RE = /^[0-9a-f]{40}$/;
export const ZERO_OID = '0000000000000000000000000000000000000000';

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && OID_RE.test(value);
}

/** Split a string on the first occurrence of a separator. */
export function splitFirst(text: string, sep: string): [string, string | null] {
  const at = text.indexOf(sep);
  if (at < 0) return [text, null];
  return [text.slice(0, at), text.slice(at + sep.length)];
}

/** Count the lines in a text buffer (a trailing newline does not start a new line). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) n += 1;
  if (data[data.length - 1] !== 0x0a) n += 1;
  return n;
}
