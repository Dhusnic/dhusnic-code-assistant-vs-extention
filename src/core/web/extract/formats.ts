/**
 * Non-HTML text formats (JSON, XML/feeds/sitemaps, CSV, plain text, Markdown), image header sniffing and
 * charset decoding. Each converter produces compact Markdown the model can read directly.
 */
import { TextDecoder } from 'util';
import { DocLink, ExtractedDoc } from '../types';
import { CP1252_HIGH, MElement, collapse, findAll, htmlToDoc, isoDate, longestRun, parseMarkup, resolveUrl, textOf } from './html';

const fence = (lang: string, body: string) => {
  const ticks = longestRun(body, '`', 2) + 1;
  return `${'`'.repeat(ticks)}${lang}\n${body}\n${'`'.repeat(ticks)}`;
};

const doc = (kind: ExtractedDoc['kind'], markdown: string, extra: Partial<ExtractedDoc> = {}): ExtractedDoc =>
  ({ kind, markdown, links: [], images: [], warnings: [], ...extra });

/* ------------------------------------------------------------------ JSON */

const JSON_LIMIT = 200_000;

/** Pretty-prints JSON; very large documents become a structural summary so they stay readable. */
export function jsonToDoc(text: string): ExtractedDoc {
  let value: unknown;
  try { value = JSON.parse(text.replace(/^﻿/, '')); } catch (e) {
    const d = textToDoc(text, 'text');
    d.warnings.push(`Invalid JSON (${(e as Error).message}); shown as text`);
    return d;
  }
  const pretty = JSON.stringify(value, null, 2) ?? 'null';
  if (pretty.length <= JSON_LIMIT) { return doc('json', fence('json', pretty)); }
  return doc('json', summarizeJson(value, pretty.length), { warnings: [`Large JSON (${pretty.length} characters pretty-printed); showing a structural summary`] });
}

function describe(v: unknown): string {
  if (Array.isArray(v)) { return `array(${v.length})`; }
  if (v === null) { return 'null'; }
  if (typeof v === 'object') { return `object(${Object.keys(v as object).length} keys)`; }
  if (typeof v === 'string') { return v.length > 60 ? `string(${v.length})` : JSON.stringify(v); }
  return String(v);
}

function sample(v: unknown, max = 4000): string {
  const s = JSON.stringify(v, null, 2) ?? 'null';
  return s.length > max ? `${s.slice(0, max)}\n… [${s.length - max} more characters]` : s;
}

