import { DocLink, ExtractedDoc, WebError } from '../types';
import { CryptMethod, EncryptParams, PdfDecryptor } from './pdfCrypt';
import { FontEnv, nameOf, PdfFont, textString } from './pdfFonts';
import { applyFilters, DecodeBudget, isWs, Lexer, parseObject, PDict, PName, PObj, POp, PRef, PStr, PStream } from './pdfObjects';

/**
 * PDF → Markdown text extraction, dependency-free.
 *
 * The file is recovered by scanning for "N G obj" rather than trusting the xref table (often broken in the wild),
 * then object streams are expanded, the page tree is walked, and each page's content stream is interpreted just far
 * enough to place every text run on the page. A layout pass rebuilds lines, columns and paragraphs from positions.
 */

const MAX_PAGES = 2000;
const MAX_DECODED_BYTES = 200 * 1024 * 1024;
const MAX_OPS = 8_000_000;
const TIME_BUDGET_MS = 10_000;
const MAX_FORM_DEPTH = 12;
const PAGE_SEP = (n: number) => `<!-- page ${n} -->`;

const W_ENCRYPTED = 'This PDF is encrypted and its text could not be read';
const W_SCANNED = 'No text layer: this looks like a scanned PDF (OCR it instead)';
const W_BUDGET = 'PDF processing stopped early (size or time budget reached); later content is missing';

type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function toMat(o: PObj | undefined): Mat | null {
  if (!Array.isArray(o) || o.length < 6 || !o.slice(0, 6).every((v) => typeof v === 'number')) { return null; }
  return o.slice(0, 6) as Mat;
}

interface Entry { gen: number; obj: PObj; pos: number }

/** One text run placed on the page (user space, before rotation normalisation). */
interface Run { ox: number; oy: number; ex: number; ey: number; size: number; dir: number; text: string }

interface Page { dict: PDict; res?: PDict; box: number[] }

class PdfReader implements FontEnv {
  readonly objs = new Map<number, Entry>();
  readonly warnings: string[] = [];
  private readonly trailers: Array<{ pos: number; dict: PDict }> = [];
  private readonly compressedIn = new Map<number, { stm: number; pos: number }>();
  private readonly budget: DecodeBudget = { left: MAX_DECODED_BYTES, exhausted: false };
  private readonly decoded = new Map<PStream, Buffer | null>();
  private readonly fonts = new Map<PDict, PdfFont | null>();
  private readonly deadline = Date.now() + TIME_BUDGET_MS;
  private crypt: PdfDecryptor | null = null;
  private ops = 0;
  private damaged = 0;
  stopped = false;
  trailer = new PDict();
  unmappedFonts = false;

  constructor(private readonly buf: Buffer) {}

  warn(w: string): void { if (!this.warnings.includes(w)) { this.warnings.push(w); } }

  resolve(o: PObj | undefined): PObj | undefined {
    for (let i = 0; i < 16 && o instanceof PRef; i++) { o = this.objs.get(o.num)?.obj ?? null; }
    return o instanceof PRef ? null : o;
  }

  dict(o: PObj | undefined): PDict | undefined {
    const v = this.resolve(o);
    return v instanceof PDict ? v : v instanceof PStream ? v.dict : undefined;
  }

  /* -------------------------------------------------------------- loading */

  /** Returns false when the file is encrypted with a password we cannot supply. */
  load(): boolean {
    this.scan();
    for (const { pos, dict } of this.trailers.sort((a, b) => a.pos - b.pos)) {
      for (const [k, v] of dict.map) { this.trailer.map.set(k, v); }
      void pos;
    }
    const ok = this.setupEncryption();
    this.expandObjectStreams();
    if (this.damaged) { this.warn(`Recovered a damaged PDF: ${this.damaged} unreadable object(s) or stream(s) were skipped`); }
    return ok;
  }

