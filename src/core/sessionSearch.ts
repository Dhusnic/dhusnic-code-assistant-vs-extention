import * as fs from 'fs/promises';
import * as path from 'path';
import { ChatMessage } from './llm';
import { SUMMARY_PREFIX } from './sessions';
import { AgentRecord, LoadedSession } from './store';

/** Full-text search over saved sessions, and Markdown / HTML export of one session. */

export interface SessionMatch { agentId: string; role: string; turn: number; snippet: string; ranges: Array<[number, number]> }
export interface SessionHit { sessionId: string; title: string; updatedAt: number; score: number; matches: SessionMatch[] }
export interface SearchOptions {
  signal?: AbortSignal; limit?: number; perSession?: number; concurrency?: number;
  /** Called as hits are found, in discovery order, at most `limit` times. The returned array is the ranked result. */
  onResult?: (hit: SessionHit) => void;
  /** Only sessions this accepts are searched (e.g. the current workspace's). */
  include?: (sessionId: string) => boolean | Promise<boolean>;
}
export interface ExportOptions { includeTools?: boolean }

const ID_RE = /^[\w-]{1,64}$/;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const SNIPPET_MAX = 160;
const MAX_SPANS_PER_TERM = 200;
const TITLE_WEIGHT = 25, BODY_WEIGHT = 0.5, BODY_HIT_CAP = 20, RECENCY_WEIGHT = 5, RECENCY_HALF_LIFE_DAYS = 14;
const DAY_MS = 86_400_000;

interface Term { all: RegExp; one: RegExp; probe?: RegExp; nonAscii: boolean }
type Span = [number, number];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Splits on whitespace, keeping "quoted phrases" together. Whitespace inside a phrase matches any run of whitespace. */
function parseQuery(query: string): Term[] {
  const seen = new Set<string>(), terms: Term[] = [];
  for (const m of query.matchAll(/"([^"]*)"|(\S+)/g)) {
    const text = (m[1] ?? m[2]).replace(/"/g, '').trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) { continue; }
    seen.add(key);
    const source = text.split(/\s+/).map(escapeRe).join('\\s+');
    // JSON escapes these characters in the raw file, so the raw pre-check only looks for the longest run without them.
    const fragment = text.split(/[\s"\\\u0000-\u001f]+/).reduce((a, b) => (b.length > a.length ? b : a), '');
    terms.push({
      all: new RegExp(source, 'giu'), one: new RegExp(source, 'iu'),
      probe: fragment ? new RegExp(escapeRe(fragment), 'iu') : undefined,
      nonAscii: /[^\x00-\x7f]/.test(fragment),
    });
  }
  return terms;
}

const mayContain = (raw: string, t: Term): boolean => !t.probe || t.probe.test(raw) || (t.nonAscii && raw.includes('\\u'));

/** The text a person would recognise for this message, or undefined for messages that are never searched. */
function searchableText(m: ChatMessage): string | undefined {
  if (!m || m.role === 'system') { return undefined; }
  const content = typeof m.content === 'string' ? m.content : '';
  if (m.role === 'user') {
    if (content.startsWith(SUMMARY_PREFIX)) { return undefined; }
    return typeof m.display === 'string' && m.display ? m.display : content;
  }
  return content;
}

const isSpace = (ch: string): boolean => /\s/.test(ch);

/** Cuts a snippet around the first match on word boundaries and maps the match spans into snippet coordinates. */
function makeSnippet(text: string, spans: Span[]): { snippet: string; ranges: Span[] } {
  const [m, e] = spans[0];
  const room = SNIPPET_MAX - 2; // the two ellipses
  let a = Math.max(0, m - Math.floor(Math.max(0, room - (e - m)) / 2));
  let b = Math.min(text.length, a + room);
  a = Math.max(0, b - room);
  if (a > 0) { for (let i = a; i < m; i++) { if (isSpace(text[i])) { a = i + 1; break; } } }
  if (b < text.length) { for (let i = b; i > Math.min(e, b); i--) { if (isSpace(text[i])) { b = i; break; } } }
  if (a > 0 && /[\uDC00-\uDFFF]/.test(text[a])) { a++; }
  if (b < text.length && /[\uD800-\uDBFF]/.test(text[b - 1])) { b--; }

  const at = new Array<number>(b - a + 1);
  let body = '';
  for (let i = a; i < b; i++) {
    at[i - a] = body.length;
    if (!isSpace(text[i])) { body += text[i]; }
    else if (body && !body.endsWith(' ')) { body += ' '; }
  }
  at[b - a] = body.length;
  body = body.trimEnd();
  const lead = text.slice(0, a).trim() ? '…' : '';
  const tail = text.slice(b).trim() ? '…' : '';

  const ranges: Span[] = [];
  for (const [s, f] of spans) {
    if (f <= a || s >= b) { continue; }
    const from = at[Math.max(s, a) - a] + lead.length, to = Math.min(at[Math.min(f, b) - a], body.length) + lead.length;
    if (to <= from) { continue; }
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1]) { last[1] = Math.max(last[1], to); } else { ranges.push([from, to]); }
  }
  return { snippet: lead + body + tail, ranges };
}