function summarizeJson(value: unknown, size: number): string {
  const out: string[] = [];
  if (Array.isArray(value)) {
    out.push(`JSON array with ${value.length} items (${size} characters pretty-printed).`, '', 'First items:', '');
    out.push(fence('json', value.slice(0, 5).map((x) => sample(x)).join(',\n')));
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value as object);
    out.push(`JSON object with ${keys.length} top-level keys (${size} characters pretty-printed).`, '');
    for (const k of keys.slice(0, 100)) { out.push(`- \`${k}\`: ${describe((value as Record<string, unknown>)[k])}`); }
    if (keys.length > 100) { out.push(`- … ${keys.length - 100} more keys`); }
    out.push('', 'First values:', '');
    const head: Record<string, unknown> = {};
    for (const k of keys.slice(0, 5)) {
      const v = (value as Record<string, unknown>)[k];
      head[k] = Array.isArray(v) ? v.slice(0, 3) : v;
    }
    out.push(fence('json', sample(head, 20_000)));
  } else {
    out.push(fence('json', sample(value, JSON_LIMIT)));
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ XML, feeds, sitemaps */

const child = (e: MElement, ...names: string[]) =>
  e.children.find((c): c is MElement => c.type === 'el' && names.includes(c.tag));
const children = (e: MElement, name: string) => e.children.filter((c): c is MElement => c.type === 'el' && c.tag === name);
const text = (e: MElement | undefined) => (e ? collapse(textOf(e)).trim() : '');

const SUMMARY_MAX = 500;
const MAX_ITEMS = 200;
const MAX_SITEMAP = 1000;

/** RSS / Atom / RDF feeds become item lists, sitemaps become URL lists, anything else is shown fenced. */
export function xmlToDoc(xml: string, url: string): ExtractedDoc {
  const tree = parseMarkup(xml, true);
  const root = tree.children.find((c): c is MElement => c.type === 'el');
  const name = root?.tag ?? '';
  if (root && (name === 'rss' || name === 'feed' || name === 'rdf:rdf')) { return feedToDoc(root, url); }
  if (root && (name === 'urlset' || name === 'sitemapindex')) { return sitemapToDoc(root, url); }
  const d = doc('xml', fence('xml', xml.trim()));
  if (root) { d.title = name; }
  return d;
}

interface FeedItem { title: string; link?: string; date?: string; author?: string; summary: string }

function feedToDoc(root: MElement, base: string): ExtractedDoc {
  const atom = root.tag === 'feed';
  const channel = root.tag === 'rss' ? child(root, 'channel') ?? root : root;
  const rdfChannel = root.tag === 'rdf:rdf' ? child(root, 'channel') : undefined;
  const title = text(child(rdfChannel ?? channel, 'title'));
  const description = text(child(rdfChannel ?? channel, 'description', 'subtitle'));
  const entries = atom ? children(root, 'entry') : children(channel, 'item');
  const items: FeedItem[] = entries.slice(0, MAX_ITEMS).map((e) => {
    const linkEl = atom
      ? e.children.find((c): c is MElement => c.type === 'el' && c.tag === 'link' && (!c.attrs.rel || c.attrs.rel === 'alternate')) ?? child(e, 'link')
      : child(e, 'link');
    const rawLink = atom ? linkEl?.attrs.href ?? '' : text(linkEl) || linkEl?.attrs.href || text(child(e, 'guid'));
    const link = rawLink ? resolveUrl(rawLink, base) : undefined;
    const date = isoDate(text(child(e, 'pubdate', 'published', 'updated', 'dc:date', 'date')));
    const authorEl = child(e, 'author', 'dc:creator', 'creator');
    const author = authorEl ? text(child(authorEl, 'name')) || text(authorEl) : undefined;
    const body = child(e, 'description', 'summary', 'content:encoded', 'content');
    const summary = body ? clip(htmlToDoc(textOf(body), link ?? base).markdown.replace(/\n{2,}/g, '\n'), SUMMARY_MAX) : '';
    return { title: text(child(e, 'title')) || '(untitled)', link: link && /^https?:/i.test(link) ? link : undefined, date, author: author || undefined, summary };
  });
  const out: string[] = [];
  if (title) { out.push(`# ${title}`, ''); }
  if (description) { out.push(description, ''); }
  for (const it of items) {
    out.push(it.link ? `### [${it.title}](${it.link})` : `### ${it.title}`);
    const by = [it.date ? `_${it.date}_` : '', it.author ?? ''].filter(Boolean).join(' · ');
    if (by) { out.push(by); }
    if (it.summary) { out.push('', it.summary); }
    out.push('');
  }
  const links: DocLink[] = [];
  const seen = new Set<string>();
  for (const it of items) { if (it.link && !seen.has(it.link)) { seen.add(it.link); links.push({ text: it.title.slice(0, 120), url: it.link }); } }
  const d = doc('feed', out.join('\n').trim(), { links });
  if (title) { d.title = title; }
  if (description) { d.description = description; }
  if (entries.length > MAX_ITEMS) { d.warnings.push(`Feed has ${entries.length} items; showing the first ${MAX_ITEMS}`); }
  return d;
}

function sitemapToDoc(root: MElement, base: string): ExtractedDoc {
  const index = root.tag === 'sitemapindex';
  const entries = findAll(root, (e) => e.tag === (index ? 'sitemap' : 'url'), true);
  const out: string[] = [`# ${index ? 'Sitemap index' : 'Sitemap'} (${entries.length} ${index ? 'sitemaps' : 'URLs'})`, ''];
  const links: DocLink[] = [];
  const seen = new Set<string>();
  for (const e of entries.slice(0, MAX_SITEMAP)) {
    const loc = resolveUrl(text(child(e, 'loc')), base);
    if (!loc || !/^https?:/i.test(loc) || seen.has(loc)) { continue; }
    seen.add(loc);
    const mod = text(child(e, 'lastmod'));
    out.push(`- ${loc}${mod ? ` (${mod})` : ''}`);
    links.push({ text: '', url: loc });
  }
  const d = doc('xml', out.join('\n'), { links, title: index ? 'Sitemap index' : 'Sitemap' });
  if (entries.length > MAX_SITEMAP) { d.warnings.push(`Sitemap lists ${entries.length} entries; showing the first ${MAX_SITEMAP}`); }
  return d;
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/* ------------------------------------------------------------------ CSV */

const CSV_ROWS = 200;

/** RFC 4180 parser: quoted fields, doubled quotes, newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string, delimiter: string, maxRows = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  const d = delimiter;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      const q = text.indexOf('"', i);
      const end = q < 0 ? n : q;
      field += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === d) { row.push(field); field = ''; i++; continue; }
    if (c === '\n' || c === '\r') {
      row.push(field); field = '';
      rows.push(row); row = [];
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      if (rows.length >= maxRows) { return rows; }
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Picks the delimiter that gives the most consistent multi-column split of the first lines. */
export function detectDelimiter(text: string): string {
  const head = text.slice(0, 20_000);
  let best = ',';
  let bestScore = 0;
  for (const d of [',', ';', '\t', '|']) {
    const rows = parseCsv(head, d, 20).filter((r) => r.length > 1 || r[0] !== '');
    if (rows.length > 1 && head.length === 20_000) { rows.pop(); }
    if (!rows.length) { continue; }
    const counts = new Map<number, number>();
    for (const r of rows) { counts.set(r.length, (counts.get(r.length) ?? 0) + 1); }
    let mode = 1;
    let freq = 0;
    for (const [len, f] of counts) { if (f > freq || (f === freq && len > mode)) { mode = len; freq = f; } }
    if (mode < 2) { continue; }
    const score = (freq / rows.length) * 100 + mode;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

const cell = (s: string) => s.trim().replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

/** CSV/TSV as a Markdown table of the first 200 rows plus a size summary. */
export function csvToDoc(text: string, delimiter?: string): ExtractedDoc {
  const body = text.replace(/^﻿/, '');
  const d = delimiter ?? detectDelimiter(body);
  const rows = parseCsv(body, d).filter((r) => r.length > 1 || r[0].trim() !== '');
  if (!rows.length) { return doc('csv', '_Empty CSV file._'); }
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const dataRows = rows.length - 1;
  const line = (r: string[]) => `| ${Array.from({ length: cols }, (_, k) => cell(r[k] ?? '')).join(' | ')} |`;
  const shown = rows.slice(1, CSV_ROWS + 1);
  const table = [line(rows[0]), `| ${Array(cols).fill('---').join(' | ')} |`, ...shown.map(line)].join('\n');
  const label = d === '\t' ? 'tab' : `"${d}"`;
  const summary = `${dataRows} rows × ${cols} columns (delimiter ${label}${dataRows > CSV_ROWS ? `; showing the first ${CSV_ROWS} rows` : ''})`;
  return doc('csv', `${summary}\n\n${table}`);
}

/* ------------------------------------------------------------------ text / markdown */

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/g;

/** Plain text or Markdown, with the URLs it mentions collected as links. */
export function textToDoc(text: string, kind: 'text' | 'markdown'): ExtractedDoc {
  const body = text.replace(/^﻿/, '');
  const d = doc(kind, body);
  if (kind === 'markdown') {
    // Closing hashes are stripped by hand: a lazy `(.+?)\s*#*\s*$` backtracks quadratically on long space runs.
    const h = /^#[ \t]+(\S.*)$/m.exec(body);
    if (h) {
      let t = h[1].trimEnd();
      let e = t.length;
      while (e > 0 && t[e - 1] === '#') { e--; }
      const core = t.slice(0, e);
      if (core !== t && (core === '' || /[ \t]$/.test(core))) { t = core.trimEnd(); }
      if (t) { d.title = t; }
    }
  }
  const seen = new Set<string>();
  const md = /\[([^\]\n]{0,200})\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = md.exec(body)) !== null && d.links.length < 300) {
    if (!seen.has(m[2])) { seen.add(m[2]); d.links.push({ text: m[1].trim().slice(0, 120), url: m[2] }); }
  }
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(body)) !== null && d.links.length < 300) {
    const u = m[0].replace(/[.,;:!?]+$/, '');
    if (!seen.has(u)) { seen.add(u); d.links.push({ text: '', url: u }); }
  }
  return d;
}