  /** Finds every "N G obj … endobj" in file order. Later definitions win (incremental updates append). */
  private scan(): void {
    const s = this.buf.toString('latin1');
    const re = /(\d{1,10})[ \t\r\n\f\0]+(\d{1,5})[ \t\r\n\f\0]+obj(?![A-Za-z])/g;
    for (let m; (m = re.exec(s));) {
      if (m.index > 0 && /[0-9A-Za-z.]/.test(s[m.index - 1])) { continue; }
      const num = Number(m[1]); const gen = Number(m[2]);
      const lex = new Lexer(this.buf, m.index + m[0].length);
      let obj: PObj | POp | undefined;
      try { obj = parseObject(lex, true); } catch { this.damaged++; continue; }
      if (obj instanceof POp || obj === undefined) { obj = null; }
      const save = lex.pos;
      const kw = lex.next();
      if (kw instanceof POp && kw.op === 'stream' && obj instanceof PDict) {
        const st = this.readStream(obj, lex);
        st.num = num; st.gen = gen;
        obj = st;
      } else {
        lex.pos = save;
      }
      this.objs.set(num, { gen, obj, pos: m.index });
      if (obj instanceof PStream && nameOf(obj.dict.get('Type')) === 'XRef') { this.readXrefStream(obj, m.index); }
      // Skip stream data (it may contain anything), but never let a damaged object (an unterminated string, say)
      // swallow the objects after it: resume no later than its "endobj".
      const endobj = obj instanceof PStream ? -1 : s.indexOf('endobj', re.lastIndex);
      re.lastIndex = Math.max(re.lastIndex, endobj >= 0 ? Math.min(lex.pos, endobj) : lex.pos);
    }
    const tre = /trailer[\s\0]*<</g;
    for (let m; (m = tre.exec(s));) {
      const lex = new Lexer(this.buf, m.index + 7);
      const d = parseObject(lex, true);
      if (d instanceof PDict) { this.trailers.push({ pos: m.index, dict: d }); }
    }
  }

  private readStream(dict: PDict, lex: Lexer): PStream {
    const b = this.buf;
    let start = lex.pos;
    if (b[start] === 0x0d && b[start + 1] === 0x0a) { start += 2; } else if (b[start] === 0x0a || b[start] === 0x0d) { start++; }
    let len = dict.get('Length');
    if (len instanceof PRef) { const e = this.objs.get(len.num)?.obj; len = typeof e === 'number' ? e : undefined; }
    if (typeof len === 'number' && len >= 0 && start + len <= b.length) {
      let p = start + len;
      while (p < b.length && isWs(b[p])) { p++; }
      if (b.toString('latin1', p, p + 9) === 'endstream') {
        lex.pos = p + 9;
        return new PStream(dict, b.subarray(start, start + len));
      }
    }
    const idx = b.indexOf('endstream', start, 'latin1');
    let end = idx < 0 ? b.length : idx;
    if (b[end - 1] === 0x0a) { end--; }
    if (b[end - 1] === 0x0d) { end--; }
    lex.pos = idx < 0 ? b.length : idx + 9;
    return new PStream(dict, b.subarray(start, Math.max(start, end)));
  }

  /** Cross-reference streams double as trailers and tell which object stream holds each compressed object. */
  private readXrefStream(st: PStream, pos: number): void {
    this.trailers.push({ pos, dict: st.dict });
    const data = this.decode(st);
    const w = st.dict.get('W');
    if (!data || !Array.isArray(w) || w.length < 3 || !w.every((x) => typeof x === 'number')) { return; }
    const [w1, w2, w3] = w as number[];
    const rowLen = w1 + w2 + w3;
    if (rowLen <= 0) { return; }
    const size = st.dict.get('Size');
    const index = st.dict.get('Index');
    const sections = Array.isArray(index) ? index as number[] : [0, typeof size === 'number' ? size : 0];
    const field = (p: number, n: number) => { let v = 0; for (let i = 0; i < n; i++) { v = v * 256 + data[p + i]; } return v; };
    let p = 0;
    for (let s = 0; s + 1 < sections.length; s += 2) {
      for (let i = 0; i < sections[s + 1] && p + rowLen <= data.length; i++, p += rowLen) {
        const type = w1 ? field(p, w1) : 1;
        if (type === 2) { this.compressedIn.set(sections[s] + i, { stm: field(p + w1, w2), pos }); }
      }
    }
  }