async function readJson(file: string, signal?: AbortSignal): Promise<any> {
  try { return JSON.parse(await fs.readFile(file, { encoding: 'utf8', signal })); } catch { return undefined; }
}

interface Candidate { rank: number; match: SessionMatch }

function turnStartsOf(rec: AgentRecord): number[] {
  if (Array.isArray(rec.turnStarts) && rec.turnStarts.every((n) => Number.isInteger(n))) { return [...rec.turnStarts].sort((a, b) => a - b); }
  const starts: number[] = [];
  rec.history.forEach((m, i) => { if (m?.role === 'user') { starts.push(i); } });
  return starts;
}

/** Scans one agent's messages, recording which terms were found and keeping the best `perSession` matches. */
function scanAgent(rec: AgentRecord, agentId: string, terms: Term[], perSession: number, found: Set<number>, best: Candidate[]): number {
  const starts = turnStartsOf(rec);
  let hits = 0, next = 0;
  rec.history.forEach((msg, index) => {
    while (next < starts.length && starts[next] <= index) { next++; }
    const text = searchableText(msg);
    if (!text) { return; }
    const spans: Span[] = [];
    let distinct = 0;
    terms.forEach((t, ti) => {
      if (!t.one.test(text)) { return; }
      found.add(ti); distinct++;
      let n = 0;
      for (const m of text.matchAll(t.all)) {
        spans.push([m.index, m.index + m[0].length]);
        if (++n >= MAX_SPANS_PER_TERM) { break; }
      }
    });
    if (!spans.length) { return; }
    hits += spans.length;
    const rank = distinct * 1000 + Math.min(spans.length, 999);
    if (perSession <= 0 || (best.length >= perSession && rank <= best[best.length - 1].rank)) { return; }
    spans.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const { snippet, ranges } = makeSnippet(text, spans);
    best.push({ rank, match: { agentId, role: msg.role, turn: Math.max(0, next - 1), snippet, ranges } });
    best.sort((x, y) => y.rank - x.rank);
    best.length = Math.min(best.length, perSession);
  });
  return hits;
}

