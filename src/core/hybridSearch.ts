/**
 * The semantic half of search_code: ranks code chunks by embedding similarity and fuses that with the BM25 ranking
 * of codeSearch.ts, so "login handler" also finds authenticateUser() even though no word matches.
 *
 * Optional: it runs only when the host's embedder() returns a model (the infraonAssistant.embeddingModel setting;
 * its default "auto" resolves to a model only when the gateway's /models list has an embedding model, otherwise
 * embedder() returns undefined without any request and search_code stays BM25-only). Embeddings come from the same
 * company gateway as chat (embeddings.ts); chunk text is passed through the host's redact() (secret masking when
 * redactSecrets is on) before it is sent.
 *
 * Index lifecycle. Vectors are built lazily from the chunks CodeIndex already has; nothing happens until the first
 * search_code call. On a query, the query is embedded together with the top BM25 candidates that have no vector yet
 * (or every chunk, when few are missing), so the first answer is already hybrid. Then a background run embeds the
 * remaining chunks in groups, capped at MAX_CHUNKS chunks, a per-run time limit and a per-session input budget, with a
 * short pause between groups so one window never keeps the shared gateway busy back to back; later queries use
 * whatever vectors exist by then. A chunk's vector is found through its link (path + start line → file
 * stamp (mtime:size) + content hash). When a file changes its stamp no longer matches, so its chunks are re-read and
 * re-hashed; unchanged chunk text maps to the same hash and reuses its vector without a request. The content hash
 * includes the model id, so switching models never mixes vector spaces.
 *
 * Persistence. When the host passes storeDir (VS Code's per-workspace storage, never the workspace itself) vectors
 * are saved there keyed by content hash only, one file per workspace folder: a length-prefixed JSON header (hashes,
 * dimension) followed by raw float32 data in the machine's byte order. After a restart the chunks are re-hashed locally
 * and matched against it, so an unchanged repository is not embedded again. Without storeDir everything stays in memory.
 *
 * Ranking. Cosine similarity of the (normalised) query vector against every in-scope chunk with a vector gives the
 * semantic list; it and the BM25 list (top CANDIDATES each) are combined with Reciprocal Rank Fusion, k = 60. RRF only
 * uses ranks, so BM25 scores and cosine values never need to be calibrated against each other.
 *
 * Fallback. rank() returns undefined whenever embeddings are disabled, unavailable or failing, and the caller then
 * uses plain BM25, exactly as before. The first failure is logged once; a transient failure pauses semantic ranking
 * for a while, and after MAX_FAILURES in a row (or at once for a permanent error such as an unknown model) it is off
 * for the rest of the session, until the configured model changes.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { Embedder, EmbeddingError, MAX_CHARS } from './embeddings';

/** A code chunk as CodeIndex knows it. stamp identifies the file version it was cut from. */
export interface ChunkRef { file: string; start: number; end: number; stamp: string }

export interface RankRequest<T extends ChunkRef> {
  query: string;
  /** Chunks with a BM25 score, best first. */
  bm25: T[];
  /** Every chunk the query may return (the searched folder). */
  scope: T[];
  /** Every chunk of the index: what the background run embeds. */
  all: T[];
  signal?: AbortSignal;
}

export interface SemanticRanker {
  /** Fused ranking, best first; undefined means "use BM25 alone". Never throws. */
  rank<T extends ChunkRef>(req: RankRequest<T>): Promise<Array<{ item: T; score: number }> | undefined>;
}

export interface HybridOptions {
  /** The embedding model to use now, or undefined when semantic search is off. Called on every query. */
  embedder: () => Promise<Embedder | undefined>;
  /** Applied to chunk text before it is embedded (secret masking). */
  redact?: (text: string) => string;
  /** Folder for the persisted vectors (outside the workspace). In memory only when absent. */
  storeDir?: string;
  log?: (message: string) => void;
  /** Chunks embedded with the query: the top BM25 candidates without a vector. */
  immediate?: number;
  /** When at most this many in-scope chunks lack a vector, all of them are embedded with the query. */
  smallIndex?: number;
  maxChunks?: number;
  /** Inputs sent per session, at most. */
  budget?: number;
  /** Duration of one background run, at most. */
  backgroundMs?: number;
  /** Chunks embedded per background step. */
  groupSize?: number;
  /** Pause between background steps, so the shared gateway is not kept busy back to back. */
  groupPauseMs?: number;
  maxFailures?: number;
  /** Pause after a transient failure, multiplied by the number of failures in a row. */
  pauseMs?: number;
}

