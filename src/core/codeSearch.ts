/**
 * Ranked code search for questions phrased in words rather than exact text ("where are expired sessions cleaned up?").
 * grep needs the model to guess the identifier; this finds the code whose words match best, using BM25 over chunks
 * of ~40 lines. Identifiers are split into words (getUserName → get user name, MAX_RETRY_COUNT → max retry count),
 * and words in the file path count extra, so "session cleanup" finds sessionCleaner.ts and cleanupExpiredSessions().
 *
 * BM25 itself is entirely local: no network, nothing written to disk. The index is built in memory on the first query
 * and refreshed incrementally: later queries re-read only files whose size or modification time changed.
 *
 * Optionally a SemanticRanker (hybridSearch.ts, given by the host when an embedding model is configured) re-ranks the
 * results by fusing BM25 with embedding similarity. Without one, or whenever it declines (returns undefined), the
 * ranking is plain BM25 exactly as described above. Hybrid results are marked in the tool output.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { FileIndex, NON_TEXT_EXT } from './search';
import { ChunkRef, SemanticRanker, fileStamp } from './hybridSearch';

const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 10;
const MAX_FILE_BYTES = 300_000;
const MAX_FILES = 25_000;
const READ_CONCURRENCY = 32;
/** Path words are added to every chunk of the file this many times: a match in the file name is a strong signal. */
const PATH_WEIGHT = 3;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const SNIPPET_LINES = 8;

const SKIP_EXT = new Set([...NON_TEXT_EXT, 'min.js', 'min.css', 'snap', 'svg', 'csv', 'tsv']);
const SKIP_NAME = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock)$|\.min\.(js|css)$/i;

/** Words that carry no meaning in code: English function words and the most common language keywords. */
const STOP = new Set([
  'the', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'be', 'it', 'this', 'that', 'with', 'as', 'at', 'by', 'from',
  'var', 'let', 'const', 'new', 'return', 'if', 'else', 'import', 'export', 'public', 'private', 'protected', 'static', 'void', 'int',
  'self', 'def', 'true', 'false', 'null', 'none', 'undefined', 'await', 'async',
]);
/** Words that only frame a question ("where is the code that ..."): dropped from the query, kept in the code. */
const QUERY_STOP = new Set(['where', 'what', 'which', 'how', 'when', 'who', 'does', 'do', 'we', 'our', 'me', 'my', 'you', 'can', 'there',
  'code', 'find', 'show', 'handle', 'handled', 'handling', 'implement', 'implemented', 'logic', 'located', 'happen', 'happens']);

/** Light stemming so "sessions", "session" and "sessioning" meet; deliberately conservative to keep identifiers recognisable. */
function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) { return w.slice(0, -3); }
  if (w.length > 4 && w.endsWith('ies')) { return `${w.slice(0, -3)}y`; }
  if (w.length > 4 && w.endsWith('ed') && !w.endsWith('eed')) { return w.slice(0, -2); }
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) { return w.slice(0, -1); }
  return w;
}

/** Words of a text: identifiers split on case changes, underscores and digits; lower-cased, stemmed, stop words dropped. */
export function codeTokens(text: string, query = false): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) {
    for (const part of raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s0-9]+/)) {
      const w = part.toLowerCase();
      if (w.length < 2 || STOP.has(w) || (query && QUERY_STOP.has(w))) { continue; }
      out.push(stem(w));
    }
  }
  return out;
}

interface Chunk extends ChunkRef { terms: Map<string, number>; length: number }
interface FileEntry { mtimeMs: number; size: number; chunks: Chunk[] }

export interface CodeHit {
  file: string; start: number; end: number; score: number; snippet: string[];
  /** Ranked by BM25 fused with embedding similarity. */
  hybrid?: boolean;
}

export function skipFile(rel: string): boolean {
  if (SKIP_NAME.test(rel)) { return true; }
  const base = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
  const dot = base.indexOf('.');
  if (dot < 0) { return false; }
  return SKIP_EXT.has(base.slice(base.lastIndexOf('.') + 1)) || SKIP_EXT.has(base.slice(dot + 1));
}

function chunkFile(file: string, text: string, stamp: string): Chunk[] {
  if (text.includes('\u0000')) { return []; } // binary
  const lines = text.split(/\r?\n/);
  const pathTerms = codeTokens(file.replace(/[/\\._-]/g, ' '));
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const end = Math.min(lines.length, start + CHUNK_LINES);
    const terms = new Map<string, number>();
    let length = 0;
    for (const t of codeTokens(lines.slice(start, end).join('\n'))) { terms.set(t, (terms.get(t) ?? 0) + 1); length++; }
    for (const t of pathTerms) { terms.set(t, (terms.get(t) ?? 0) + PATH_WEIGHT); length += PATH_WEIGHT; }
    if (length) { chunks.push({ file, start: start + 1, end, stamp, terms, length }); }
    if (end === lines.length) { break; }
  }
  return chunks;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !signal?.aborted) { await fn(items[next++]); }
  }));
}

/** In-memory BM25 index of one workspace folder. */
export class CodeIndex {
  private files = new Map<string, FileEntry>();
  private refreshing?: Promise<void>;
  /** Set when the folder has more indexable files than MAX_FILES; the rest are not searched. */
  truncated = false;

  constructor(readonly root: string, private fileIndex: FileIndex = new FileIndex(root), private ranker?: SemanticRanker) {}

