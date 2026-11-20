import * as zlib from 'zlib';

/**
 * PDF object model, lexer/parser and stream filters (ISO 32000-1 §7.2–7.4).
 *
 * The lexer is deliberately forgiving: real-world files contain stray bytes, unbalanced delimiters and bogus
 * numbers, and a reader that throws on them shows the user nothing at all.
 */

export class PName {
  private static readonly cache = new Map<string, PName>();
  private constructor(readonly name: string) {}
  /** Names are interned so they compare with ===. */
  static of(name: string): PName {
    let n = PName.cache.get(name);
    if (!n) { n = new PName(name); if (PName.cache.size < 50_000) { PName.cache.set(name, n); } }
    return n;
  }
}

export class PStr { constructor(public bytes: Buffer) {} }
export class PRef { constructor(readonly num: number, readonly gen: number) {} }
export class POp { constructor(readonly op: string) {} }

export class PDict {
  readonly map = new Map<string, PObj>();
  get(key: string): PObj | undefined { return this.map.get(key); }
}

export class PStream {
  /** Object number and generation, needed for decryption. 0 for inline / object-stream members. */
  num = 0; gen = 0;
  constructor(readonly dict: PDict, public raw: Buffer) {}
}

export type PObj = number | boolean | null | PName | PStr | PRef | PDict | PStream | PObj[];

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) { WS[c] = 1; }
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') { DELIM[c.charCodeAt(0)] = 1; }

export function isWs(c: number): boolean { return WS[c] === 1; }
export function isRegular(c: number): boolean { return !WS[c] && !DELIM[c]; }

/** A token: a primitive object, a keyword/delimiter (POp) or undefined at end of input. */
export type Token = number | PName | PStr | POp | undefined;

export class Lexer {
  constructor(readonly buf: Buffer, public pos = 0) {}

  skipWs(): void {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (WS[c]) { this.pos++; continue; }
      if (c === 0x25) { while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) { this.pos++; } continue; }
      break;
    }
  }

  next(): Token {
    this.skipWs();
    const b = this.buf;
    if (this.pos >= b.length) { return undefined; }
    const c = b[this.pos];
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) { return this.number(); }
    switch (c) {
      case 0x2f: return this.name();
      case 0x28: return this.literal();
      case 0x3c:
        if (b[this.pos + 1] === 0x3c) { this.pos += 2; return OP_DICT_OPEN; }
        return this.hex();
      case 0x3e:
        if (b[this.pos + 1] === 0x3e) { this.pos += 2; return OP_DICT_CLOSE; }
        this.pos++; return OP_JUNK;
      case 0x5b: this.pos++; return OP_ARR_OPEN;
      case 0x5d: this.pos++; return OP_ARR_CLOSE;
      case 0x7b: this.pos++; return OP_BRACE_OPEN;
      case 0x7d: this.pos++; return OP_BRACE_CLOSE;
      case 0x29: this.pos++; return OP_JUNK;
    }
    const start = this.pos;
    while (this.pos < b.length && isRegular(b[this.pos])) { this.pos++; }
    return keyword(b.toString('latin1', start, this.pos));
  }

  private number(): number | POp {
    const b = this.buf; const start = this.pos;
    let seenDigit = false;
    this.pos++;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if ((c >= 0x30 && c <= 0x39) || c === 0x2e || ((c === 0x2d || c === 0x2b) && !seenDigit)) { seenDigit ||= c >= 0x30; this.pos++; } else { break; }
    }
    // Run-on garbage like "12abc" is a keyword, not a number.
    if (this.pos < b.length && isRegular(b[this.pos])) {
      while (this.pos < b.length && isRegular(b[this.pos])) { this.pos++; }
      return keyword(b.toString('latin1', start, this.pos));
    }
    const s = b.toString('latin1', start, this.pos).replace(/(?!^)[-+]/g, '');
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : 0;
  }

  private name(): PName {
    const b = this.buf; this.pos++;
    const bytes: number[] = [];
    while (this.pos < b.length && isRegular(b[this.pos])) {
      const c = b[this.pos];
      if (c === 0x23 && this.pos + 2 < b.length) {
        const h1 = hexVal(b[this.pos + 1]); const h2 = hexVal(b[this.pos + 2]);
        if (h1 >= 0 && h2 >= 0) { bytes.push(h1 * 16 + h2); this.pos += 3; continue; }
      }
      bytes.push(c); this.pos++;
    }
    return PName.of(Buffer.from(bytes).toString('latin1'));
  }

  private literal(): PStr {
    const b = this.buf; this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      let c = b[this.pos++];
      if (c === 0x5c) {
        if (this.pos >= b.length) { break; }
        c = b[this.pos++];
        switch (c) {
          case 0x6e: out.push(10); break;
          case 0x72: out.push(13); break;
          case 0x74: out.push(9); break;
          case 0x62: out.push(8); break;
          case 0x66: out.push(12); break;
          case 0x0d: if (b[this.pos] === 0x0a) { this.pos++; } break; // line continuation
          case 0x0a: break;
          default:
            if (c >= 0x30 && c <= 0x37) {
              let v = c - 0x30;
              for (let k = 0; k < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; k++) { v = v * 8 + b[this.pos++] - 0x30; }
              out.push(v & 0xff);
            } else {
              out.push(c); // \( \) \\ and unknown escapes: the character itself
            }
        }
        continue;
      }
      if (c === 0x28) { depth++; } else if (c === 0x29 && --depth === 0) { break; }
      out.push(c);
    }
    return new PStr(Buffer.from(out));
  }

  private hex(): PStr {
    const b = this.buf; this.pos++;
    const out: number[] = [];
    let hi = -1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x3e) { break; }
      const v = hexVal(c);
      if (v < 0) { continue; }
      if (hi < 0) { hi = v; } else { out.push(hi * 16 + v); hi = -1; }
    }
    if (hi >= 0) { out.push(hi * 16); }
    return new PStr(Buffer.from(out));
  }
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) { return c - 0x30; }
  if (c >= 0x41 && c <= 0x46) { return c - 0x37; }
  if (c >= 0x61 && c <= 0x66) { return c - 0x57; }
  return -1;
}

