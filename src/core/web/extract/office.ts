import { DocLink, ExtractedDoc, WebError } from '../types';
import { readZip } from './zip';

/**
 * Office Open XML (docx / xlsx / pptx) → Markdown, dependency-free.
 *
 * OOXML is a ZIP of XML parts wired together by relationship files (*.rels). Each converter reads only the parts it
 * needs, follows the relationships the way Office does, and keeps the structure the model benefits from: headings,
 * lists, tables, links, sheet grids and slide order.
 */

/* ------------------------------------------------------------------ XML */

interface XEl { name: string; local: string; attrs: Record<string, string>; kids: XNode[] }
type XNode = XEl | string;

const MAX_XML_DEPTH = 256;
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  if (!s.includes('&')) { return s; }
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] !== '#') { return ENTITIES[e] ?? m; }
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  });
}

const localName = (q: string) => q.slice(q.indexOf(':') + 1);

/**
 * Small forgiving XML parser into a tree. OOXML parts are machine-written, so no DTDs or validation are needed;
 * the parser still never throws, because a broken part should cost that part only.
 */
function parseXml(s: string): XEl {
  const root: XEl = { name: '#root', local: '#root', attrs: {}, kids: [] };
  const stack: XEl[] = [root];
  const top = () => stack[stack.length - 1];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    const end = lt < 0 ? n : lt;
    if (end > i) { top().kids.push(decodeEntities(s.slice(i, end))); }
    if (lt < 0) { break; }
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) {
      const e = s.indexOf(']]>', lt + 9);
      top().kids.push(s.slice(lt + 9, e < 0 ? n : e));
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (s[lt + 1] === '?') { const e = s.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (s[lt + 1] === '!') {
      const br = s.indexOf('[', lt); const gt = s.indexOf('>', lt);
      const e = br >= 0 && br < gt ? s.indexOf(']>', br) : gt;
      i = e < 0 ? n : e + (br >= 0 && br < gt ? 2 : 1);
      continue;
    }
    if (s[lt + 1] === '/') {
      const e = s.indexOf('>', lt);
      const name = s.slice(lt + 2, e < 0 ? n : e).trim();
      const at = stack.map((x) => x.name).lastIndexOf(name);
      if (at > 0) { stack.length = at; }
      i = e < 0 ? n : e + 1;
      continue;
    }
    let j = lt + 1; let q = '';
    for (; j < n; j++) {
      const c = s[j];
      if (q) { if (c === q) { q = ''; } } else if (c === '"' || c === "'") { q = c; } else if (c === '>') { break; }
    }
    const body = s.slice(lt + 1, j);
    i = j + 1;
    const nm = /^[^\s/>]+/.exec(body);
    if (!nm) { continue; }
    const el: XEl = { name: nm[0], local: localName(nm[0]), attrs: {}, kids: [] };
    const re = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    re.lastIndex = nm[0].length;
    for (let m; (m = re.exec(body));) { el.attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? ''); }
    top().kids.push(el);
    if (!body.endsWith('/') && stack.length < MAX_XML_DEPTH) { stack.push(el); }
  }
  return root;
}

/** Attribute by local name; `prefixed` picks the namespaced one ("r:id") over a plain one ("id") on the same element. */
function attr(el: XEl | undefined, local: string, prefixed = false): string | undefined {
  if (!el) { return undefined; }
  if (!prefixed && el.attrs[local] !== undefined) { return el.attrs[local]; }
  for (const [k, v] of Object.entries(el.attrs)) {
    const c = k.indexOf(':');
    if (c > 0 && k.slice(c + 1) === local && !k.startsWith('xmlns')) { return v; }
  }
  return undefined;
}

const isEl = (x: XNode): x is XEl => typeof x !== 'string';
const kids = (el: XEl | undefined, local: string): XEl[] => (el ? el.kids.filter((k): k is XEl => isEl(k) && k.local === local) : []);
const child = (el: XEl | undefined, local: string): XEl | undefined => el?.kids.find((k): k is XEl => isEl(k) && k.local === local);
const path = (el: XEl | undefined, ...names: string[]): XEl | undefined => names.reduce<XEl | undefined>((e, nm) => child(e, nm), el);

