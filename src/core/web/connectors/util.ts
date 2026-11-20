/**
 * Small helpers shared by the search providers and the R&D connectors: tolerant JSON/shape access,
 * text cleaning, HTTP status → WebError mapping and the common Markdown result shape.
 * Kept free of the HTML extractor on purpose: snippets only need tags and entities removed.
 */
import { ConnectorResult, ConnectorSource, FetchOptions, FetchResponse, HttpFetch, KeyLookup, WebError, clip } from '../types';
import { classifyUrlKind } from './kind';

/** Options every connector accepts. */
export interface ConnectorOpts { keys?: KeyLookup; signal?: AbortSignal }

/** Default cap for a connector's Markdown (the model reads it whole). */
export const MAX_MARKDOWN = 12_000;

/* ------------------------------------------------------------------ text */

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·',
  bull: '•', copy: '©', reg: '®', trade: '™', times: '×', deg: '°', shy: '', zwj: '', zwnj: '',
};

/** Decodes the HTML entities that actually occur in API snippets (single pass, so "&amp;lt;" stays "&lt;"). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Trims and collapses whitespace; non-strings (except numbers) become ''. */
export function clean(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) { return String(v); }
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/** Removes markup from a snippet: scripts/styles dropped, tags removed, entities decoded, whitespace collapsed. */
export function stripTags(html: unknown): string {
  if (typeof html !== 'string') { return clean(html); }
  return clean(decodeEntities(html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, ' ')
    .replace(/<[^>]*>/g, '')));
}

/** Cleans and shortens to `max` characters on a word boundary. */
export function excerpt(v: unknown, max: number): string {
  const s = stripTags(v);
  if (s.length <= max) { return s; }
  const cut = s.lastIndexOf(' ', max - 1);
  return `${s.slice(0, cut > max * 0.6 ? cut : max - 1).replace(/[\s,;:.]+$/, '')}…`;
}

export const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Escapes characters that would break a Markdown table cell. */
export const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/* ------------------------------------------------------------------ shapes */

export const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
export const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {});

/** A finite number from a number or numeric string. */
export function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** YYYY-MM-DD from an ISO-ish string or epoch milliseconds; undefined when unparseable (e.g. "2 days ago"). */
export function isoDate(v: unknown): string | undefined {
  if (typeof v === 'number') { return Number.isFinite(v) ? new Date(v).toISOString().slice(0, 10) : undefined; }
  if (typeof v !== 'string' || !v.trim()) { return undefined; }
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) { return s.slice(0, 10); }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
}

export const epochSecDate = (v: unknown): string | undefined => { const n = num(v); return n === undefined ? undefined : isoDate(n * 1000); };

/* ------------------------------------------------------------------ http */

export interface StatusHints { auth?: string; notFound?: string }

function fmtRetryAfter(v: string): string {
  const n = Number(v);
  if (Number.isFinite(n)) { return `${Math.max(0, Math.round(n))} s`; }
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z') : v;
}

/** The most useful short error text a JSON or HTML error body carries. */
function errorDetail(res: FetchResponse): string {
  const raw = res.body.subarray(0, 4000).toString('utf8');
  try {
    const j = obj(JSON.parse(raw));
    const e = j.error;
    const m = clean(typeof e === 'string' ? e : obj(e).message ?? obj(e).detail) || clean(j.message) || clean(j.detail) || clean(obj(j.detail).error)
      || clean(obj(arr(j.errors)[0]).message) || clean(j.error_message) || clean(j.title);
    if (m) { return excerpt(m, 200); }
  } catch { /* not JSON */ }
  return /<html|<!doctype/i.test(raw) ? '' : excerpt(raw, 160);
}

/** Maps an HTTP status ≥ 400 to a WebError with advice; undefined for success. */
export function httpError(provider: string, res: FetchResponse, hints: StatusHints = {}): WebError | undefined {
  const s = res.status;
  if (s < 400) { return undefined; }
  const detail = errorDetail(res);
  const tail = detail ? ` — ${detail}` : '';
  if (s === 429) {
    const ra = res.headers['retry-after'];
    return new WebError(`${provider}: rate limited (HTTP 429)${ra ? `; retry after ${fmtRetryAfter(ra)}` : '; wait a little before retrying'}${tail}`, 'rate_limited', s);
  }
  if (s === 401 || s === 403) {
    return new WebError(`${provider}: ${hints.auth ?? 'access denied — the API key is invalid or missing, or its quota/rate limit is exhausted'} (HTTP ${s})${tail}`, 'http', s);
  }
  if (s === 404 || s === 410) { return new WebError(`${provider}: ${hints.notFound ?? 'not found'} (HTTP ${s})`, 'http', s); }
  if (s >= 500) { return new WebError(`${provider}: server error (HTTP ${s}); try again later${tail}`, 'http', s); }
  return new WebError(`${provider}: request rejected (HTTP ${s})${tail}`, 'http', s);
}

export function ensureOk(provider: string, res: FetchResponse, hints?: StatusHints): FetchResponse {
  const e = httpError(provider, res, hints);
  if (e) { throw e; }
  return res;
}

/** Parses a JSON object/array body; anything else is a 'parse' WebError naming the provider. */
export function parseJson(provider: string, res: FetchResponse): any {
  let v: unknown;
  try { v = JSON.parse(res.body.toString('utf8').replace(/^﻿/, '')); } catch {
    throw new WebError(`${provider}: response was not valid JSON${res.truncated ? ' (body was truncated)' : ''}`, 'parse');
  }
  if (!v || typeof v !== 'object') { throw new WebError(`${provider}: unexpected response shape`, 'parse'); }
  return v;
}

export async function getJson(http: HttpFetch, provider: string, url: string, opts: FetchOptions = {}, hints?: StatusHints): Promise<any> {
  const res = await http(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers ?? {}) } });
  return parseJson(provider, ensureOk(provider, res, hints));
}

/** Like getJson but resolves undefined on any failure (used for optional enrichment calls). */
export async function tryJson(http: HttpFetch, provider: string, url: string, opts: FetchOptions = {}): Promise<any | undefined> {
  try { return await getJson(http, provider, url, opts); } catch (e) {
    if (opts.signal?.aborted) { throw e; }
    return undefined;
  }
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const isAbort = (e: unknown, signal?: AbortSignal): boolean => !!signal?.aborted || (e instanceof WebError && e.code === 'aborted');

/* ------------------------------------------------------------------ results */

export function source(title: string, url: string, published?: string): ConnectorSource {
  return { title: clean(title) || url, url, kind: classifyUrlKind(url), ...(published ? { published } : {}) };
}

/** Assembles a ConnectorResult, clipping the Markdown to `max` characters. */
export function result(title: string, lines: string[], sources: ConnectorSource[], max = MAX_MARKDOWN): ConnectorResult {
  const seen = new Set<string>();
  const uniq = sources.filter((s) => s.url && !seen.has(s.url) && seen.add(s.url));
  return { title, markdown: clip(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), max), sources: uniq };
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const clampInt = (v: number | undefined, def: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.floor(Number.isFinite(v as number) ? v as number : def)));