  /** Brings the index up to date with the folder: new and changed files are (re)read, deleted ones dropped. */
  refresh(signal?: AbortSignal): Promise<void> {
    this.refreshing ??= this.doRefresh(signal).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async doRefresh(signal?: AbortSignal): Promise<void> {
    const all = (await this.fileIndex.files()).filter((f) => !skipFile(f));
    this.truncated = all.length > MAX_FILES;
    const wanted = all.slice(0, MAX_FILES);
    const keep = new Set(wanted);
    for (const f of this.files.keys()) { if (!keep.has(f)) { this.files.delete(f); } }
    await mapLimit(wanted, READ_CONCURRENCY, async (rel) => {
      const abs = path.join(this.root, rel);
      try {
        const st = await fs.stat(abs);
        const old = this.files.get(rel);
        if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) { return; }
        const chunks = st.size > MAX_FILE_BYTES ? [] : chunkFile(rel, await fs.readFile(abs, 'utf8'), fileStamp(st));
        this.files.set(rel, { mtimeMs: st.mtimeMs, size: st.size, chunks });
      } catch { this.files.delete(rel); }
    }, signal);
  }

  /** Best-matching chunks, at most one per file region, best first. `under` limits results to a sub-folder. */
  async search(query: string, o: { max?: number; under?: string; signal?: AbortSignal } = {}): Promise<CodeHit[]> {
    const qTerms = [...new Set(codeTokens(query, true))];
    if (!qTerms.length) { return []; }
    await this.refresh(o.signal);
    const prefix = o.under ? `${o.under.replace(/\\/g, '/').replace(/^\.\/?|\/+$/g, '')}/` : '';
    const chunks: Chunk[] = [];
    for (const e of this.files.values()) { for (const c of e.chunks) { if (!prefix || prefix === '/' || c.file.startsWith(prefix)) { chunks.push(c); } } }
    if (!chunks.length) { return []; }
    const avg = chunks.reduce((n, c) => n + c.length, 0) / chunks.length;
    const idf = new Map(qTerms.map((t) => {
      const df = chunks.reduce((n, c) => n + (c.terms.has(t) ? 1 : 0), 0);
      return [t, Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5))];
    }));
    const scored: Array<{ c: Chunk; score: number }> = [];
    for (const c of chunks) {
      let score = 0, matched = 0;
      for (const t of qTerms) {
        const tf = c.terms.get(t);
        if (!tf) { continue; }
        matched++;
        score += idf.get(t)! * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * c.length / avg));
      }
      // Chunks that cover more of the question's words beat chunks that repeat one word many times.
      if (score > 0) { scored.push({ c, score: score * (0.5 + 0.5 * matched / qTerms.length) }); }
    }
    scored.sort((a, b) => b.score - a.score);
    let ranked = scored;
    let hybrid = false;
    if (this.ranker) {
      const all = [...this.files.values()].flatMap((e) => e.chunks);
      const fused = await this.ranker.rank({ query, bm25: scored.map((s) => s.c), scope: chunks, all, signal: o.signal }).catch(() => undefined);
      if (fused) { ranked = fused.map((f) => ({ c: f.item, score: f.score })); hybrid = true; }
    }
    const max = Math.max(1, Math.min(o.max ?? 8, 30));
    const picked: Array<{ c: Chunk; score: number }> = [];
    for (const s of ranked) {
      // Overlapping chunks of the same file are one result.
      if (picked.some((p) => p.c.file === s.c.file && s.c.start <= p.c.end && p.c.start <= s.c.end)) { continue; }
      picked.push(s);
      if (picked.length >= max) { break; }
    }
    return Promise.all(picked.map(async ({ c, score }) => ({ file: c.file, start: c.start, end: c.end, score, snippet: await this.snippet(c, qTerms), ...(hybrid ? { hybrid } : {}) })));
  }

  /** The lines of the chunk that hold the query's words, with line numbers; the chunk's start when none do. */
  private async snippet(c: Chunk, qTerms: string[]): Promise<string[]> {
    let lines: string[];
    try { lines = (await fs.readFile(path.join(this.root, c.file), 'utf8')).split(/\r?\n/).slice(c.start - 1, c.end); } catch { return []; }
    const want = new Set(qTerms);
    const hits = lines.map((l, i) => ({ i, n: codeTokens(l).filter((t) => want.has(t)).length })).filter((x) => x.n > 0);
    const rows = (hits.length ? hits.sort((a, b) => b.n - a.n).slice(0, SNIPPET_LINES).map((x) => x.i).sort((a, b) => a - b) : [0, 1, 2]).filter((i) => i < lines.length);
    return rows.map((i) => `${c.start + i}\t${lines[i].length > 200 ? `${lines[i].slice(0, 200)}…` : lines[i]}`);
  }
}

export function formatCodeHits(hits: CodeHit[], query: string, truncated: boolean, filePrefix = ''): string {
  if (!hits.length) { return `(no code matched "${query}". Try other words for the same idea, or grep for an exact identifier.)`; }
  const body = hits.map((h, n) => `${n + 1}. ${filePrefix}${h.file}:${h.start}-${h.end}\n${h.snippet.join('\n')}`).join('\n\n');
  return `${body}${truncated ? `\n\n[Only the first ${MAX_FILES} files of this folder are indexed; pass path to search a sub-folder.]` : ''}\n\n[Ranked by ${hits.some((h) => h.hybrid) ? 'word relevance and meaning (hybrid)' : 'word relevance'}, not exact text. Read the ranges you need with read_file before relying on them.]`;
}