  private setupEncryption(): boolean {
    const encRef = this.trailer.get('Encrypt');
    const enc = this.dict(encRef);
    if (!enc) { return true; }
    const str = (k: string) => { const v = this.resolve(enc.get(k)); return v instanceof PStr ? v.bytes : Buffer.alloc(0); };
    const num = (k: string, d: number) => { const v = this.resolve(enc.get(k)); return typeof v === 'number' ? v : d; };
    const ids = this.resolve(this.trailer.get('ID'));
    const id0 = Array.isArray(ids) && ids[0] instanceof PStr ? ids[0].bytes : Buffer.alloc(0);
    const v = num('V', 0);
    const method = (filterKey: string): CryptMethod => {
      if (v < 4) { return 'rc4'; }
      const f = nameOf(this.resolve(enc.get(filterKey))) ?? 'Identity';
      if (f === 'Identity') { return 'none'; }
      const cf = this.dict(this.dict(enc.get('CF'))?.get(f));
      const cfm = nameOf(this.resolve(cf?.get('CFM')));
      return cfm === 'AESV2' ? 'aes128' : cfm === 'AESV3' ? 'aes256' : cfm === 'None' ? 'none' : 'rc4';
    };
    const em = this.resolve(enc.get('EncryptMetadata'));
    const params: EncryptParams = {
      v, r: num('R', 2), length: num('Length', 40), p: num('P', 0), o: str('O'), u: str('U'), oe: str('OE'), ue: str('UE'), id0,
      encryptMetadata: em !== false, stmMethod: method('StmF'), strMethod: method('StrF'),
    };
    this.crypt = nameOf(this.resolve(enc.get('Filter'))) === 'Standard' ? PdfDecryptor.create(params) : null;
    if (!this.crypt) { this.warn(W_ENCRYPTED); return false; }
    const skip = encRef instanceof PRef ? encRef.num : -1;
    for (const [n, e] of this.objs) {
      if (n === skip) { continue; }
      if (e.obj instanceof PStream) {
        const type = nameOf(e.obj.dict.get('Type'));
        if (type === 'XRef' || (type === 'Metadata' && !params.encryptMetadata)) { continue; }
        e.obj.raw = this.crypt.decryptStream(e.obj.raw, n, e.gen);
        this.decryptStrings(e.obj.dict, n, e.gen, 0);
      } else {
        this.decryptStrings(e.obj, n, e.gen, 0);
      }
    }
    return true;
  }

  private decryptStrings(o: PObj, num: number, gen: number, depth: number): void {
    if (depth > 32 || !this.crypt) { return; }
    if (o instanceof PStr) { o.bytes = this.crypt.decryptString(o.bytes, num, gen); return; }
    if (Array.isArray(o)) { for (const x of o) { this.decryptStrings(x, num, gen, depth + 1); } return; }
    if (o instanceof PDict) { for (const x of o.map.values()) { this.decryptStrings(x, num, gen, depth + 1); } }
  }

  /** Materialises objects stored inside /Type /ObjStm streams. */
  private expandObjectStreams(): void {
    for (const [stmNum, e] of [...this.objs]) {
      const st = e.obj;
      if (!(st instanceof PStream) || nameOf(st.dict.get('Type')) !== 'ObjStm') { continue; }
      const data = this.decode(st);
      const n = this.resolve(st.dict.get('N')); const first = this.resolve(st.dict.get('First'));
      if (!data || typeof n !== 'number' || typeof first !== 'number') { this.damaged++; continue; }
      const head = new Lexer(data);
      const pairs: Array<[number, number]> = [];
      for (let i = 0; i < n && i < 100_000; i++) {
        const a = head.next(); const b = head.next();
        if (typeof a !== 'number' || typeof b !== 'number') { break; }
        pairs.push([a, b]);
      }
      for (const [num, off] of pairs) {
        const prev = this.objs.get(num);
        const auth = this.compressedIn.get(num);
        // An xref stream naming this object stream is authoritative unless a newer direct definition follows it.
        const wins = !prev || (auth?.stm === stmNum ? prev.pos <= auth.pos : prev.pos < e.pos && !(prev.obj instanceof PStream && prev.pos > e.pos));
        if (!wins) { continue; }
        try {
          const v = parseObject(new Lexer(data, first + off), true);
          if (v !== undefined && !(v instanceof POp)) { this.objs.set(num, { gen: 0, obj: v, pos: e.pos }); }
        } catch { this.damaged++; }
      }
    }
  }

  decode(s: PStream): Buffer | null {
    if (this.decoded.has(s)) { return this.decoded.get(s)!; }
    // Only inline images abbreviate to /F and /DP; on a stream, /F is an external file specification.
    const f = this.resolve(s.dict.get('Filter'));
    const p = this.resolve(s.dict.get('DecodeParms'));
    const filters = (Array.isArray(f) ? f : f ? [f] : []).map((x) => nameOf(this.resolve(x)) ?? '');
    const parms = (Array.isArray(p) ? p : [p]).map((x) => this.dict(x) ?? null);
    let out: Buffer | null = null;
    if (!this.budget.exhausted) {
      out = applyFilters(s.raw, filters, parms, this.budget);
      if (out && !out.length && s.raw.length > 16 && filters.length) { this.damaged++; }
    }
    if (this.budget.exhausted) { this.stop(); }
    this.decoded.set(s, out);
    return out;
  }

  private stop(): void { this.stopped = true; this.warn(W_BUDGET); }

  /* -------------------------------------------------------------- pages */