export const RRF_K = 60;
const CANDIDATES = 100;
const MAX_CHUNKS = 20_000;
const SAVE_EVERY = 2048;

export const fileStamp = (st: { mtimeMs: number; size: number }): string => `${st.mtimeMs}:${st.size}`;
const chunkKey = (c: ChunkRef): string => `${c.file}#${c.start}`;

/** Cosine similarity of two vectors; 0 when either is empty, zero or they differ in length. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a.length || a.length !== b.length) { return 0; }
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function normalize(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  let n = 0;
  for (let i = 0; i < out.length; i++) { n += out[i] * out[i]; }
  n = Math.sqrt(n);
  if (n) { for (let i = 0; i < out.length; i++) { out[i] /= n; } }
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; }
  return s;
}

/** Reciprocal Rank Fusion: each item scores Σ 1 / (k + rank) over the lists it is in (rank from 1). Best first. */
export function rrfFuse<T>(lists: T[][], key: (t: T) => string, k = RRF_K): Array<{ item: T; score: number }> {
  const by = new Map<string, { item: T; score: number; first: number }>();
  let order = 0;
  for (const list of lists) {
    list.forEach((item, i) => {
      const id = key(item);
      const cur = by.get(id) ?? { item, score: 0, first: order++ };
      cur.score += 1 / (k + i + 1);
      by.set(id, cur);
    });
  }
  return [...by.values()].sort((a, b) => b.score - a.score || a.first - b.first).map(({ item, score }) => ({ item, score }));
}

const NEVER = new AbortController().signal;

/** Waits ms, or rejects at once when signal aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Cancelled')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new Error('Cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Embedding vectors of one workspace folder's chunks, built lazily and fused with BM25 at query time. */
export class HybridRanker implements SemanticRanker {
  private links = new Map<string, { stamp: string; hash: string }>();
  private vectors = new Map<string, Float32Array>();
  /** Chunks that could not be read at their stamp (file changed meanwhile, or gone): not retried until it changes. */
  private skip = new Set<string>();
  private model?: string;
  private failures = 0;
  private pausedUntil = 0;
  private off = false;
  private warned = false;
  private sent = 0;
  private dirty = 0;
  private pool: ChunkRef[] = [];
  private emb?: Embedder;
  private bg?: Promise<void>;
  private loaded?: Promise<void>;
  private stop = new AbortController();
  private readonly o: Required<Omit<HybridOptions, 'redact' | 'storeDir' | 'log'>> & HybridOptions;

  constructor(readonly root: string, opts: HybridOptions) {
    this.o = {
      immediate: 48, smallIndex: 256, maxChunks: MAX_CHUNKS, budget: 60_000, backgroundMs: 10 * 60_000, groupSize: 256,
      groupPauseMs: 1000, maxFailures: 3, pauseMs: 60_000, ...opts,
    };
  }

  /** Number of chunks with a usable vector link (tests, diagnostics). */
  get size(): number { return this.links.size; }
  /** Finished when the current background run is (tests). */
  idle(): Promise<void> { return this.bg ?? Promise.resolve(); }
  /** Stops background work. Vectors already saved stay on disk. */
  dispose(): void { this.stop.abort(); }

  async rank<T extends ChunkRef>(req: RankRequest<T>): Promise<Array<{ item: T; score: number }> | undefined> {
    if (this.stop.signal.aborted) { return undefined; }
    let emb: Embedder | undefined;
    try { emb = await this.o.embedder(); } catch { emb = undefined; }
    if (!emb?.model) { return undefined; }
    if (emb.model !== this.model) {
      this.model = emb.model;
      this.links.clear(); this.skip.clear();
      this.off = false; this.failures = 0; this.pausedUntil = 0;
    }
    if (this.off || Date.now() < this.pausedUntil) { return undefined; }
    await this.load();
    const missing = req.scope.filter((c) => !this.vecOf(c) && !this.skip.has(`${chunkKey(c)}@${c.stamp}`));
    const now = missing.length <= this.o.smallIndex ? missing : req.bm25.slice(0, this.o.immediate).filter((c) => !this.vecOf(c));
    let q: Float32Array | undefined;
    try { q = await this.ensure(now, emb, req.signal ?? NEVER, req.query); } catch (e) { this.fail(e); return undefined; }
    if (!q) { return undefined; }
    this.failures = 0;
    this.warm(req.all, emb);

    const semantic: Array<{ c: T; s: number }> = [];
    for (const c of req.scope) {
      const v = this.vecOf(c);
      if (v && v.length === q.length) { semantic.push({ c, s: dot(q, v) }); }
    }
    semantic.sort((a, b) => b.s - a.s);
    return rrfFuse([req.bm25.slice(0, CANDIDATES), semantic.slice(0, CANDIDATES).map((x) => x.c)], chunkKey);
  }