async function searchOne(dir: string, sessionId: string, terms: Term[], perSession: number, now: number, signal?: AbortSignal): Promise<SessionHit | undefined> {
  const sessionDir = path.join(dir, sessionId);
  const meta = await readJson(path.join(sessionDir, 'session.json'), signal);
  const title = typeof meta?.title === 'string' ? meta.title : '';
  const found = new Set<number>();
  let titleHits = 0, bodyHits = 0;
  let updatedAt = typeof meta?.updatedAt === 'number' ? meta.updatedAt : 0;
  terms.forEach((t, i) => { if (t.one.test(title)) { found.add(i); titleHits++; } });

  const best: Candidate[] = [];
  let names: string[] = [];
  try { names = (await fs.readdir(path.join(sessionDir, 'agents'))).filter((n) => n.endsWith('.json')).sort(); } catch { /* no agents */ }
  for (const name of names) {
    if (signal?.aborted) { return undefined; }
    const file = path.join(sessionDir, 'agents', name);
    let rec: any;
    try {
      if ((await fs.stat(file)).size > MAX_FILE_BYTES) { continue; }
      const raw = await fs.readFile(file, { encoding: 'utf8', signal });
      if (!terms.some((t) => mayContain(raw, t))) { continue; }
      rec = JSON.parse(raw);
    } catch { continue; }
    if (!rec || !Array.isArray(rec.history)) { continue; }
    bodyHits += scanAgent(rec, typeof rec.id === 'string' ? rec.id : name.slice(0, -5), terms, perSession, found, best);
    if (!meta && typeof rec.updatedAt === 'number') { updatedAt = Math.max(updatedAt, rec.updatedAt); }
  }
  if (found.size < terms.length) { return undefined; }
  const ageDays = Math.max(0, now - updatedAt) / DAY_MS;
  const recency = updatedAt ? RECENCY_WEIGHT * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS) : 0;
  const score = Math.round((titleHits * TITLE_WEIGHT + Math.min(bodyHits, BODY_HIT_CAP) * BODY_WEIGHT + recency) * 1000) / 1000;
  return { sessionId, title: title || '(untitled)', updatedAt, score, matches: best.map((c) => c.match) };
}

const byRank = (a: SessionHit, b: SessionHit): number =>
  b.score - a.score || b.updatedAt - a.updatedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);

/**
 * Searches every session under `dir`. All terms must appear somewhere in the session (title or messages).
 * Each worker holds one file in memory at a time. Rejects with `Cancelled` when `signal` aborts.
 */
export async function searchSessions(dir: string, query: string, opts: SearchOptions = {}): Promise<SessionHit[]> {
  const { signal, limit = 50, perSession = 3, concurrency = 4, onResult, include } = opts;
  const cancelled = (): void => { if (signal?.aborted) { throw new Error('Cancelled'); } };
  cancelled();
  const terms = parseQuery(query);
  if (!terms.length || limit <= 0) { return []; }
  let ids: string[];
  try {
    ids = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && ID_RE.test(d.name)).map((d) => d.name);
  } catch { return []; }
  const now = Date.now();
  const hits: SessionHit[] = [];
  let next = 0, emitted = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      cancelled();
      const sid = ids[next++];
      if (include && !(await Promise.resolve().then(() => include(sid)).catch(() => false))) { continue; }
      cancelled();
      const hit = await searchOne(dir, sid, terms, Math.max(0, perSession), now, signal);
      cancelled();
      if (!hit) { continue; }
      hits.push(hit);
      if (emitted < limit) {
        emitted++;
        try { onResult?.(hit); } catch { /* a listener must not break the search */ }
      }
      if (hits.length > limit * 2 + 16) { hits.sort(byRank); hits.length = limit; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, ids.length)) }, worker));
  return hits.sort(byRank).slice(0, limit);
}

/* ------------------------------------------------------------------ export */

type Block =
  | { kind: 'user' | 'assistant' | 'summary'; text: string }
  | { kind: 'call'; name: string; text: string }
  | { kind: 'result'; text: string };

const LABELS = { user: 'User', assistant: 'Assistant', summary: 'Summary of earlier conversation' };