const KEYWORDS = new Map<string, POp>();
function keyword(s: string): POp {
  let k = KEYWORDS.get(s);
  if (!k) { k = new POp(s); if (KEYWORDS.size < 5000) { KEYWORDS.set(s, k); } }
  return k;
}
const OP_DICT_OPEN = keyword('<<');
const OP_DICT_CLOSE = keyword('>>');
const OP_ARR_OPEN = keyword('[');
const OP_ARR_CLOSE = keyword(']');
const OP_BRACE_OPEN = keyword('{');
const OP_BRACE_CLOSE = keyword('}');
const OP_JUNK = keyword('');

const MAX_DEPTH = 64;

/**
 * Parses one object starting at the lexer position. With `refs`, "N G R" becomes a PRef (object syntax); content
 * streams pass false. Keywords that are not objects are returned as POp so callers can see "obj", "stream" or operators.
 */
export function parseObject(lex: Lexer, refs: boolean, depth = 0, first?: Token): PObj | POp | undefined {
  const t = first !== undefined ? first : lex.next();
  if (t === undefined) { return undefined; }
  if (typeof t === 'number') {
    if (refs && Number.isInteger(t) && t >= 0) {
      const save = lex.pos;
      const g = lex.next();
      if (typeof g === 'number' && Number.isInteger(g) && g >= 0) {
        const r = lex.next();
        if (r instanceof POp && r.op === 'R') { return new PRef(t, g); }
      }
      lex.pos = save;
    }
    return t;
  }
  if (!(t instanceof POp)) { return t; }
  switch (t.op) {
    case 'true': return true;
    case 'false': return false;
    case 'null': return null;
    case '[': {
      const arr: PObj[] = [];
      if (depth > MAX_DEPTH) { return arr; }
      for (;;) {
        const n = lex.next();
        if (n === undefined || (n instanceof POp && n.op === ']')) { break; }
        if (n instanceof POp && (n.op === '>>' || n.op === 'endobj' || n.op === 'stream')) { lex.pos -= n.op.length; break; }
        const v = parseObject(lex, refs, depth + 1, n);
        if (v !== undefined && !(v instanceof POp)) { arr.push(v); }
      }
      return arr;
    }
    case '<<': {
      const d = new PDict();
      if (depth > MAX_DEPTH) { return d; }
      for (;;) {
        const k = lex.next();
        if (k === undefined || (k instanceof POp && k.op === '>>')) { break; }
        if (k instanceof POp && (k.op === 'endobj' || k.op === 'stream' || k.op === 'ID')) { lex.pos -= k.op.length; break; }
        if (!(k instanceof PName)) { continue; } // junk where a key should be
        const save = lex.pos;
        const v = parseObject(lex, refs, depth + 1);
        if (v instanceof POp) {
          if (v.op === '>>' || v.op === 'endobj' || v.op === 'stream') { lex.pos = save; continue; }
          d.map.set(k.name, null);
          continue;
        }
        if (v === undefined) { break; }
        d.map.set(k.name, v);
      }
      return d;
    }
  }
  return t;
}