  private vecOf(c: ChunkRef): Float32Array | undefined {
    const link = this.links.get(chunkKey(c));
    return link && link.stamp === c.stamp ? this.vectors.get(link.hash) : undefined;
  }

  /** The text embedded for a chunk (path + lines, masked, cut to MAX_CHARS), or undefined when the file moved on. */
  private async textOf(c: ChunkRef, files: Map<string, Promise<string[] | undefined>>): Promise<string | undefined> {
    let lines = files.get(c.file);
    if (!lines) {
      lines = (async () => {
        const abs = path.join(this.root, c.file);
        try {
          const st = await fs.stat(abs);
          if (fileStamp(st) !== c.stamp) { return undefined; }
          return (await fs.readFile(abs, 'utf8')).split(/\r?\n/);
        } catch { return undefined; }
      })();
      files.set(c.file, lines);
    }
    const all = await lines;
    if (!all) { return undefined; }
    const raw = `${c.file}\n${all.slice(c.start - 1, c.end).join('\n')}`;
    const text = this.o.redact ? this.o.redact(raw) : raw;
    return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  }

  /**
   * Gives every chunk in `chunks` a vector (reusing vectors of identical text) and embeds `query` in the same request.
   * Returns the normalised query vector when a query was given.
   */
  private async ensure(chunks: ChunkRef[], emb: Embedder, signal: AbortSignal, query?: string): Promise<Float32Array | undefined> {
    const files = new Map<string, Promise<string[] | undefined>>();
    const texts = await Promise.all(chunks.map((c) => this.textOf(c, files)));
    const todo = new Map<string, { text: string; chunks: ChunkRef[] }>();
    chunks.forEach((c, i) => {
      const text = texts[i];
      if (text === undefined) { this.skip.add(`${chunkKey(c)}@${c.stamp}`); return; }
      const hash = createHash('sha1').update(`${emb.model}\u0000${text}`).digest('hex');
      if (this.vectors.has(hash)) { this.links.set(chunkKey(c), { stamp: c.stamp, hash }); return; }
      const t = todo.get(hash) ?? { text, chunks: [] };
      t.chunks.push(c);
      todo.set(hash, t);
    });
    const entries = [...todo.entries()];
    const inputs = [...(query !== undefined ? [query] : []), ...entries.map(([, t]) => t.text)];
    if (!inputs.length) { return undefined; }
    const vecs = await emb.embed(inputs, signal);
    if (vecs.length !== inputs.length) { throw new EmbeddingError(`Embeddings returned ${vecs.length} vectors for ${inputs.length} inputs.`); }
    this.sent += inputs.length;
    const offset = query !== undefined ? 1 : 0;
    entries.forEach(([hash, t], i) => {
      this.vectors.set(hash, normalize(vecs[i + offset]));
      for (const c of t.chunks) { this.links.set(chunkKey(c), { stamp: c.stamp, hash }); }
      this.dirty++;
    });
    this.prune();
    return query !== undefined ? normalize(vecs[0]) : undefined;
  }

  /** Drops vectors no chunk links to any more, once there are clearly more than the cap. */
  private prune(): void {
    if (this.vectors.size <= this.o.maxChunks * 1.25) { return; }
    const used = new Set([...this.links.values()].map((l) => l.hash));
    for (const h of this.vectors.keys()) { if (!used.has(h)) { this.vectors.delete(h); } }
  }