function blocksOf(history: ChatMessage[], includeTools: boolean): Block[] {
  const out: Block[] = [];
  for (const m of history) {
    const content = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'user') {
      if (content.startsWith(SUMMARY_PREFIX)) { out.push({ kind: 'summary', text: content.slice(SUMMARY_PREFIX.length).trim() }); }
      else { out.push({ kind: 'user', text: m.display || content }); }
    } else if (m.role === 'assistant') {
      if (content.trim()) { out.push({ kind: 'assistant', text: content }); }
      if (includeTools) { for (const c of m.tool_calls ?? []) { out.push({ kind: 'call', name: String(c?.function?.name ?? 'tool'), text: String(c?.function?.arguments ?? '') }); } }
    } else if (m.role === 'tool' && includeTools) {
      out.push({ kind: 'result', text: content });
    }
  }
  return out;
}

function dateText(ms: unknown): string {
  const d = new Date(typeof ms === 'number' ? ms : NaN);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString();
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A code fence longer than any backtick run in `text`, so the content cannot close it. */
function fenced(text: string, lang = ''): string {
  const longest = (text.match(/`+/g) ?? []).reduce((n, r) => Math.max(n, r.length), 2);
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

export function exportSessionMarkdown(loaded: LoadedSession, opts: ExportOptions = {}): string {
  const parts = [`# ${oneLine(loaded.meta.title) || 'Chat'}`, `Updated: ${dateText(loaded.meta.updatedAt)}`];
  for (const agent of loaded.agents) {
    if (loaded.agents.length > 1) { parts.push(`## ${oneLine(agent.name)}`); }
    for (const b of blocksOf(agent.history, !!opts.includeTools)) {
      if (b.kind === 'call') { parts.push(`#### Tool call: ${oneLine(b.name)}`, fenced(b.text, 'json')); }
      else if (b.kind === 'result') { parts.push('#### Tool result', fenced(b.text)); }
      else { parts.push(`### ${LABELS[b.kind]}`, b.text); }
    }
  }
  return `${parts.join('\n\n')}\n`;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string): string => String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const EXPORT_CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--user:#f0f4f9;--code:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#16181c;--fg:#e6e8eb;--muted:#9aa3ad;--line:#30363d;--user:#1f252d;--code:#1c2026}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:820px;margin:0 auto;padding:32px 16px 64px}h1{font-size:24px;line-height:1.3;margin:0 0 4px;overflow-wrap:anywhere}
h2{font-size:17px;margin:32px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}.meta{color:var(--muted);font-size:13px;margin:0 0 24px}
.msg{margin:12px 0;padding:10px 14px;border:1px solid var(--line);border-radius:8px}.msg.user{background:var(--user)}
.role{color:var(--muted);font-size:12px;font-weight:600;margin-bottom:4px}.text{white-space:pre-wrap;overflow-wrap:anywhere}
details{margin:8px 0;font-size:13px}summary{cursor:pointer;color:var(--muted)}pre{margin:6px 0 0;padding:10px;background:var(--code);border-radius:6px;overflow-x:auto;font:12.5px/1.5 ui-monospace,Consolas,monospace}`;

/** One self-contained page: every value escaped, no scripts, no remote resources. */
export function exportSessionHtml(loaded: LoadedSession, opts: ExportOptions = {}): string {
  const title = esc(oneLine(loaded.meta.title) || 'Chat');
  const body: string[] = [`<h1>${title}</h1>`, `<p class="meta">Updated ${esc(dateText(loaded.meta.updatedAt))}</p>`];
  for (const agent of loaded.agents) {
    if (loaded.agents.length > 1) { body.push(`<h2>${esc(oneLine(agent.name))}</h2>`); }
    for (const b of blocksOf(agent.history, !!opts.includeTools)) {
      if (b.kind === 'call') { body.push(`<details><summary>Tool call: ${esc(oneLine(b.name))}</summary><pre>${esc(b.text)}</pre></details>`); }
      else if (b.kind === 'result') { body.push(`<details><summary>Tool result</summary><pre>${esc(b.text)}</pre></details>`); }
      else { body.push(`<section class="msg ${b.kind}"><div class="role">${esc(LABELS[b.kind])}</div><div class="text">${esc(b.text)}</div></section>`); }
    }
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${title}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<main>
${body.join('\n')}
</main>
</body>
</html>
`;
}
