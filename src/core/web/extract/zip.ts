import * as zlib from 'zlib';
import { WebError } from '../types';

/**
 * Minimal read-only ZIP reader (enough for OOXML containers: docx/xlsx/pptx).
 *
 * Works from the central directory (the authoritative list) and then reads each local header, because local
 * headers may carry zeroed sizes when a data descriptor is used. Supports ZIP64, stored and deflated entries.
 * Never writes anything, so hostile entry names only need to not crash us.
 */

export interface ZipLimits {
  /** Default 5000. */
  maxEntries?: number;
  /** Total decompressed bytes across all entries. Default 100 MiB. */
  maxTotalBytes?: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
/** Compression ratio above which an entry is treated as a bomb (only once it is also large). */
const MAX_RATIO = 1000;
const RATIO_MIN_BYTES = 1024 * 1024;

/** Reads every file entry into memory. Directory entries are skipped; names use forward slashes, no leading "/". */
export function readZip(buf: Buffer, opts: ZipLimits = {}): Map<string, Buffer> {
  const maxEntries = opts.maxEntries ?? 5000;
  const maxTotal = opts.maxTotalBytes ?? 100 * 1024 * 1024;
  const eocd = findEocd(buf);
  if (eocd < 0) { throw new WebError('Not a ZIP archive (no end of central directory)', 'parse'); }
  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  // The central directory ends where the EOCD (or, for ZIP64, the EOCD64 record) begins.
  let cdEnd = eocd;
  // ZIP64: the locator sits right before the classic EOCD and points at the EOCD64 record.
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_EOCD64_LOC) {
    const stated = num64(buf, eocd - 12);
    // With a prefix (self-extractor) the stated offset is off; the record normally sits right before the locator.
    const at = [stated, eocd - 20 - 56].find((o) => o >= 0 && o + 56 <= eocd - 20 && buf.readUInt32LE(o) === SIG_EOCD64);
    if (at !== undefined) {
      count = num64(buf, at + 32);
      cdSize = num64(buf, at + 40);
      cdOffset = num64(buf, at + 48);
      cdEnd = at;
    }
  }
  if (count > maxEntries) { throw new WebError(`ZIP has ${count} entries (limit ${maxEntries})`, 'too_large'); }
  // Archives with a prefix (self-extractors) shift every offset; correct by the observed difference.
  const shift = cdOffset + cdSize <= cdEnd ? cdEnd - (cdOffset + cdSize) : 0;
  let p = cdOffset + shift;
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) { break; }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOff = buf.readUInt32LE(p + 42);
    const nameBuf = buf.subarray(p + 46, p + 46 + nameLen);
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    p += 46 + nameLen + extraLen + commentLen;
    // ZIP64 extended information: only the fields saturated in the fixed header are present, in this order.
    for (let e = 0; e + 4 <= extra.length;) {
      const id = extra.readUInt16LE(e); const len = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff && q + 8 <= e + 4 + len) { size = num64(extra, q); q += 8; }
        if (compSize === 0xffffffff && q + 8 <= e + 4 + len) { compSize = num64(extra, q); q += 8; }
        if (localOff === 0xffffffff && q + 8 <= e + 4 + len) { localOff = num64(extra, q); }
      }
      e += 4 + len;
    }
    const name = normName(nameBuf, (flags & 0x800) !== 0);
    if (!name || name.endsWith('/')) { continue; }
    if (flags & 0x1) { throw new WebError(`ZIP entry "${name}" is encrypted`, 'unsupported'); }
    if (size > RATIO_MIN_BYTES && compSize > 0 && size / compSize > MAX_RATIO) {
      throw new WebError(`ZIP entry "${name}" has a suspicious compression ratio`, 'too_large');
    }
    if (total + size > maxTotal) { throw new WebError(`ZIP content exceeds ${maxTotal} bytes`, 'too_large'); }
    const lp = localOff + shift;
    if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== SIG_LOC) { continue; }
    const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    const raw = buf.subarray(start, Math.min(buf.length, start + compSize));
    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      data = inflate(raw, maxTotal - total, name);
      // Declared sizes can lie, so check the ratio again on what actually came out.
      if (data.length > RATIO_MIN_BYTES && data.length / Math.max(1, raw.length) > MAX_RATIO) {
        throw new WebError(`ZIP entry "${name}" has a suspicious compression ratio`, 'too_large');
      }
    } else {
      continue; // unsupported compression (bzip2, lzma…): skip the entry rather than fail the whole archive
    }
    total += data.length;
    if (total > maxTotal) { throw new WebError(`ZIP content exceeds ${maxTotal} bytes`, 'too_large'); }
    out.set(name, data);
  }
  return out;
}

/** Deflate with a hard output cap (declared sizes can lie). Truncated streams yield what decodes. */
function inflate(raw: Buffer, budget: number, name: string): Buffer {
  const maxOutputLength = Math.max(1, budget + 1);
  try {
    return zlib.inflateRawSync(raw, { maxOutputLength });
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') { throw new WebError(`ZIP entry "${name}" is too large`, 'too_large'); }
    try { return zlib.inflateRawSync(raw, { maxOutputLength, finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { return Buffer.alloc(0); }
  }
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf[i] === 0x50 && buf.readUInt32LE(i) === SIG_EOCD) { return i; }
  }
  return -1;
}

function num64(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off) + buf.readUInt32LE(off + 4) * 0x100000000;
}

function normName(b: Buffer, utf8: boolean): string {
  const s = utf8 ? b.toString('utf8') : b.toString('latin1');
  return s.replace(/\\/g, '/').replace(/^\/+/, '');
}
