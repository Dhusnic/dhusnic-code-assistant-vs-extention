/**
 * Text embeddings from the company gateway, for the semantic half of search_code (see hybridSearch.ts).
 *
 * The request goes to POST {baseUrl}/embeddings (OpenAI-compatible) with the same base URL, API key and TLS settings
 * as chat (it reuses llm.ts's endpoint/requestOptions), so no code ever leaves for any other host. There is no other
 * network path in this module.
 *
 * Inputs are cut to MAX_CHARS characters (embedding models have small input windows and a long chunk adds little),
 * sent in batches of BATCH_SIZE with a little concurrency, and each batch is retried on transient failures (429, 5xx,
 * resets, timeouts) with exponential backoff, like llm.ts's withRetry. Everything else is an EmbeddingError carrying
 * the HTTP status, so callers can tell "this model or endpoint does not exist" (give up for the session) from "the
 * gateway is busy" (try again later). An abort ends every request at once and rejects with an aborted EmbeddingError.
 *
 * The model is explicit configuration (infraonAssistant.embeddingModel). "auto" picks a model whose id says "embed"
 * from the /models listing the host already fetched; nothing here lists models itself.
 */
import * as https from 'https';
import * as http from 'http';
import { LlmConfig, endpoint, requestOptions } from './llm';

export const BATCH_SIZE = 64;
export const MAX_CHARS = 2000;
const CONCURRENCY = 2;
const RETRIES = 2;
const BASE_DELAY_MS = 500;
const TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export class EmbeddingError extends Error {
  /** HTTP status of the failed request, when there was a response. */
  readonly status?: number;
  /** Worth retrying later (busy gateway, network blip), as opposed to a configuration problem. */
  readonly transient: boolean;
  readonly aborted: boolean;
  constructor(message: string, o: { status?: number; transient?: boolean; aborted?: boolean } = {}) {
    super(message);
    this.name = 'EmbeddingError';
    this.status = o.status;
    this.transient = !!o.transient;
    this.aborted = !!o.aborted;
  }
}

/** Embeds texts in order; one vector per input. */
export type EmbedFn = (inputs: string[], signal: AbortSignal) => Promise<number[][]>;
/** An embedding model ready to use. The model id is part of every cache key, so switching models never mixes vectors. */
export interface Embedder { model: string; embed: EmbedFn }

export interface EmbedOptions {
  batchSize?: number; maxChars?: number; concurrency?: number; retries?: number; baseDelayMs?: number; timeoutMs?: number;
  /** Replaces the HTTP call (tests). Receives one batch. */
  post?: (batch: string[], signal: AbortSignal) => Promise<number[][]>;
}

/** The configured embedding model: the setting itself, or for "auto" the first listed model whose id mentions embeddings. */
export function resolveEmbeddingModel(setting: string | undefined, listed: string[] = []): string | undefined {
  const s = (setting ?? '').trim();
  if (!s) { return undefined; }
  if (s.toLowerCase() !== 'auto') { return s; }
  return listed.find((m) => /embed/i.test(m));
}

const aborted = () => new EmbeddingError('Cancelled', { aborted: true });
const transientStatus = (s: number) => s === 408 || s === 429 || s >= 500;

/** Pure: the vectors of an OpenAI-style /embeddings response, in input order. Throws when the shape is wrong. */
export function parseEmbeddings(body: unknown, count: number): number[][] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length !== count) { throw new EmbeddingError(`Embeddings response has ${Array.isArray(data) ? data.length : 'no'} vectors for ${count} inputs.`); }
  const out: number[][] = new Array(count);
  data.forEach((d: { index?: unknown; embedding?: unknown }, n) => {
    const i = typeof d?.index === 'number' ? d.index : n;
    const v = d?.embedding;
    if (!Array.isArray(v) || !v.length || i < 0 || i >= count || typeof v[0] !== 'number') { throw new EmbeddingError('Embeddings response holds a malformed vector.'); }
    out[i] = v as number[];
  });
  const dim = out[0]?.length;
  if (out.some((v) => !v || v.length !== dim)) { throw new EmbeddingError('Embeddings response vectors differ in size.'); }
  return out;
}