/* ------------------------------------------------------------------ images */

export interface ImageInfo { format: string; width?: number; height?: number }

/** Image format and pixel size from the file header (no decoding). */
export function imageInfo(buf: Buffer): ImageInfo | undefined {
  try { return sniffImage(buf); } catch { return undefined; }
}

function sniffImage(b: Buffer): ImageInfo | undefined {
  const len = b.length;
  if (len < 4) { return undefined; }
  if (len >= 24 && b.readUInt32BE(0) === 0x89504E47 && b.readUInt32BE(4) === 0x0D0A1A0A) {
    return { format: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) { return { format: 'jpeg', ...jpegSize(b) }; }
  if (len >= 10 && b.toString('latin1', 0, 6).match(/^GIF8[79]a$/)) {
    return { format: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (len >= 16 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    return { format: 'webp', ...webpSize(b) };
  }
  // "BM" alone is too weak (plain text can start with it): also require zero reserved bytes and a known DIB header size.
  if (len >= 26 && b[0] === 0x42 && b[1] === 0x4D && b.readUInt32LE(6) === 0 && [12, 40, 52, 56, 64, 108, 124].includes(b.readUInt32LE(14))) {
    if (b.readUInt32LE(14) === 12) { return { format: 'bmp', width: b.readUInt16LE(18), height: b.readUInt16LE(20) }; }
    return { format: 'bmp', width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
  }
  if (len >= 8 && b.readUInt32BE(0) === 0x00000100 && b.readUInt16LE(4) > 0 && b.readUInt16LE(4) < 256) {
    return len >= 22 ? { format: 'ico', width: b[6] || 256, height: b[7] || 256 } : { format: 'ico' };
  }
  const tiff = b.toString('latin1', 0, 4);
  if (tiff === 'II*\0' || tiff === 'MM\0*') { return { format: 'tiff', ...tiffSize(b, tiff === 'II*\0') }; }
  if (len >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
    const brands = b.toString('latin1', 8, Math.min(len, 8 + Math.max(8, b.readUInt32BE(0) - 8)));
    const format = /avi[fs]/.test(brands) ? 'avif' : /hei[cxms]|hev[cx]|mif1/.test(brands) ? 'heic' : undefined;
    if (format) { return { format, ...ispeSize(b) }; }
  }
  return svgSize(b);
}

function jpegSize(b: Buffer): { width?: number; height?: number } {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xFF) { i++; continue; }
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    if (m === 0xD9 || m === 0xDA) { break; }
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return {};
}

function webpSize(b: Buffer): { width?: number; height?: number } {
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ' && b.length >= 30) { return { width: b.readUInt16LE(26) & 0x3FFF, height: b.readUInt16LE(28) & 0x3FFF }; }
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2F) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3FFF) + 1, height: ((bits >>> 14) & 0x3FFF) + 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30) { return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }; }
  return {};
}