/** Every descendant element with this local name, in document order (iterative: deep trees must not overflow). */
function findAll(el: XEl | undefined, local: string): XEl[] {
  const out: XEl[] = [];
  if (!el) { return out; }
  const todo: XEl[] = [el];
  while (todo.length) {
    const e = todo.pop()!;
    for (let k = e.kids.length - 1; k >= 0; k--) { const c = e.kids[k]; if (isEl(c)) { todo.push(c); } }
    if (e !== el && e.local === local) { out.push(e); }
  }
  return out;
}

/** Concatenated character data of an element (all descendants). */
function textAll(el: XEl | undefined): string {
  if (!el) { return ''; }
  let s = '';
  const todo: XNode[] = [el];
  while (todo.length) {
    const e = todo.pop()!;
    if (!isEl(e)) { s += e; continue; }
    for (let k = e.kids.length - 1; k >= 0; k--) { todo.push(e.kids[k]); }
  }
  return s;
}

/* ------------------------------------------------------------------ package */

interface Rel { type: string; target: string; external: boolean }

/** A ZIP opened as an OPC package: parts by name, XML parsing and relationship resolution. */
class Package {
  private readonly lower = new Map<string, string>();
  private readonly xmlCache = new Map<string, XEl | undefined>();

  constructor(private readonly files: Map<string, Buffer>) {
    for (const k of files.keys()) { this.lower.set(k.toLowerCase(), k); }
  }

  /** Part bytes; names are matched case-insensitively because some writers disagree with [Content_Types].xml. */
  part(name: string): Buffer | undefined {
    return this.files.get(name) ?? this.files.get(this.lower.get(name.toLowerCase()) ?? '');
  }

  names(): string[] { return [...this.files.keys()]; }

  xml(name: string): XEl | undefined {
    if (!this.xmlCache.has(name)) {
      const b = this.part(name);
      this.xmlCache.set(name, b ? parseXml(xmlText(b)) : undefined);
    }
    return this.xmlCache.get(name);
  }

  /** Relationships of a part, keyed by r:id, with targets resolved to part names (external targets kept as-is). */
  rels(partName: string): Map<string, Rel> {
    const slash = partName.lastIndexOf('/');
    const dir = partName.slice(0, slash + 1);
    const out = new Map<string, Rel>();
    for (const r of kids(child(this.xml(`${dir}_rels/${partName.slice(slash + 1)}.rels`), 'Relationships'), 'Relationship')) {
      const id = attr(r, 'Id'); const target = attr(r, 'Target');
      if (!id || target === undefined) { continue; }
      const external = attr(r, 'TargetMode') === 'External';
      out.set(id, { type: attr(r, 'Type') ?? '', target: external ? target.trim() : resolvePart(dir, target), external });
    }
    return out;
  }
}

function xmlText(b: Buffer): string {
  if (b[0] === 0xff && b[1] === 0xfe) { return b.subarray(2).toString('utf16le'); }
  if (b[0] === 0xfe && b[1] === 0xff) { return Buffer.from(b.subarray(2)).swap16().toString('utf16le'); }
  return b.toString('utf8').replace(/^\uFEFF/, '');
}

function resolvePart(dir: string, target: string): string {
  const t = target.replace(/\\/g, '/').split('#')[0];
  const parts = (t.startsWith('/') ? t.slice(1) : dir + t).split('/');
  const out: string[] = [];
  for (const p of parts) { if (p === '..') { out.pop(); } else if (p && p !== '.') { out.push(p); } }
  return out.join('/');
}

function open(buf: Buffer, main: string, kind: string): Package {
  const pkg = new Package(readZip(buf));
  if (!pkg.part(main)) { throw new WebError(`Not a ${kind} file (no ${main})`, 'parse'); }
  return pkg;
}