  pages(): Page[] {
    const out: Page[] = [];
    const seen = new Set<PDict>();
    const walk = (node: PDict | undefined, res: PDict | undefined, box: number[], depth: number): void => {
      if (!node || seen.has(node) || depth > 64 || out.length >= MAX_PAGES) { return; }
      seen.add(node);
      const r = this.dict(node.get('Resources')) ?? res;
      const b = this.box(node) ?? box;
      const kids = this.resolve(node.get('Kids'));
      if (Array.isArray(kids) && nameOf(this.resolve(node.get('Type'))) !== 'Page') {
        for (const k of kids) { walk(this.dict(k), r, b, depth + 1); }
      } else {
        out.push({ dict: node, res: r, box: b });
      }
    };
    const root = this.dict(this.trailer.get('Root')) ?? this.findType('Catalog')[0];
    walk(this.dict(root?.get('Pages')), undefined, [0, 0, 612, 792], 0);
    if (!out.length) {
      for (const d of this.findType('Page')) { if (out.length < MAX_PAGES) { out.push({ dict: d, res: this.dict(d.get('Resources')), box: this.box(d) ?? [0, 0, 612, 792] }); } }
    }
    if (out.length >= MAX_PAGES) { this.warn(`Only the first ${MAX_PAGES} pages were read`); }
    return out;
  }

  private box(d: PDict): number[] | undefined {
    for (const k of ['CropBox', 'MediaBox']) {
      const v = this.resolve(d.get(k));
      if (Array.isArray(v) && v.length >= 4) {
        const n = v.slice(0, 4).map((x) => this.resolve(x));
        if (n.every((x) => typeof x === 'number')) {
          const [a, b, c, e] = n as number[];
          return [Math.min(a, c), Math.min(b, e), Math.max(a, c), Math.max(b, e)];
        }
      }
    }
    return undefined;
  }

  findType(type: string): PDict[] {
    const out: Array<[number, PDict]> = [];
    for (const [n, e] of this.objs) { if (e.obj instanceof PDict && nameOf(e.obj.get('Type')) === type) { out.push([n, e.obj]); } }
    return out.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  }

  pageContent(p: Page): Buffer {
    const c = this.resolve(p.dict.get('Contents'));
    const parts = (Array.isArray(c) ? c : [c]).map((x) => this.resolve(x)).filter((x): x is PStream => x instanceof PStream);
    const bufs: Buffer[] = [];
    for (const s of parts) { const d = this.decode(s); if (d) { bufs.push(d, Buffer.from('\n')); } }
    return Buffer.concat(bufs);
  }

