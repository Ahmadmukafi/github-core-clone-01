// pkt.ts — git pkt-line framing (protocol v0 and v2 share this wire).
// A pkt-line is a 4-hex-digit length (itself included) plus the payload.
// "0000" is a flush packet, "0001" a delim packet. The largest packet is 65520 bytes.

export type PktKind = 'data' | 'flush' | 'delim';

export interface Pkt {
  kind: PktKind;
  /** The payload without the 4-byte length prefix (empty for flush/delim). */
  payload: Buffer;
}

export const PKT_MAX = 65520;

/** Encode one data packet (payload must fit in a single pkt-line). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length + 4 > PKT_MAX) throw new Error(`pkt-line payload too large: ${body.length}`);
  const head = Buffer.alloc(4);
  head.write((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Encode a list of lines (strings) plus 'flush' / 'delim' markers into one buffer. */
export function encodePktLines(lines: Array<string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode pkt-lines up to and including the first flush packet, and answer the
 * byte offset where the raw data after it starts (a receive-pack's pack bytes).
 * Throws on truncation or a bad length before the flush. */
export function decodePktLinesUntilFlush(buf: Buffer): { packets: Pkt[]; restOffset: number } {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pkt-line truncated at length prefix');
    const head = buf.toString('ascii', off, off + 4);
    if (head === '0000') {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets: out, restOffset: off + 4 };
    }
    if (head === '0001') {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)} at offset ${off}`);
    }
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets: out, restOffset: off };
}

/** Decode a whole buffer of pkt-lines. Throws on truncation or a bad length. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pkt-line truncated at length prefix');
    const head = buf.toString('ascii', off, off + 4);
    if (head === '0000') {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (head === '0001') {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)} at offset ${off}`);
    }
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

/** Split decoded packets into text lines (each data payload as a UTF-8 string). */
export function pktTextLines(packets: Pkt[]): string[] {
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
  }
  return lines;
}

/**
 * Frame a byte stream as sideband packets (band 1 = data, 2 = progress, 3 = error).
 * Each packet carries at most 65515 payload bytes after the band byte.
 */
export function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = PKT_MAX - 5; // 4 length bytes + 1 band byte
  if (data.length === 0) {
    out.push(pktLine(Buffer.from([band])));
    return out;
  }
  for (let off = 0; off < data.length; off += CHUNK) {
    const slice = data.subarray(off, Math.min(data.length, off + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return out;
}