/** docProps/core.xml → title, author, description, published, lang. */
function coreProps(pkg: Package, doc: ExtractedDoc): void {
  const core = child(pkg.xml('docProps/core.xml'), 'coreProperties');
  const get = (local: string) => textAll(child(core, local)).replace(/\s+/g, ' ').trim() || undefined;
  const title = get('title'); const author = get('creator'); const desc = get('description') ?? get('subject');
  const created = get('created'); const lang = get('language');
  if (title) { doc.title = title; }
  if (author) { doc.author = author; }
  if (desc) { doc.description = desc; }
  if (lang) { doc.lang = lang; }
  if (created && !Number.isNaN(Date.parse(created))) { doc.published = created; }
}

const isWebUrl = (u: string) => /^https?:\/\/[^\s]+$/i.test(u);

function addLink(links: DocLink[], url: string, text: string): void {
  if (!isWebUrl(url) || links.some((l) => l.url === url)) { return; }
  links.push({ text: text.replace(/\s+/g, ' ').trim() || url, url });
}

/** External http(s) relationships nobody linked from the text (images and links in shapes, headers…). */
function addRelLinks(links: DocLink[], rels: Map<string, Rel>): void {
  for (const r of rels.values()) { if (r.external) { addLink(links, r.target, r.target); } }
}

const cell = (s: string) => s.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|').replace(/[ \t]+/g, ' ').trim();