  pageLinks(p: Page, links: DocLink[]): void {
    const annots = this.resolve(p.dict.get('Annots'));
    if (!Array.isArray(annots)) { return; }
    for (const a of annots) {
      const d = this.dict(a);
      const act = this.dict(d?.get('A'));
      const uri = act ? this.resolve(act.get('URI')) : undefined;
      if (uri instanceof PStr) {
        const url = uri.bytes.toString('latin1').trim();
        if (/^https?:\/\//i.test(url) && !links.some((l) => l.url === url)) { links.push({ text: url, url }); }
      }
    }
  }

  /* -------------------------------------------------------------- content streams */

  font(d: PDict): PdfFont | null {
    if (!this.fonts.has(d)) {
      let f: PdfFont | null = null;
      try { f = new PdfFont(d, this); } catch { this.damaged++; }
      this.fonts.set(d, f);
    }
    return this.fonts.get(d)!;
  }

  /** Interprets a content stream for text; runs are appended to `out`. */
  runContent(data: Buffer, res: PDict | undefined, ctm: Mat, out: Run[], depth: number, forms: Set<PStream>): void {
    const lex = new Lexer(data);
    const ops: PObj[] = [];
    interface GState { ctm: Mat; font: PdfFont | null; fs: number; tc: number; tw: number; th: number; tl: number; rise: number }
    let gs: GState = { ctm, font: null, fs: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
    const stack: GState[] = [];
    let tm: Mat = IDENTITY; let tlm: Mat = IDENTITY;
    const n = (i: number) => { const v = ops[ops.length - i]; return typeof v === 'number' ? v : 0; };

    const show = (parts: PObj[]): void => {
      const font = gs.font;
      if (!font) { return; }
      const m = mul(tm, gs.ctm);
      let adv = 0; let text = '';
      for (const part of parts) {
        if (typeof part === 'number') {
          adv -= (part / 1000) * gs.fs * gs.th;
          if (part < -200 && text && !text.endsWith(' ')) { text += ' '; }
          continue;
        }
        if (!(part instanceof PStr)) { continue; }
        for (const g of font.decode(part.bytes)) {
          text += g.text;
          adv += (g.width * gs.fs + gs.tc + (g.space ? gs.tw : 0)) * gs.th;
        }
      }
      if (font.unmapped) { this.unmappedFonts = true; }
      const ox = gs.rise * m[2] + m[4]; const oy = gs.rise * m[3] + m[5];
      const ex = adv * m[0] + ox; const ey = adv * m[1] + oy;
      tm = [tm[0], tm[1], tm[2], tm[3], adv * tm[0] + tm[4], adv * tm[1] + tm[5]];
      if (!text.trim()) { return; }
      const size = Math.abs(gs.fs) * Math.hypot(m[2], m[3]) || 1;
      const ang = Math.atan2(m[1], m[0]) * 180 / Math.PI;
      const dir = Math.abs(ang) < 15 ? 0 : Math.abs(ang - 90) < 15 ? 90 : Math.abs(ang + 90) < 15 ? 270 : Math.abs(Math.abs(ang) - 180) < 15 ? 180 : -1;
      out.push({ ox, oy, ex, ey, size, dir, text });
    };
    const td = (tx: number, ty: number) => {
      tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tx * tlm[0] + ty * tlm[2] + tlm[4], tx * tlm[1] + ty * tlm[3] + tlm[5]];
      tm = tlm;
    };

    for (;;) {
      const t = lex.next();
      if (t === undefined) { break; }
      if (!(t instanceof POp) || t.op === '[' || t.op === '<<' || t.op === 'true' || t.op === 'false' || t.op === 'null') {
        const v = parseObject(lex, false, 0, t);
        if (v !== undefined && !(v instanceof POp)) { ops.push(v); }
        if (ops.length > 10_000) { ops.length = 0; }
        continue;
      }
      if (++this.ops > MAX_OPS || ((this.ops & 0x3fff) === 0 && Date.now() > this.deadline)) { this.stop(); return; }
      switch (t.op) {
        case 'BT': tm = IDENTITY; tlm = IDENTITY; break;
        case 'q': if (stack.length < 256) { stack.push({ ...gs }); } break;
        case 'Q': gs = stack.pop() ?? gs; break;
        case 'cm': { const m = toMat(ops.slice(-6)); if (m) { gs.ctm = mul(m, gs.ctm); } break; }
        case 'Tf': {
          gs.fs = n(1);
          const name = ops[ops.length - 2];
          const fd = name instanceof PName ? this.dict(this.dict(res?.get('Font'))?.get(name.name)) : undefined;
          gs.font = fd ? this.font(fd) : null;
          break;
        }
        case 'Tc': gs.tc = n(1); break;
        case 'Tw': gs.tw = n(1); break;
        case 'Tz': gs.th = n(1) / 100; break;
        case 'TL': gs.tl = n(1); break;
        case 'Ts': gs.rise = n(1); break;
        case 'Td': td(n(2), n(1)); break;
        case 'TD': gs.tl = -n(1); td(n(2), n(1)); break;
        case 'Tm': { const m = toMat(ops.slice(-6)); if (m) { tm = m; tlm = m; } break; }
        case 'T*': td(0, -gs.tl); break;
        case 'Tj': show(ops.slice(-1)); break;
        case 'TJ': { const a = ops[ops.length - 1]; if (Array.isArray(a)) { show(a); } break; }
        case "'": td(0, -gs.tl); show(ops.slice(-1)); break;
        case '"': gs.tw = n(3); gs.tc = n(2); td(0, -gs.tl); show(ops.slice(-1)); break;
        case 'Do': {
          const name = ops[ops.length - 1];
          if (!(name instanceof PName) || depth >= MAX_FORM_DEPTH) { break; }
          const xo = this.resolve(this.dict(res?.get('XObject'))?.get(name.name));
          if (!(xo instanceof PStream) || nameOf(xo.dict.get('Subtype')) !== 'Form' || forms.has(xo)) { break; }
          const data2 = this.decode(xo);
          if (!data2) { break; }
          const fm = toMat(this.resolve(xo.dict.get('Matrix')) as PObj) ?? IDENTITY;
          forms.add(xo);
          this.runContent(data2, this.dict(xo.dict.get('Resources')) ?? res, mul(fm, gs.ctm), out, depth + 1, forms);
          forms.delete(xo);
          if (this.stopped) { return; }
          break;
        }
        case 'BI': skipInlineImage(lex); break;
      }
      ops.length = 0;
    }
  }
}

/** Skips "BI <dict> ID <binary> EI" safely: binary data may contain anything, including the bytes "EI". */
function skipInlineImage(lex: Lexer): void {
  for (let i = 0; i < 1000; i++) {
    const t = lex.next();
    if (t === undefined) { return; }
    if (t instanceof POp && t.op === 'ID') { break; }
  }
  const b = lex.buf;
  let p = lex.pos + 1;
  while (p < b.length) {
    const i = b.indexOf('EI', p, 'latin1');
    if (i < 0) { lex.pos = b.length; return; }
    const after = b[i + 2];
    if (isWs(b[i - 1]) && (i + 2 >= b.length || isWs(after))) {
      // Accept only if what follows looks like operators again (ASCII), not more image bytes.
      const tail = b.subarray(i + 2, Math.min(b.length, i + 40));
      if (tail.every((c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127))) { lex.pos = i + 2; return; }
    }
    p = i + 2;
  }
  lex.pos = b.length;
}

/* ------------------------------------------------------------------ layout */

interface Item { x: number; x2: number; y: number; size: number; text: string; col: number }
export interface Line { x: number; x2: number; y: number; size: number; text: string; col: number }

/** Rotates runs so the page's dominant text direction reads left-to-right; other directions (margin stamps) are dropped. */
function normalise(runs: Run[], box: number[]): { items: Item[]; top: number; bottom: number } {
  const counts = new Map<number, number>();
  for (const r of runs) { if (r.dir >= 0) { counts.set(r.dir, (counts.get(r.dir) ?? 0) + r.text.length); } }
  let dir = 0; let best = -1;
  for (const [d, c] of counts) { if (c > best) { best = c; dir = d; } }
  const rot = (x: number, y: number): [number, number] =>
    dir === 90 ? [y, -x] : dir === 180 ? [-x, -y] : dir === 270 ? [-y, x] : [x, y];
  const corners = [rot(box[0], box[1]), rot(box[2], box[3])];
  const top = Math.max(corners[0][1], corners[1][1]); const bottom = Math.min(corners[0][1], corners[1][1]);
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const r of runs) {
    if (r.dir !== dir) { continue; }
    const [x, y] = rot(r.ox, r.oy); const [x2] = rot(r.ex, r.ey);
    const text = r.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f�]/g, '').replace(/\s/g, ' ');
    // Fake bold (the same text drawn twice with a tiny offset) must not double the words.
    const key = `${Math.round(x)}|${Math.round(y)}|${text}`;
    if (!text.trim() || seen.has(key)) { continue; }
    seen.add(key);
    items.push({ x: Math.min(x, x2), x2: Math.max(x, x2), y, size: r.size, text, col: 0 });
  }
  return { items, top, bottom };
}