  private fail(e: unknown): void {
    const err = e instanceof EmbeddingError ? e : undefined;
    if (err?.aborted || this.stop.signal.aborted) { return; }
    this.failures++;
    const msg = e instanceof Error ? e.message : String(e);
    if (!this.warned) { this.warned = true; this.o.log?.(`Embeddings failed (${msg.slice(0, 200)}); search_code uses word ranking until they work.`); }
    if ((err && !err.transient) || this.failures >= this.o.maxFailures) {
      this.off = true;
      this.o.log?.(`Semantic search is off for this session after ${this.failures} failure${this.failures === 1 ? '' : 's'}: ${msg.slice(0, 200)}`);
    } else {
      this.pausedUntil = Date.now() + this.o.pauseMs * this.failures;
    }
  }

  /** Starts (or feeds) the background run that embeds the rest of the index. */
  private warm(all: ChunkRef[], emb: Embedder): void {
    this.pool = all;
    this.emb = emb;
    this.bg ??= this.background().catch(() => undefined).finally(() => { this.bg = undefined; });
  }

  private async background(): Promise<void> {
    const deadline = Date.now() + this.o.backgroundMs;
    const signal = this.stop.signal;
    let first = true;
    while (!signal.aborted && !this.off && Date.now() < deadline && this.sent < this.o.budget && this.links.size < this.o.maxChunks) {
      const emb = this.emb!;
      if (emb.model !== this.model) { break; }
      const room = Math.min(this.o.groupSize, this.o.maxChunks - this.links.size);
      const pending: ChunkRef[] = [];
      for (const c of this.pool) {
        if (pending.length >= room) { break; }
        if (!this.vecOf(c) && !this.skip.has(`${chunkKey(c)}@${c.stamp}`)) { pending.push(c); }
      }
      if (!pending.length) { break; }
      if (!first && this.o.groupPauseMs > 0) {
        try { await pause(this.o.groupPauseMs, signal); } catch { break; }
      }
      first = false;
      try { await this.ensure(pending, emb, signal); } catch (e) { this.fail(e); break; }
      if (this.dirty >= SAVE_EVERY) { await this.save(); }
    }
    await this.save();
  }

  private get storeFile(): string | undefined {
    return this.o.storeDir ? path.join(this.o.storeDir, `${createHash('sha1').update(path.resolve(this.root)).digest('hex').slice(0, 16)}.vec`) : undefined;
  }

  /** Reads persisted vectors once. A missing or damaged file just means starting empty. */
  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const file = this.storeFile;
      if (!file) { return; }
      try {
        const buf = await fs.readFile(file);
        const len = buf.readUInt32LE(0);
        const head = JSON.parse(buf.subarray(4, 4 + len).toString('utf8')) as { v: number; dim: number; hashes: string[] };
        if (head.v !== 1 || !(head.dim > 0) || !Array.isArray(head.hashes)) { return; }
        const body = buf.subarray(4 + len);
        if (body.length !== head.hashes.length * head.dim * 4) { return; }
        head.hashes.forEach((h, i) => {
          if (!this.vectors.has(h)) {
            const bytes = body.subarray(i * head.dim * 4, (i + 1) * head.dim * 4);
            this.vectors.set(h, new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)));
          }
        });
      } catch { /* nothing saved yet */ }
    })();
    return this.loaded;
  }

  /** Writes the vectors the current chunks link to (one dimension, the most recent model's). Best effort. */
  private async save(): Promise<void> {
    const file = this.storeFile;
    if (!file || !this.dirty) { return; }
    this.dirty = 0;
    const hashes = [...new Set([...this.links.values()].map((l) => l.hash))].filter((h) => this.vectors.has(h)).slice(0, this.o.maxChunks);
    if (!hashes.length) { return; }
    const dim = this.vectors.get(hashes[0])!.length;
    const keep = hashes.filter((h) => this.vectors.get(h)!.length === dim);
    const head = Buffer.from(JSON.stringify({ v: 1, dim, hashes: keep }), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(head.length, 0);
    const body = Buffer.alloc(keep.length * dim * 4);
    keep.forEach((h, i) => { const v = this.vectors.get(h)!; Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(body, i * dim * 4); });
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, Buffer.concat([len, head, body]));
      await fs.rename(tmp, file);
    } catch (e) { this.o.log?.(`Could not save search vectors: ${e instanceof Error ? e.message : String(e)}`); }
  }
}