/** Markdown table; the first row is the header and every row is padded to the widest one. */
function mdTable(rows: string[][]): string {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i] ?? '')).join(' | ')} |`;
  return [line(rows[0] ?? []), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

const newDoc = (kind: 'docx' | 'xlsx' | 'pptx'): ExtractedDoc => ({ kind, markdown: '', links: [], images: [], warnings: [] });

/* ------------------------------------------------------------------ docx */

interface ListState { counters: Map<string, number[]> }

/** Word document → Markdown with headings, lists, tables and links. */
export function docxToDoc(buf: Buffer): ExtractedDoc {
  const pkg = open(buf, 'word/document.xml', 'Word');
  const doc = newDoc('docx');
  coreProps(pkg, doc);
  const rels = pkg.rels('word/document.xml');
  const numFmt = readNumbering(pkg);
  const styles = readStyles(pkg);
  const body = path(pkg.xml('word/document.xml'), 'document', 'body');
  const lists: ListState = { counters: new Map() };

  const paragraph = (p: XEl): { text: string; list: boolean } => {
    const pPr = child(p, 'pPr');
    const styleId = attr(child(pPr, 'pStyle'), 'val') ?? '';
    const style = styles.get(styleId);
    let text = inline(p, rels, doc.links).replace(/[ \t]+$/gm, '').trim();
    if (!text) { return { text: '', list: false }; }
    const level = headingLevel(styleId, style, pPr);
    if (level) { return { text: `${'#'.repeat(level)} ${text.replace(/\s*\n\s*/g, ' ')}`, list: false }; }
    const numPr = child(pPr, 'numPr') ?? style?.numPr;
    const numId = attr(child(numPr, 'numId'), 'val');
    const ilvl = Math.min(8, Number(attr(child(numPr, 'ilvl'), 'val') ?? 0) || 0);
    let bullet: boolean | undefined;
    if (numId && numId !== '0') { bullet = (numFmt.get(`${numId}:${ilvl}`) ?? 'bullet') === 'bullet'; }
    else if (/^ListBullet/i.test(styleId)) { bullet = true; }
    else if (/^ListNumber/i.test(styleId)) { bullet = false; }
    if (bullet === undefined) { return { text, list: false }; }
    const key = numId ?? styleId;
    const counts = lists.counters.get(key) ?? [];
    counts[ilvl] = (counts[ilvl] ?? 0) + 1;
    counts.length = ilvl + 1; // a shallower item restarts deeper levels
    lists.counters.set(key, counts);
    const marker = bullet ? '-' : `${counts[ilvl]}.`;
    text = text.replace(/\n/g, `\n${'  '.repeat(ilvl + 1)}`);
    return { text: `${'  '.repeat(ilvl)}${marker} ${text}`, list: true };
  };

  const table = (tbl: XEl): string => {
    const rows: string[][] = [];
    for (const tr of kids(tbl, 'tr')) {
      const row: string[] = [];
      for (const tc of kids(tr, 'tc')) {
        const paras = findAll(tc, 'p').map((p) => inline(p, rels, doc.links).trim()).filter(Boolean);
        row.push(paras.join(' '));
        const span = Number(attr(child(child(tc, 'tcPr'), 'gridSpan'), 'val') ?? 1);
        for (let k = 1; k < span && k < 64; k++) { row.push(''); }
      }
      rows.push(row);
    }
    return rows.length ? mdTable(rows) : '';
  };

  const blocks: Array<{ text: string; list: boolean }> = [];
  const walkBody = (el: XEl | undefined, depth: number): void => {
    if (!el || depth > 32) { return; }
    for (const k of el.kids) {
      if (!isEl(k)) { continue; }
      if (k.local === 'p') { const b = paragraph(k); if (b.text) { blocks.push(b); } }
      else if (k.local === 'tbl') { const t = table(k); if (t) { blocks.push({ text: t, list: false }); } }
      else if (k.local === 'sdt') { walkBody(child(k, 'sdtContent'), depth + 1); }
      else if (k.local === 'customXml' || k.local === 'ins' || k.local === 'smartTag') { walkBody(k, depth + 1); }
    }
  };
  walkBody(body, 0);
  doc.markdown = blocks.map((b, i) => (i === 0 ? '' : b.list && blocks[i - 1].list ? '\n' : '\n\n') + b.text).join('');
  if (!doc.title) { const h = blocks.find((b) => b.text.startsWith('# ')); if (h) { doc.title = h.text.slice(2); } }
  addRelLinks(doc.links, rels);
  return doc;
}

/** Text of a paragraph: runs, tabs, breaks and hyperlinks (as Markdown links), skipping deleted text and field codes. */
function inline(el: XEl, rels: Map<string, Rel>, links: DocLink[], depth = 0): string {
  let s = '';
  if (depth > 32) { return s; }
  for (const k of el.kids) {
    if (!isEl(k)) { continue; }
    switch (k.local) {
      case 't': s += textAll(k); break;
      case 'tab': case 'ptab': s += '\t'; break;
      case 'br': case 'cr': s += '\n'; break;
      case 'noBreakHyphen': s += '-'; break;
      case 'softHyphen': break;
      case 'hyperlink': {
        const text = inline(k, rels, links, depth + 1);
        const rel = rels.get(attr(k, 'id', true) ?? '');
        if (rel?.external && isWebUrl(rel.target) && text.trim()) {
          addLink(links, rel.target, text);
          s += `[${text.trim().replace(/[[\]]/g, '\\$&')}](${rel.target.replace(/[()\s]/g, encodeURIComponent)})`;
        } else {
          s += text;
        }
        break;
      }
      case 'Fallback': break; // mc:AlternateContent repeats the mc:Choice content for older readers
      case 'del': case 'delText': case 'instrText': case 'pPr': case 'rPr': case 'footnoteReference': case 'endnoteReference': break;
      case 'p': s += (s ? '\n' : '') + inline(k, rels, links, depth + 1); break; // text boxes nest whole paragraphs
      default: s += inline(k, rels, links, depth + 1); // r, ins, smartTag, fldSimple, sdt, sdtContent…
    }
  }
  return s;
}

interface StyleInfo { name: string; outline?: number; numPr?: XEl; basedOn?: string }

function readStyles(pkg: Package): Map<string, StyleInfo> {
  const out = new Map<string, StyleInfo>();
  for (const st of kids(child(pkg.xml('word/styles.xml'), 'styles'), 'style')) {
    const id = attr(st, 'styleId');
    if (!id) { continue; }
    const pPr = child(st, 'pPr');
    const ol = attr(child(pPr, 'outlineLvl'), 'val');
    out.set(id, {
      name: attr(child(st, 'name'), 'val') ?? id,
      outline: ol !== undefined && /^\d$/.test(ol) ? Number(ol) : undefined,
      numPr: child(pPr, 'numPr'),
      basedOn: attr(child(st, 'basedOn'), 'val'),
    });
  }
  return out;
}

/** Heading level from the style id ("Heading2"), its name ("heading 2", also localised ids) or its outline level. */
function headingLevel(id: string, style: StyleInfo | undefined, pPr: XEl | undefined): number {
  const own = /^(?:heading|berschrift|titre|titolo|kop)\s*([1-6])$/i.exec(id) ?? /^heading ([1-6])$/i.exec(style?.name ?? '');
  if (own) { return Number(own[1]); }
  if (/^title$/i.test(id) || /^title$/i.test(style?.name ?? '')) { return 1; }
  const ol = attr(child(pPr, 'outlineLvl'), 'val') ?? (style?.outline !== undefined ? String(style.outline) : undefined);
  return ol !== undefined && /^[0-5]$/.test(ol) ? Number(ol) + 1 : 0;
}

/** numbering.xml → "numId:ilvl" → numFmt ("bullet", "decimal", …). */
function readNumbering(pkg: Package): Map<string, string> {
  const root = child(pkg.xml('word/numbering.xml'), 'numbering');
  const abstract = new Map<string, Map<number, string>>();
  for (const a of kids(root, 'abstractNum')) {
    const lv = new Map<number, string>();
    for (const l of kids(a, 'lvl')) { lv.set(Number(attr(l, 'ilvl') ?? 0), attr(child(l, 'numFmt'), 'val') ?? 'decimal'); }
    abstract.set(attr(a, 'abstractNumId') ?? '', lv);
  }
  const out = new Map<string, string>();
  for (const num of kids(root, 'num')) {
    const lv = abstract.get(attr(child(num, 'abstractNumId'), 'val') ?? '');
    const id = attr(num, 'numId');
    if (!lv || !id) { continue; }
    for (const [ilvl, fmt] of lv) { out.set(`${id}:${ilvl}`, fmt); }
  }
  return out;
}

/* ------------------------------------------------------------------ xlsx */

const MAX_ROWS = 500;
const MAX_COLS = 50;
const DATE_BUILTINS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Excel workbook → one "## Sheet" Markdown table per sheet, values as displayed (dates in ISO form). */
export function xlsxToDoc(buf: Buffer): ExtractedDoc {
  const pkg = open(buf, 'xl/workbook.xml', 'Excel');
  const doc = newDoc('xlsx');
  coreProps(pkg, doc);
  const wb = child(pkg.xml('xl/workbook.xml'), 'workbook');
  const date1904 = /^(1|true)$/i.test(attr(child(wb, 'workbookPr'), 'date1904') ?? '');
  const rels = pkg.rels('xl/workbook.xml');
  const shared = kids(child(pkg.xml('xl/sharedStrings.xml'), 'sst'), 'si').map(richText);
  const dateStyles = readDateStyles(pkg);
  const sheets = kids(child(wb, 'sheets'), 'sheet');
  const parts: string[] = [];
  for (const sh of sheets) {
    const name = attr(sh, 'name') ?? `Sheet ${parts.length + 1}`;
    const rel = rels.get(attr(sh, 'id', true) ?? '');
    const target = rel && !rel.external ? rel.target : undefined;
    const ws = target ? child(pkg.xml(target), 'worksheet') : undefined;
    const hidden = attr(sh, 'state') === 'hidden' || attr(sh, 'state') === 'veryHidden';
    const heading = `## ${name.replace(/\s+/g, ' ').trim()}${hidden ? ' (hidden)' : ''}`;
    if (!ws) { parts.push(`${heading}\n\n_(sheet not found)_`); continue; }
    const sheetRels = pkg.rels(target!);
    parts.push(`${heading}\n\n${sheetTable(ws, shared, dateStyles, date1904, sheetRels, doc.links)}`);
    addRelLinks(doc.links, sheetRels);
  }
  doc.pages = sheets.length;
  doc.markdown = parts.join('\n\n');
  return doc;
}