/** Finds a vertical gutter shared by most text and tags items as left (1), right (2) or spanning (0). */
function detectColumns(items: Item[]): void {
  if (items.length < 12) { return; }
  let minX = Infinity; let maxX = -Infinity;
  for (const it of items) { minX = Math.min(minX, it.x); maxX = Math.max(maxX, it.x2); }
  const width = maxX - minX;
  if (width < 100) { return; }
  const step = 2; const bins = Math.ceil(width / step) + 1;
  const cover = new Uint32Array(bins);
  for (const it of items) {
    for (let b = Math.floor((it.x - minX) / step); b <= Math.floor((it.x2 - minX) / step) && b < bins; b++) { cover[b]++; }
  }
  const lowMax = Math.max(1, Math.floor(items.length * 0.04));
  const lo = Math.floor(bins * 0.25); const hi = Math.ceil(bins * 0.75);
  let bestStart = -1; let bestLen = 0;
  for (let b = lo; b < hi;) {
    if (cover[b] > lowMax) { b++; continue; }
    let e = b;
    while (e < hi && cover[e] <= lowMax) { e++; }
    if (e - b > bestLen) { bestLen = e - b; bestStart = b; }
    b = e;
  }
  if (bestStart < 0 || bestLen * step < Math.max(8, width * 0.015)) { return; }
  const g1 = minX + bestStart * step; const g2 = minX + (bestStart + bestLen) * step;
  let left = 0; let right = 0;
  for (const it of items) { it.col = it.x2 <= g2 ? 1 : it.x >= g1 ? 2 : 0; if (it.col === 1) { left++; } else if (it.col === 2) { right++; } }
  const span = items.length - left - right;
  const lYs = items.filter((i) => i.col === 1).map((i) => i.y);
  const rYs = items.filter((i) => i.col === 2).map((i) => i.y);
  const overlap = rYs.filter((y) => y <= Math.max(...lYs) && y >= Math.min(...lYs)).length;
  if (left < items.length * 0.2 || right < items.length * 0.2 || span > items.length * 0.25 || overlap < rYs.length * 0.5) {
    for (const it of items) { it.col = 0; }
  }
}

function groupLines(items: Item[]): Line[] {
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: Item[][] = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[0].y - it.y) <= 0.5 * Math.max(g[0].size, it.size)) { g.push(it); } else { groups.push([it]); }
  }
  return groups.map((g) => {
    g.sort((a, b) => a.x - b.x);
    let text = ''; let prev: Item | undefined;
    for (const it of g) {
      if (prev && !text.endsWith(' ') && !it.text.startsWith(' ') && it.x - prev.x2 > 0.25 * Math.min(prev.size, it.size)) { text += ' '; }
      text += it.text; prev = it;
    }
    const main = g.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    return { x: g[0].x, x2: Math.max(...g.map((i) => i.x2)), y: main.y, size: main.size, text: text.replace(/\s+/g, ' ').trim(), col: g[0].col };
  }).filter((l) => l.text);
}