/* ------------------------------------------------------------------ filters */

/** Shared budget of decoded bytes for one document. */
export interface DecodeBudget { left: number; exhausted: boolean }

const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode', 'CCF']);

/** Runs the filter chain. Returns null for image codecs (no text inside) or when the budget is exhausted. */
export function applyFilters(data: Buffer, filters: string[], parms: Array<PDict | null>, budget: DecodeBudget): Buffer | null {
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i]; const p = parms[i] ?? null;
    if (IMAGE_FILTERS.has(f)) { return null; }
    switch (f) {
      case 'FlateDecode': case 'Fl': data = predict(inflate(data, budget), p); break;
      case 'LZWDecode': case 'LZW': data = predict(lzw(data, numParm(p, 'EarlyChange', 1), budget), p); break;
      case 'ASCIIHexDecode': case 'AHx': data = asciiHex(data); break;
      case 'ASCII85Decode': case 'A85': data = ascii85(data); break;
      case 'RunLengthDecode': case 'RL': data = runLength(data, budget); break;
      case 'Crypt': break; // decryption already happened (Identity or the document default)
      default: return null;
    }
    if (budget.exhausted) { return null; }
  }
  budget.left -= data.length;
  if (budget.left < 0) { budget.exhausted = true; return null; }
  return data;
}

function numParm(p: PDict | null, key: string, dflt: number): number {
  const v = p?.get(key);
  return typeof v === 'number' ? v : dflt;
}

function inflate(data: Buffer, budget: DecodeBudget): Buffer {
  const maxOutputLength = Math.max(1, budget.left);
  const tooBig = (e: unknown) => (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE';
  const sync = { maxOutputLength, finishFlush: zlib.constants.Z_SYNC_FLUSH };
  const attempts: Array<() => Buffer> = [
    () => zlib.inflateSync(data, { maxOutputLength }),
    () => zlib.inflateRawSync(data, { maxOutputLength }),
    () => zlib.inflateSync(data, sync),
    () => zlib.inflateRawSync(data, sync),
  ];
  for (const a of attempts) {
    try { return a(); } catch (e) { if (tooBig(e)) { budget.exhausted = true; return Buffer.alloc(0); } }
  }
  return Buffer.alloc(0);
}

/** PNG (Predictor ≥ 10) and TIFF (Predictor 2) predictors, as used by xref streams and some images. */
function predict(data: Buffer, p: PDict | null): Buffer {
  const pred = numParm(p, 'Predictor', 1);
  if (pred < 2) { return data; }
  const colors = numParm(p, 'Colors', 1);
  const bpc = numParm(p, 'BitsPerComponent', 8);
  const columns = numParm(p, 'Columns', 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((columns * colors * bpc) / 8);
  if (rowLen <= 0) { return data; }
  if (pred === 2) {
    if (bpc !== 8) { return data; }
    const out = Buffer.from(data);
    for (let r = 0; r + rowLen <= out.length; r += rowLen) {
      for (let i = bpp; i < rowLen; i++) { out[r + i] = (out[r + i] + out[r + i - bpp]) & 0xff; }
    }
    return out;
  }
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const row = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prev[i];
      const ul = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      switch (type) {
        case 1: v += left; break;
        case 2: v += up; break;
        case 3: v += (left + up) >> 1; break;
        case 4: {
          const pa = Math.abs(up - ul); const pb = Math.abs(left - ul); const pc = Math.abs(left + up - 2 * ul);
          v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
          break;
        }
      }
      row[i] = v & 0xff;
    }
    prev = row;
  }
  return out;
}