/** Shared or inline string: rich-text runs concatenated, phonetic guides (rPh) left out. */
function richText(si: XEl): string {
  let s = '';
  for (const k of si.kids) {
    if (!isEl(k)) { continue; }
    if (k.local === 't') { s += textAll(k); } else if (k.local === 'r') { s += textAll(child(k, 't')); }
  }
  return s;
}

/** cellXfs index → 'date' | 'time' | 'datetime' for number formats that display dates. */
function readDateStyles(pkg: Package): Map<number, 'date' | 'time' | 'datetime'> {
  const ss = child(pkg.xml('xl/styles.xml'), 'styleSheet');
  const custom = new Map<number, string>();
  for (const f of kids(child(ss, 'numFmts'), 'numFmt')) { custom.set(Number(attr(f, 'numFmtId')), attr(f, 'formatCode') ?? ''); }
  const out = new Map<number, 'date' | 'time' | 'datetime'>();
  kids(child(ss, 'cellXfs'), 'xf').forEach((xf, i) => {
    const id = Number(attr(xf, 'numFmtId') ?? 0);
    const code = custom.get(id);
    const kind = code !== undefined ? dateKind(code) : DATE_BUILTINS.has(id) ? (id === 22 ? 'datetime' : id >= 18 ? 'time' : 'date') : undefined;
    if (kind) { out.set(i, kind); }
  });
  return out;
}

