/**
 * Content → Markdown dispatcher. Picks an extractor from the magic bytes first and the Content-Type second,
 * because servers often lie (HTML served as application/octet-stream, PDFs as text/plain). Every extractor is
 * guarded: a failure degrades to best-effort text with a warning instead of failing the whole fetch.
 */
import { DocKind, ExtractedDoc, RawDoc } from '../types';
import { csvToDoc, decodeText, imageInfo, jsonToDoc, textToDoc, xmlToDoc } from './formats';
import { htmlToDoc } from './html';
import { detectInjection, sanitizeText } from './injection';
import { docxToDoc, pptxToDoc, xlsxToDoc } from './office';
import { pdfToDoc } from './pdf';

export { detectInjection, sanitizeText } from './injection';
export { decodeText, imageInfo } from './formats';

const OOXML: Record<string, 'docx' | 'xlsx' | 'pptx'> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

const CSV_TYPES = new Set(['text/csv', 'application/csv', 'text/tab-separated-values', 'text/x-csv', 'application/vnd.ms-excel']);
const MD_TYPES = new Set(['text/markdown', 'text/x-markdown']);
const XML_TYPES = new Set(['application/xml', 'text/xml', 'application/rss+xml', 'application/atom+xml', 'application/rdf+xml']);
const TEXTUAL_APP = /^application\/(?:javascript|ecmascript|x-javascript|x-sh|x-yaml|yaml|toml|x-toml|graphql|sql|x-httpd-php|typescript|x-python|x-tex|x-latex)$/;

function pathExt(url: string): string {
  try { return /\.([a-z0-9]{1,8})$/i.exec(new URL(url).pathname)?.[1].toLowerCase() ?? ''; } catch { return ''; }
}

const startsWith = (b: Buffer, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/** The leading text of the body (BOM and whitespace skipped), lower-cased, for sniffing. */
function head(raw: RawDoc): string {
  return decodeText(raw.body.subarray(0, 1024), raw.charset, raw.contentType).replace(/^﻿/, '').trimStart().slice(0, 512).toLowerCase();
}

/** A body is "binary" when it has NUL bytes or many control characters in its first KB (UTF-16 has a BOM and is handled earlier). */
function looksBinary(b: Buffer): boolean {
  const n = Math.min(b.length, 1024);
  if (!n) { return false; }
  if ((b[0] === 0xFF && b[1] === 0xFE) || (b[0] === 0xFE && b[1] === 0xFF)) { return false; }
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 0) { return true; }
    if (c < 9 || (c > 13 && c < 32)) { ctrl++; }
  }
  return ctrl / n > 0.1;
}

/** Which ZIP-based Office format a PK archive is, from Content-Type, URL extension or the parts it contains. */
function ooxmlKind(raw: RawDoc): DocKind | undefined {
  const byType = OOXML[raw.contentType];
  if (byType) { return byType; }
  const ext = pathExt(raw.url);
  if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') { return ext; }
  // Central-directory names are stored in plain text, so a scan of the archive finds the main part.
  const s = raw.body.toString('latin1');
  if (s.includes('word/document.xml')) { return 'docx'; }
  if (s.includes('xl/workbook.xml')) { return 'xlsx'; }
  if (s.includes('ppt/presentation.xml')) { return 'pptx'; }
  return undefined;
}

/** What kind of document a fetched body is. Magic bytes win over the declared Content-Type. */
export function detectKind(raw: RawDoc): DocKind {
  const b = raw.body;
  const ct = (raw.contentType || '').toLowerCase();
  const ext = pathExt(raw.url);

  // Magic bytes first: servers mislabel. Readers accept %PDF- within the first KB (junk before the header),
  // but a text page that merely mentions "%PDF-" must stay text, so off-start hits need corroboration.
  const pdfAt = b.subarray(0, 1024).indexOf('%PDF-');
  if (pdfAt === 0 || (pdfAt > 0 && (ct === 'application/pdf' || ext === 'pdf' || looksBinary(b)))) { return 'pdf'; }
  if (startsWith(b, [0x50, 0x4B, 0x03, 0x04])) { return ooxmlKind(raw) ?? 'binary'; }
  const info = imageInfo(b);
  // SVG is text and could be any XML; only call it an image when it is declared or named as one.
  if (info && (info.format !== 'svg' || ct === 'image/svg+xml' || ext === 'svg')) { return 'image'; }

  if (looksBinary(b)) { return ct === 'application/pdf' ? 'pdf' : 'binary'; }

  // Text from here on: a declared PDF/Office/image type without its magic bytes is usually an HTML error page,
  // so the sniffing below decides, and an unknown non-text type ends as 'binary'.
  const h = head(raw).replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
  if (/^<!doctype html|^<html[\s>]|^<head[\s>]|^<body[\s>]/.test(h)) { return 'html'; }
  if (ct === 'text/html' || ct === 'application/xhtml+xml') { return 'html'; }
  if (XML_TYPES.has(ct) || ct.endsWith('+xml') || /^<\?xml|^<(rss|feed|rdf:rdf|urlset|sitemapindex)[\s>]/.test(h)) {
    if (/<(rss|feed|rdf:rdf)[\s>]/.test(h) || /<channel[\s>]/.test(h)) { return 'feed'; }
    if (/^<\?xml[^>]*>\s*(<!--[\s\S]*?-->\s*)*<html[\s>]/.test(h)) { return 'html'; }
    return 'xml';
  }
  if (ct === 'application/json' || ct.endsWith('+json') || ext === 'json' || ext === 'geojson') { return 'json'; }
  if ((h.startsWith('{') || h.startsWith('[')) && isJson(raw)) { return 'json'; }
  if (CSV_TYPES.has(ct) || ext === 'csv' || ext === 'tsv') { return 'csv'; }
  if (MD_TYPES.has(ct) || ext === 'md' || ext === 'markdown') { return 'markdown'; }
  if (ct.startsWith('text/') || TEXTUAL_APP.test(ct) || !ct || ct === 'application/octet-stream') { return 'text'; }
  return 'binary';
}