/** Lines in reading order: spanning lines interleave with the two columns by vertical position. */
function layoutLines(items: Item[]): Line[] {
  detectColumns(items);
  const byCol = [0, 1, 2].map((c) => groupLines(items.filter((i) => i.col === c)));
  if (!byCol[1].length && !byCol[2].length) { return byCol[0]; }
  const out: Line[] = [];
  const [span, left, right] = byCol;
  let li = 0; let ri = 0;
  for (const s of span) {
    while (li < left.length && left[li].y > s.y) { out.push(left[li++]); }
    while (ri < right.length && right[ri].y > s.y) { out.push(right[ri++]); }
    out.push(s);
  }
  return out.concat(left.slice(li), right.slice(ri));
}

const norm = (t: string) => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();

/** Drops lines that repeat at the top or bottom of more than half the pages (running headers, footers, page numbers). */
function removeRepeated(pages: Array<{ lines: Line[]; top: number; bottom: number }>): void {
  if (pages.length < 2) { return; }
  const cands = pages.map((p) => {
    const h = p.top - p.bottom || 792;
    const byY = p.lines.slice().sort((a, b) => b.y - a.y);
    const top = byY.slice(0, 2).filter((l) => l.y >= p.top - h * 0.15);
    const bottom = byY.slice(-2).filter((l) => l.y <= p.bottom + h * 0.15);
    return { top, bottom };
  });
  const count = new Map<string, number>();
  for (const c of cands) {
    const keys = new Set([...c.top.map((l) => `T${norm(l.text)}`), ...c.bottom.map((l) => `B${norm(l.text)}`)]);
    for (const k of keys) { count.set(k, (count.get(k) ?? 0) + 1); }
  }
  pages.forEach((p, i) => {
    const drop = new Set<Line>();
    for (const l of cands[i].top) { if ((count.get(`T${norm(l.text)}`) ?? 0) > pages.length / 2) { drop.add(l); } }
    for (const l of cands[i].bottom) { if ((count.get(`B${norm(l.text)}`) ?? 0) > pages.length / 2) { drop.add(l); } }
    if (drop.size) { p.lines = p.lines.filter((l) => !drop.has(l)); }
  });
}