/** Whether a number format code shows a date and/or time (quoted text, escapes, colours and locales ignored). */
function dateKind(code: string): 'date' | 'time' | 'datetime' | undefined {
  const f = code.split(';')[0].replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/[_*]./g, '')
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, '');
  if (!/[dmyhs]/i.test(f)) { return undefined; }
  const time = /[hs]/i.test(f);
  const date = /[dy]/i.test(f) || (/m/i.test(f) && !time);
  return date && time ? 'datetime' : time ? 'time' : 'date';
}

/** Excel serial date → ISO 8601 (1900 system with its Lotus leap-year bug, or the 1904 system). */
function serialToIso(serial: number, kind: 'date' | 'time' | 'datetime', date1904: boolean): string | undefined {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) { return undefined; }
  const base = date1904 ? Date.UTC(1904, 0, 1) : serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const iso = new Date(base + Math.round(serial * 86400) * 1000).toISOString();
  if (kind === 'time' && serial < 1) { return iso.slice(11, 19); }
  if (kind === 'date' || (kind !== 'time' && Number.isInteger(serial))) { return iso.slice(0, 10); }
  return iso.slice(0, 19);
}

function colIndex(ref: string): number {
  let c = 0;
  for (const ch of ref.toUpperCase()) {
    const v = ch.charCodeAt(0) - 64;
    if (v < 1 || v > 26) { break; }
    c = c * 26 + v;
  }
  return c - 1;
}

function sheetTable(ws: XEl, shared: string[], dateStyles: Map<number, string>, date1904: boolean,
  rels: Map<string, Rel>, links: DocLink[]): string {
  const grid = new Map<number, Map<number, string>>();
  let nextRow = 0; let maxCol = -1; let minCol = Infinity;
  for (const row of kids(child(ws, 'sheetData'), 'row')) {
    const rAttr = Number(attr(row, 'r'));
    const r = Number.isInteger(rAttr) && rAttr > 0 ? rAttr - 1 : nextRow;
    nextRow = r + 1;
    let nextCol = 0;
    for (const c of kids(row, 'c')) {
      const ref = attr(c, 'r');
      const col = ref ? colIndex(ref) : nextCol;
      nextCol = col + 1;
      if (col < 0 || col > 16383) { continue; }
      const value = cellValue(c, shared, dateStyles, date1904);
      if (!value) { continue; }
      let cells = grid.get(r);
      if (!cells) { cells = new Map(); grid.set(r, cells); }
      cells.set(col, value);
      maxCol = Math.max(maxCol, col); minCol = Math.min(minCol, col);
    }
  }
  for (const h of kids(child(ws, 'hyperlinks'), 'hyperlink')) {
    const rel = rels.get(attr(h, 'id', true) ?? '');
    const ref = /^([A-Z]+)(\d+)/i.exec(attr(h, 'ref') ?? '');
    if (rel?.external) { addLink(links, rel.target, ref ? grid.get(Number(ref[2]) - 1)?.get(colIndex(ref[1])) ?? '' : ''); }
  }
  if (maxCol < 0) { return '_(empty sheet)_'; }
  const rowIds = [...grid.keys()].sort((a, b) => a - b);
  const lastCol = Math.min(maxCol, minCol + MAX_COLS - 1);
  const rows = rowIds.slice(0, MAX_ROWS).map((r) => {
    const cells = grid.get(r)!;
    return Array.from({ length: lastCol - minCol + 1 }, (_, i) => cells.get(minCol + i) ?? '');
  });
  const notes: string[] = [];
  if (rowIds.length > MAX_ROWS) { notes.push(`first ${MAX_ROWS} of ${rowIds.length} rows`); }
  if (maxCol > lastCol) { notes.push(`first ${MAX_COLS} of ${maxCol - minCol + 1} columns`); }
  return mdTable(rows) + (notes.length ? `\n\n_Showing ${notes.join(' and ')}._` : '');
}