function isJson(raw: RawDoc): boolean {
  try { JSON.parse(decodeText(raw.body, raw.charset, raw.contentType)); return true; } catch { return false; }
}

function binaryDoc(raw: RawDoc, note?: string): ExtractedDoc {
  const type = raw.contentType || 'unknown type';
  return {
    kind: 'binary',
    markdown: `Binary file (${type}, ${raw.body.length} bytes) — download it with web_download to use it.${note ? `\n\n${note}` : ''}`,
    links: [], images: [], warnings: [],
  };
}

function runExtractor(kind: DocKind, raw: RawDoc): ExtractedDoc {
  const text = () => decodeText(raw.body, raw.charset, raw.contentType);
  switch (kind) {
    case 'pdf': return pdfToDoc(raw.body);
    case 'docx': return docxToDoc(raw.body);
    case 'xlsx': return xlsxToDoc(raw.body);
    case 'pptx': return pptxToDoc(raw.body);
    case 'image': {
      const info = imageInfo(raw.body)!;
      const size = info.width && info.height ? `${info.width}×${info.height} px` : 'unknown size';
      return {
        kind: 'image', image: info,
        markdown: `Image: ${info.format.toUpperCase()}, ${size}, ${raw.body.length} bytes.\n\n![image](${raw.url})`,
        links: [], images: [{ url: raw.url, ...(info.width ? { width: info.width } : {}), ...(info.height ? { height: info.height } : {}) }],
        warnings: [],
      };
    }
    case 'html': return htmlToDoc(text(), raw.url);
    case 'feed': case 'xml': return xmlToDoc(text(), raw.url);
    case 'json': return jsonToDoc(text());
    case 'csv': return csvToDoc(text(), raw.contentType === 'text/tab-separated-values' || pathExt(raw.url) === 'tsv' ? '\t' : undefined);
    case 'markdown': return textToDoc(text(), 'markdown');
    case 'text': return textToDoc(text(), 'text');
    default: return binaryDoc(raw);
  }
}

/** Converts a fetched body into Markdown plus metadata, links, images and safety warnings. */
export function extractDocument(raw: RawDoc): ExtractedDoc {
  const kind = detectKind(raw);
  let doc: ExtractedDoc;
  try {
    doc = runExtractor(kind, raw);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (kind === 'pdf' || kind === 'docx' || kind === 'xlsx' || kind === 'pptx' || kind === 'image' || looksBinary(raw.body)) {
      doc = binaryDoc(raw, `It could not be read as ${kind.toUpperCase()}: ${why}`);
      doc.warnings.push(`Could not read the ${kind.toUpperCase()} content: ${why}`);
    } else {
      doc = textToDoc(decodeText(raw.body, raw.charset, raw.contentType), 'text');
      doc.warnings.push(`Could not parse as ${kind}; shown as plain text (${why})`);
    }
  }
  doc.markdown = sanitizeText(doc.markdown);
  for (const k of ['title', 'description', 'author', 'siteName'] as const) {
    if (doc[k] !== undefined) { doc[k] = sanitizeText(doc[k]!).replace(/\s+/g, ' ').trim() || undefined; }
    if (doc[k] === undefined) { delete doc[k]; }
  }
  // HTML runs its own injection scan on the visible text; every other kind is scanned here.
  if (kind !== 'html' && kind !== 'binary' && kind !== 'image') {
    for (const ex of detectInjection(doc.markdown)) {
      const w = `Possible prompt injection: “${ex}”`;
      if (!doc.warnings.includes(w)) { doc.warnings.push(w); }
    }
  }
  return doc;
}