function median(xs: number[]): number {
  if (!xs.length) { return 0; }
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const LIST_START = /^([•●○◦▪■‣∙·*]|[-–]\s|\(?\d{1,3}[.)]\s|\(?[a-z][.)]\s)/;

/** Joins lines into paragraphs and headings (Markdown). */
function linesToMarkdown(lines: Line[]): string {
  if (!lines.length) { return ''; }
  const sizes: number[] = [];
  for (const l of lines) { for (let i = 0; i < Math.min(l.text.length, 200); i += 10) { sizes.push(l.size); } }
  const med = median(sizes) || 10;
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (lines[i].col === lines[i - 1].col && g > 0 && g < 3 * lines[i].size) { gaps.push(g); }
  }
  const lineGap = median(gaps) || med * 1.2;
  const colRight = new Map<number, number>();
  for (const l of lines) { colRight.set(l.col, Math.max(colRight.get(l.col) ?? -Infinity, l.x2)); }
  const colLeft = new Map<number, number>();
  for (const l of lines) { colLeft.set(l.col, Math.min(colLeft.get(l.col) ?? Infinity, l.x)); }

  const blocks: string[] = [];
  let cur = ''; let prev: Line | undefined; let prevHeading = false;
  const flush = () => { if (cur.trim()) { blocks.push(cur.trim()); } cur = ''; };
  for (const l of lines) {
    const heading = l.size >= 1.3 * med && l.text.length <= 200 && /[\p{L}\p{N}]/u.test(l.text);
    let text = l.text;
    const isList = LIST_START.test(text);
    if (/^[•●○◦▪■‣∙]\s*/.test(text)) { text = `- ${text.replace(/^[•●○◦▪■‣∙]\s*/, '')}`; }
    let brk = !prev || heading || prevHeading || isList;
    if (prev && !brk) {
      const gap = prev.y - l.y;
      const sameCol = prev.col === l.col;
      if (sameCol && gap > 1.5 * lineGap) { brk = true; }
      if (Math.abs(l.size - prev.size) > 0.25 * med) { brk = true; }
      const width = (colRight.get(prev.col) ?? prev.x2) - (colLeft.get(prev.col) ?? prev.x);
      if (/[.!?:]["”’)]?$/.test(prev.text) && (colRight.get(prev.col) ?? prev.x2) - prev.x2 > width * 0.15) { brk = true; }
    }
    if (brk) {
      flush();
      cur = heading ? `## ${text}` : text;
    } else if (/[\p{L}]-$/u.test(cur) && /^\p{Ll}/u.test(text)) {
      cur = cur.slice(0, -1) + text; // de-hyphenate "infor-" + "mation"
    } else if (cur.endsWith('­')) {
      cur = cur.slice(0, -1) + text;
    } else {
      cur += ` ${text}`;
    }
    prev = l; prevHeading = heading;
  }
  flush();
  return blocks.join('\n\n');
}

/* ------------------------------------------------------------------ metadata */

function pdfDate(s: string): string | undefined {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(s.trim());
  if (!m) { return undefined; }
  const [, y, mo = '01', d = '01', h, mi = '00', se = '00', tz, th = '00', tm = '00'] = m;
  if (!h) { return `${y}-${mo}-${d}`; }
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (tz === '+' || tz === '-') { ms -= (tz === '+' ? 1 : -1) * (+th * 60 + +tm) * 60_000; }
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString().replace('.000Z', 'Z');
}

function xmpField(xmp: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xmp) ?? new RegExp(`${tag}="([^"]*)"`).exec(xmp);
  if (!m) { return undefined; }
  const li = /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(m[1]);
  const v = (li ? li[1] : m[1]).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
  return v || undefined;
}

/* ------------------------------------------------------------------ entry point */

/** Extracts the text of a PDF as Markdown. Throws WebError('parse') only when the input is not a PDF at all. */
export function pdfToDoc(buf: Buffer): ExtractedDoc {
  const head = buf.subarray(0, 1024).toString('latin1');
  if (!head.includes('%PDF-')) { throw new WebError('Not a PDF file', 'parse'); }
  const r = new PdfReader(buf);
  const readable = r.load();
  if (!r.objs.size) { throw new WebError('Not a PDF file (no objects found)', 'parse'); }
  const doc: ExtractedDoc = { kind: 'pdf', markdown: '', links: [], images: [], warnings: r.warnings };

  const root = r.dict(r.trailer.get('Root')) ?? r.findType('Catalog')[0];
  const info = r.dict(r.trailer.get('Info'));
  if (info) {
    doc.title = textString(r.resolve(info.get('Title'))) || undefined;
    doc.author = textString(r.resolve(info.get('Author'))) || undefined;
    doc.description = textString(r.resolve(info.get('Subject'))) || undefined;
    const cd = textString(r.resolve(info.get('CreationDate')));
    if (cd) { doc.published = pdfDate(cd); }
  }
  const meta = r.resolve(root?.get('Metadata'));
  if (meta instanceof PStream && readable) {
    const x = r.decode(meta)?.toString('utf8');
    if (x) {
      doc.title ??= xmpField(x, 'dc:title');
      doc.author ??= xmpField(x, 'dc:creator');
      const cd = xmpField(x, 'xmp:CreateDate');
      if (!doc.published && cd) { const d = new Date(cd); doc.published = Number.isNaN(d.getTime()) ? undefined : cd; }
    }
  }
  const lang = r.resolve(root?.get('Lang'));
  if (lang instanceof PStr) { doc.lang = textString(lang) || undefined; }
  for (const k of Object.keys(doc) as Array<keyof ExtractedDoc>) { if (doc[k] === undefined) { delete doc[k]; } }

  const pages = r.pages();
  doc.pages = pages.length;
  if (!readable) { return doc; }

  const laid: Array<{ lines: Line[]; top: number; bottom: number }> = [];
  for (const p of pages) {
    const runs: Run[] = [];
    if (!r.stopped) {
      try {
        r.runContent(r.pageContent(p), p.res, IDENTITY, runs, 0, new Set());
        r.pageLinks(p, doc.links);
      } catch {
        r.warn('Some pages could not be fully read (damaged content)');
      }
    }
    const { items, top, bottom } = normalise(runs, p.box);
    laid.push({ lines: layoutLines(items), top, bottom });
  }
  removeRepeated(laid);
  const texts = laid.map((p) => linesToMarkdown(p.lines));
  const chars = texts.join('').replace(/\s+/g, '').length;
  if (pages.length && chars < 20) { r.warn(W_SCANNED); }
  if (r.unmappedFonts) { r.warn('Some text uses fonts without a Unicode mapping and was dropped or may be garbled'); }
  doc.markdown = chars ? texts.map((t, i) => `${PAGE_SEP(i + 1)}\n\n${t}`.trimEnd()).join('\n\n') : '';
  return doc;
}