function cellValue(c: XEl, shared: string[], dateStyles: Map<number, string>, date1904: boolean): string {
  const t = attr(c, 't') ?? 'n';
  const v = textAll(child(c, 'v'));
  switch (t) {
    case 's': return shared[Number(v)] ?? '';
    case 'inlineStr': { const is = child(c, 'is'); return is ? richText(is) : v; }
    case 'str': case 'e': case 'd': return v;
    case 'b': return v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : v;
  }
  if (!v.trim()) { return ''; }
  const num = Number(v);
  if (!Number.isFinite(num)) { return v; }
  const kind = dateStyles.get(Number(attr(c, 's') ?? 0)) as 'date' | 'time' | 'datetime' | undefined;
  if (kind) { const iso = serialToIso(num, kind, date1904); if (iso) { return iso; } }
  return String(parseFloat(num.toPrecision(15)));
}

/* ------------------------------------------------------------------ pptx */

const SKIP_PLACEHOLDERS = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg']);

/** PowerPoint deck → slides in presentation order, titles as "## ", bodies as lists, tables, speaker notes. */
export function pptxToDoc(buf: Buffer): ExtractedDoc {
  const pkg = open(buf, 'ppt/presentation.xml', 'PowerPoint');
  const doc = newDoc('pptx');
  coreProps(pkg, doc);
  const presRels = pkg.rels('ppt/presentation.xml');
  const ids = kids(child(child(pkg.xml('ppt/presentation.xml'), 'presentation'), 'sldIdLst'), 'sldId');
  let slideParts = ids.map((s) => presRels.get(attr(s, 'id', true) ?? '')).filter((r): r is Rel => !!r && !r.external).map((r) => r.target);
  if (!slideParts.length) {
    // No usable slide list: fall back to the slide parts in numeric order.
    const num = (n: string) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0);
    slideParts = pkg.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n)).sort((a, b) => num(a) - num(b));
  }
  const pages: string[] = [];
  slideParts.forEach((part, i) => {
    const sld = child(pkg.xml(part), 'sld');
    const rels = pkg.rels(part);
    const { title, body } = slideText(sld, rels, doc.links);
    const blocks: string[] = [];
    if (title) { blocks.push(`## ${title}`); }
    blocks.push(...body);
    const notesRel = [...rels.values()].find((r) => !r.external && r.type.endsWith('/notesSlide'));
    if (notesRel) {
      const notes = notesText(child(pkg.xml(notesRel.target), 'notes'));
      if (notes.length) { blocks.push(`> Notes: ${notes.join('\n> ')}`); }
    }
    addRelLinks(doc.links, rels);
    pages.push(`<!-- page ${i + 1} -->\n\n${blocks.join('\n\n')}`.trimEnd());
    if (!doc.title && title && i === 0) { doc.title = title; }
  });
  doc.pages = slideParts.length;
  doc.markdown = pages.join('\n\n');
  return doc;
}