function tiffSize(b: Buffer, le: boolean): { width?: number; height?: number } {
  const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  if (b.length < 8) { return {}; }
  const ifd = u32(4);
  if (ifd + 2 > b.length) { return {}; }
  const count = u16(ifd);
  const r: { width?: number; height?: number } = {};
  for (let k = 0; k < count; k++) {
    const o = ifd + 2 + k * 12;
    if (o + 12 > b.length) { break; }
    const tag = u16(o);
    const type = u16(o + 2);
    const v = type === 3 ? u16(o + 8) : u32(o + 8);
    if (tag === 256) { r.width = v; } else if (tag === 257) { r.height = v; }
  }
  return r;
}

function ispeSize(b: Buffer): { width?: number; height?: number } {
  const at = b.indexOf('ispe', 0, 'latin1');
  if (at < 0 || at + 16 > b.length || at > 1 << 20) { return {}; }
  return { width: b.readUInt32BE(at + 8), height: b.readUInt32BE(at + 12) };
}

function svgSize(b: Buffer): ImageInfo | undefined {
  const head = b.toString('utf8', 0, Math.min(b.length, 4096)).replace(/^﻿/, '');
  if (!/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)) { return undefined; }
  const tag = /<svg\b[^>]*>/i.exec(head)?.[0] ?? '';
  const num = (name: string) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']?\\s*([\\d.]+)(px)?\\s*["']?(?=[\\s/>])`, 'i').exec(tag);
    return m ? Math.round(Number(m[1])) : undefined;
  };
  let width = num('width');
  let height = num('height');
  const vb = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
  if (vb) { width ??= Math.round(Number(vb[1])); height ??= Math.round(Number(vb[2])); }
  const info: ImageInfo = { format: 'svg' };
  if (width) { info.width = width; }
  if (height) { info.height = height; }
  return info;
}

/* ------------------------------------------------------------------ charsets */

function decode1252(b: Buffer): string {
  let s = '';
  const CHUNK = 8192;
  for (let i = 0; i < b.length; i += CHUNK) {
    const end = Math.min(b.length, i + CHUNK);
    const codes = new Array<number>(end - i);
    for (let k = i; k < end; k++) { const c = b[k]; codes[k - i] = c >= 0x80 && c <= 0x9F ? CP1252_HIGH[c - 0x80] : c; }
    s += String.fromCharCode(...codes);
  }
  return s;
}

function decodeUtf16be(b: Buffer): string {
  const even = b.length & ~1;
  const swapped = Buffer.allocUnsafe(even);
  for (let i = 0; i < even; i += 2) { swapped[i] = b[i + 1]; swapped[i + 1] = b[i]; }
  return swapped.toString('utf16le');
}

/** Charset from a Content-Type header value. */
const charsetParam = (ct?: string) => /charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(ct ?? '')?.[1];

/** Charset declared inside the document: HTML <meta charset> / http-equiv, or the XML declaration. */
function sniffCharset(b: Buffer): string | undefined {
  const head = b.toString('latin1', 0, Math.min(b.length, 2048));
  const xml = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
  if (xml) { return xml[1]; }
  const meta = /<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
  return meta?.[1];
}

/** Decodes a body to text: BOM, explicit charset, Content-Type parameter, then in-document declarations. Never throws. */
export function decodeText(buf: Buffer, charset?: string, contentType?: string): string {
  try {
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) { return buf.toString('utf8', 3); }
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) { return buf.toString('utf16le', 2); }
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) { return decodeUtf16be(buf.subarray(2)); }
    let label = (charset || charsetParam(contentType) || '').replace(/["']/g, '').trim().toLowerCase();
    if (!label) {
      // A UTF-16 declaration readable as ASCII is a lie (real UTF-16 has a BOM or NULs); browsers use UTF-8 then.
      label = (sniffCharset(buf) ?? 'utf-8').toLowerCase();
      if (label.startsWith('utf-16') || label === 'ucs-2') { label = 'utf-8'; }
    }
    switch (label) {
      case 'utf-8': case 'utf8': case 'unicode-1-1-utf-8': return buf.toString('utf8');
      case 'utf-16': case 'utf-16le': case 'utf16le': case 'ucs-2': return buf.toString('utf16le');
      case 'utf-16be': case 'utf16be': return decodeUtf16be(buf);
      // As in browsers, the Latin-1 and ASCII labels decode as windows-1252.
      case 'latin1': case 'iso-8859-1': case 'iso8859-1': case 'iso_8859-1': case 'l1': case 'cp819': case 'ibm819':
      case 'us-ascii': case 'ascii': case 'windows-1252': case 'cp1252': case 'x-cp1252':
        return decode1252(buf);
    }
    try { return new TextDecoder(label).decode(buf); } catch { return buf.toString('utf8'); }
  } catch {
    return buf.toString('utf8');
  }
}