function asciiHex(data: Buffer): Buffer {
  const out: number[] = [];
  let hi = -1;
  for (const c of data) {
    if (c === 0x3e) { break; }
    const v = hexVal(c);
    if (v < 0) { continue; }
    if (hi < 0) { hi = v; } else { out.push(hi * 16 + v); hi = -1; }
  }
  if (hi >= 0) { out.push(hi * 16); }
  return Buffer.from(out);
}

function ascii85(data: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) { i = 2; }
  const group: number[] = [];
  for (; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) { break; }
    if (WS[c]) { continue; }
    if (c === 0x7a && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    if (c < 0x21 || c > 0x75) { continue; }
    group.push(c - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) { v = v * 85 + g; }
      out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
      group.length = 0;
    }
  }
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) { group.push(84); }
    let v = 0;
    for (const g of group) { v = v * 85 + g; }
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    out.push(...bytes.slice(0, n - 1));
  }
  return Buffer.from(out);
}

function lzw(data: Buffer, earlyChange: number, budget: DecodeBudget): Buffer {
  const chunks: Buffer[] = [];
  let out = Buffer.alloc(Math.max(1024, data.length * 3)); let olen = 0;
  const push = (seq: Uint8Array) => {
    if (olen + seq.length > out.length) {
      if (olen + seq.length > budget.left) { budget.exhausted = true; return false; }
      const n = Buffer.alloc(Math.max(out.length * 2, olen + seq.length)); out.copy(n, 0, 0, olen); out = n;
    }
    out.set(seq, olen); olen += seq.length;
    return true;
  };
  let dict: Uint8Array[] = [];
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) { dict.push(Uint8Array.of(i)); } dict.push(new Uint8Array(0), new Uint8Array(0)); };
  reset();
  let width = 9; let bitBuf = 0; let bits = 0; let prev: Uint8Array | null = null;
  for (let i = 0; i < data.length; i++) {
    bitBuf = ((bitBuf << 8) | data[i]) >>> 0; bits += 8;
    while (bits >= width) {
      const code = (bitBuf >>> (bits - width)) & ((1 << width) - 1);
      bits -= width;
      bitBuf &= (1 << bits) - 1;
      if (code === 256) { reset(); width = 9; prev = null; continue; }
      if (code === 257) { chunks.push(out.subarray(0, olen)); return Buffer.concat(chunks); }
      let entry: Uint8Array;
      if (code < dict.length) { entry = dict[code]; } else if (prev) { entry = concat1(prev, prev[0]); } else { continue; }
      if (!push(entry)) { return out.subarray(0, olen); }
      if (prev && dict.length < 4096) { dict.push(concat1(prev, entry[0])); }
      prev = entry;
      const next = dict.length + earlyChange;
      width = next >= 2048 ? 12 : next >= 1024 ? 11 : next >= 512 ? 10 : 9;
    }
  }
  return out.subarray(0, olen);
}

function concat1(a: Uint8Array, b: number): Uint8Array {
  const r = new Uint8Array(a.length + 1); r.set(a); r[a.length] = b; return r;
}

function runLength(data: Buffer, budget: DecodeBudget): Buffer {
  const out: number[] = [];
  for (let i = 0; i < data.length;) {
    const n = data[i++];
    if (n === 128) { break; }
    if (n < 128) { for (let k = 0; k <= n && i < data.length; k++) { out.push(data[i++]); } } else { const b = data[i++]; for (let k = 0; k < 257 - n; k++) { out.push(b); } }
    if (out.length > budget.left) { budget.exhausted = true; break; }
  }
  return Buffer.from(out);
}