function placeholderType(sp: XEl): string | undefined {
  for (const nv of ['nvSpPr', 'nvGraphicFramePr', 'nvPicPr', 'nvGrpSpPr']) {
    const ph = path(sp, nv, 'nvPr', 'ph');
    if (ph) { return attr(ph, 'type') ?? 'body'; }
  }
  return undefined;
}

/** DrawingML paragraphs of a text body, as lines (bullets where the shape or paragraph asks for them). */
function paragraphs(txBody: XEl | undefined, bulleted: boolean, rels: Map<string, Rel>, links: DocLink[]): string[] {
  const out: string[] = [];
  for (const p of kids(txBody, 'p')) {
    let s = '';
    for (const k of p.kids) {
      if (!isEl(k)) { continue; }
      if (k.local === 'br') { s += '\n'; continue; }
      if (k.local !== 'r' && k.local !== 'fld') { continue; }
      const t = textAll(child(k, 't'));
      const link = rels.get(attr(path(k, 'rPr', 'hlinkClick'), 'id', true) ?? '');
      if (link?.external && isWebUrl(link.target) && t.trim()) {
        addLink(links, link.target, t);
        s += `[${t.trim()}](${link.target.replace(/[()\s]/g, encodeURIComponent)})`;
      } else {
        s += t;
      }
    }
    s = s.replace(/[ \t]+/g, ' ').trim();
    if (!s) { continue; }
    const pPr = child(p, 'pPr');
    const lvl = Math.min(8, Number(attr(pPr, 'lvl') ?? 0) || 0);
    const bullet = child(pPr, 'buNone') ? false : child(pPr, 'buChar') || child(pPr, 'buAutoNum') ? true : bulleted;
    out.push(bullet ? `${'  '.repeat(lvl)}- ${s.replace(/\n/g, `\n${'  '.repeat(lvl + 1)}`)}` : s);
  }
  return out;
}

function slideText(sld: XEl | undefined, rels: Map<string, Rel>, links: DocLink[]): { title: string; body: string[] } {
  let title = '';
  const body: string[] = [];
  const visit = (tree: XEl | undefined, depth: number): void => {
    if (!tree || depth > 32) { return; }
    for (const sp of tree.kids) {
      if (!isEl(sp)) { continue; }
      if (sp.local === 'grpSp') { visit(sp, depth + 1); continue; }
      if (sp.local === 'graphicFrame') {
        for (const tbl of findAll(sp, 'tbl')) {
          const rows = kids(tbl, 'tr').map((tr) => kids(tr, 'tc').map((tc) => paragraphs(child(tc, 'txBody'), false, rels, links).join(' ')));
          if (rows.length) { body.push(mdTable(rows)); }
        }
        continue;
      }
      if (sp.local !== 'sp') { continue; }
      const ph = placeholderType(sp);
      if (ph && SKIP_PLACEHOLDERS.has(ph)) { continue; }
      const lines = paragraphs(child(sp, 'txBody'), ph === 'body' || ph === 'obj', rels, links);
      if (!lines.length) { continue; }
      if ((ph === 'title' || ph === 'ctrTitle') && !title) { title = lines.join(' ').replace(/^- /, '').replace(/\s+/g, ' '); continue; }
      body.push(lines.join('\n'));
    }
  };
  visit(path(sld, 'cSld', 'spTree'), 0);
  return { title, body };
}

/** Speaker notes: the notes body placeholder(s), without the slide image, number or header/footer. */
function notesText(notes: XEl | undefined): string[] {
  const out: string[] = [];
  for (const sp of findAll(path(notes, 'cSld', 'spTree'), 'sp')) {
    const ph = placeholderType(sp);
    if (ph && ph !== 'body') { continue; }
    for (const p of kids(child(sp, 'txBody'), 'p')) {
      const s = findAll(p, 't').map(textAll).join('').replace(/\s+/g, ' ').trim();
      if (s) { out.push(s); }
    }
  }
  return out;
}