function postBatch(cfg: LlmConfig, model: string, input: string[], signal: AbortSignal, timeoutMs: number): Promise<number[][]> {
  const url = endpoint(cfg, '/embeddings');
  const body = JSON.stringify({ model, input });
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted()); return; }
    let settled = false;
    const finish = (err?: Error, v?: number[][]) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (err) { req.destroy(); reject(err); } else { resolve(v!); }
    };
    const onAbort = () => finish(aborted());
    const timer = setTimeout(() => finish(new EmbeddingError(`Embeddings request timed out after ${Math.round(timeoutMs / 1000)} s (ETIMEDOUT).`, { transient: true })), timeoutMs);
    const req = lib.request(requestOptions(cfg, url, 'POST', Buffer.byteLength(body)), (res) => {
      const status = res.statusCode ?? 500;
      const parts: Buffer[] = [];
      let size = 0;
      res.on('data', (d: Buffer) => {
        size += d.length;
        if (size > MAX_RESPONSE_BYTES) { finish(new EmbeddingError('Embeddings response is too large.')); return; }
        parts.push(d);
      });
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        if (status >= 400) { finish(new EmbeddingError(`Embeddings HTTP ${status}: ${text.slice(0, 300)}`, { status, transient: transientStatus(status) })); return; }
        try { finish(undefined, parseEmbeddings(JSON.parse(text), input.length)); } catch (e) {
          finish(e instanceof EmbeddingError ? e : new EmbeddingError(`Embeddings response is not JSON: ${text.slice(0, 120)}`));
        }
      });
      res.on('error', (e) => finish(new EmbeddingError(`Embeddings request failed: ${e.message}`, { transient: true })));
      res.on('aborted', () => finish(new EmbeddingError('Embeddings response ended early (ECONNRESET).', { transient: true })));
    });
    req.on('error', (e) => finish(new EmbeddingError(`Embeddings request failed: ${e.message}`, { transient: true })));
    signal.addEventListener('abort', onAbort, { once: true });
    req.write(body);
    req.end();
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted()); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(aborted()); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Embeds `inputs` with `model` at the gateway in cfg. Returns one vector per input, in order.
 * Rejects with EmbeddingError (aborted, transient after retries, or permanent).
 */
export async function embed(cfg: LlmConfig, model: string, inputs: string[], signal: AbortSignal, o: EmbedOptions = {}): Promise<number[][]> {
  const size = Math.max(1, o.batchSize ?? BATCH_SIZE);
  const maxChars = o.maxChars ?? MAX_CHARS;
  const retries = o.retries ?? RETRIES;
  const base = o.baseDelayMs ?? BASE_DELAY_MS;
  const post = o.post ?? ((b, s) => postBatch(cfg, model, b, s, o.timeoutMs ?? TIMEOUT_MS));
  const batches: Array<{ at: number; input: string[] }> = [];
  for (let at = 0; at < inputs.length; at += size) {
    // An empty string is rejected by some servers; a single space embeds as "nothing".
    batches.push({ at, input: inputs.slice(at, at + size).map((t) => (t.length > maxChars ? t.slice(0, maxChars) : t) || ' ') });
  }
  const out: number[][] = new Array(inputs.length);
  // One failed batch stops the rest: the caller falls back as a whole anyway.
  const inner = new AbortController();
  const onAbort = () => inner.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const b = batches[next++];
      for (let attempt = 0; ; attempt++) {
        if (inner.signal.aborted) { throw aborted(); }
        try {
          const vecs = await post(b.input, inner.signal);
          if (vecs.length !== b.input.length) { throw new EmbeddingError(`Embeddings response has ${vecs.length} vectors for ${b.input.length} inputs.`); }
          vecs.forEach((v, i) => { out[b.at + i] = v; });
          break;
        } catch (e) {
          const err = e instanceof EmbeddingError ? e : new EmbeddingError(e instanceof Error ? e.message : String(e), { transient: true });
          if (err.aborted || signal.aborted || !err.transient || attempt >= retries) { throw signal.aborted ? aborted() : err; }
          await sleep(base * 2 ** attempt, inner.signal);
        }
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(Math.max(1, o.concurrency ?? CONCURRENCY), batches.length) }, () => worker().catch((e) => { inner.abort(); throw e; })));
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  return out;
}
