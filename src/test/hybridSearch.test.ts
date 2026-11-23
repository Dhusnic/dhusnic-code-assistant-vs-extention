import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';
import { CodeIndex, formatCodeHits } from '../core/codeSearch';
import { Embedder, EmbeddingError, embed, parseEmbeddings, resolveEmbeddingModel } from '../core/embeddings';
import { HybridRanker, HybridOptions, cosine, rrfFuse } from '../core/hybridSearch';
import { SecretVault } from '../core/redact';
import { tmpDir } from './helpers';

async function repo(files: Record<string, string>): Promise<string> {
  const root = await tmpDir('hybrid-');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}

const AUTH = `export async function authenticateUser(name: string, credentials: string): Promise<boolean> {
  const user = await users.byName(name);
  return !!user && verifyPassword(user, credentials);
}
`;
const HTTP = `export async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  for (let i = 0; i < attempts; i++) { try { return await fetch(url); } catch { /* retry */ } }
  throw new Error('request failed');
}
`;
const MATH = 'export function add(a: number, b: number) { return a + b; }\nexport const VERSION = "1.0";\n';

/** A toy embedding space where synonyms share a dimension, so "login" lands near "authenticate". */
const CONCEPTS = [['login', 'sign in', 'authenticat', 'credential', 'password'], ['http', 'fetch', 'request', 'retry', 'network'], ['add', 'sum', 'math', 'number']];
const toyVector = (text: string): number[] => {
  const t = text.toLowerCase();
  return [...CONCEPTS.map((words) => words.reduce((n, w) => n + t.split(w).length - 1, 0)), 0.01];
};

function fakeEmbedder(model = 'toy-embed'): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return { model, calls, embed: async (inputs) => { calls.push(inputs); return inputs.map(toyVector); } };
}

const ranker = (root: string, emb: Embedder | (() => Promise<Embedder | undefined>), o: Partial<HybridOptions> = {}) =>
  new HybridRanker(root, { embedder: typeof emb === 'function' ? emb : async () => emb, ...o });

/* ------------------------------------------------------------------ pure helpers */

test('rrfFuse: Reciprocal Rank Fusion with k = 60, items in both lists win, ties keep first appearance', () => {
  const fused = rrfFuse([['a', 'b', 'c'], ['c', 'a', 'd']], (x) => x);
  assert.deepEqual(fused.map((f) => f.item), ['a', 'c', 'b', 'd']);
  assert.ok(Math.abs(fused[0].score - (1 / 61 + 1 / 62)) < 1e-12);
  assert.ok(Math.abs(fused[3].score - 1 / 63) < 1e-12);
  assert.deepEqual(rrfFuse([['x'], []], (x) => x).map((f) => f.item), ['x']);
  assert.deepEqual(rrfFuse([['p', 'q'], ['q', 'p']], (x) => x).map((f) => f.item), ['p', 'q'], 'an exact tie keeps the first seen');
});

test('cosine: similarity of direction, 0 for empty, zero or mismatched vectors', () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [2, 4, 6]) - 1) < 1e-12);
  assert.equal(cosine([1, 0], [0, 5]), 0);
  assert.ok(Math.abs(cosine([1, 1], [-1, -1]) + 1) < 1e-12);
  assert.equal(cosine([1, 2], [1, 2, 3]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
  assert.equal(cosine([], []), 0);
});

test('resolveEmbeddingModel: empty is off, a name is used as is, "auto" picks a listed embedding model', () => {
  assert.equal(resolveEmbeddingModel(''), undefined);
  assert.equal(resolveEmbeddingModel('  '), undefined);
  assert.equal(resolveEmbeddingModel('bge-m3'), 'bge-m3');
  assert.equal(resolveEmbeddingModel('auto', ['qwen', 'nomic-embed-text']), 'nomic-embed-text');
  assert.equal(resolveEmbeddingModel('auto', ['qwen']), undefined);
});

test('parseEmbeddings: orders by index and rejects malformed bodies', () => {
  assert.deepEqual(parseEmbeddings({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }, 2), [[1], [2]]);
  assert.throws(() => parseEmbeddings({ data: [{ embedding: [1] }] }, 2), EmbeddingError);
  assert.throws(() => parseEmbeddings({ data: [{ embedding: [1] }, { embedding: [1, 2] }] }, 2), /differ/);
  assert.throws(() => parseEmbeddings({ data: [{ embedding: 'x' }] }, 1), /malformed/);
});

/* ------------------------------------------------------------------ embed(): batching, retries, abort */

const CFG = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'chat', temperature: 0, allowSelfSigned: false };

test('embed: batches of 64, inputs cut to 2000 chars, results in input order', async () => {
  const batches: string[][] = [];
  const inputs = Array.from({ length: 150 }, (_, i) => (i === 3 ? 'x'.repeat(5000) : `text ${i}`));
  const out = await embed(CFG, 'm', inputs, new AbortController().signal, {
    post: async (b) => { batches.push(b); await new Promise((r) => setTimeout(r, b.length === 64 ? 5 : 0)); return b.map((t) => [Number(t.split(' ')[1] ?? -1)]); },
  });
  assert.deepEqual(batches.map((b) => b.length).sort((a, b) => a - b), [22, 64, 64]);
  assert.equal(batches.flat().find((t) => t.startsWith('xxx'))!.length, 2000);
  assert.equal(out.length, 150);
  assert.deepEqual(out[149], [149]);
  assert.deepEqual(out[64], [64]);
});

test('embed: retries transient failures, not permanent ones; an abort rejects at once', async () => {
  let n = 0;
  const flaky = async (b: string[]) => { if (n++ === 0) { throw new EmbeddingError('busy', { status: 503, transient: true }); } return b.map(() => [1]); };
  assert.deepEqual(await embed(CFG, 'm', ['a'], new AbortController().signal, { post: flaky, baseDelayMs: 1 }), [[1]]);
  assert.equal(n, 2);

  let m = 0;
  const missing = async () => { m++; throw new EmbeddingError('no such model', { status: 404 }); };
  await assert.rejects(embed(CFG, 'm', ['a'], new AbortController().signal, { post: missing, baseDelayMs: 1 }), (e: EmbeddingError) => e.status === 404 && !e.transient);
  assert.equal(m, 1);

  const ac = new AbortController();
  const slow = (_b: string[], s: AbortSignal) => new Promise<number[][]>((_r, reject) => s.addEventListener('abort', () => reject(new EmbeddingError('Cancelled', { aborted: true }))));
  const p = embed(CFG, 'm', ['a', 'b'], ac.signal, { post: slow, batchSize: 1 });
  ac.abort();
  await assert.rejects(p, (e: EmbeddingError) => e.aborted);
});

test('embed: talks OpenAI /embeddings to the configured gateway with the API key (local fake server)', async () => {
  const seen: Array<{ url?: string; auth?: string; body: any }> = [];
  let status = 200;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      seen.push({ url: req.url, auth: req.headers.authorization, body: parsed });
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      // Reversed order on purpose: the client must sort by index.
      res.end(status === 200 ? JSON.stringify({ data: parsed.input.map((t: string, index: number) => ({ index, embedding: [t.length, 1] })).reverse() }) : '{"error":"model not found"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  try {
    const out = await embed({ ...CFG, baseUrl }, 'bge-m3', ['a', 'bbb'], new AbortController().signal);
    assert.deepEqual(out, [[1, 1], [3, 1]]);
    assert.deepEqual(seen[0], { url: '/v1/embeddings', auth: 'Bearer k', body: { model: 'bge-m3', input: ['a', 'bbb'] } });
    status = 404;
    await assert.rejects(embed({ ...CFG, baseUrl }, 'nope', ['a'], new AbortController().signal), (e: EmbeddingError) => e.status === 404 && /HTTP 404/.test(e.message));
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

/* ------------------------------------------------------------------ hybrid search_code */

test('hybrid: finds code by meaning when no word matches, and marks the output', async () => {
  const root = await repo({ 'src/auth/users.ts': AUTH, 'src/net/http.ts': HTTP, 'src/util/math.ts': MATH });
  assert.deepEqual(await new CodeIndex(root).search('login'), [], 'BM25 alone has no word to match');
  const emb = fakeEmbedder();
  const idx = new CodeIndex(root, undefined, ranker(root, emb));
  const hits = await idx.search('login');
  assert.equal(hits[0].file, 'src/auth/users.ts');
  assert.ok(hits[0].hybrid);
  assert.match(formatCodeHits(hits, 'login', false), /\(hybrid\)/);
  assert.equal(emb.calls[0][0], 'login', 'the query is embedded with the chunks');
  assert.ok(emb.calls[0].some((t) => t.startsWith('src/auth/users.ts\n')), 'chunk text carries its path');
  // A word match still counts: both lists agree on the http file.
  const [first] = await idx.search('retry request');
  assert.equal(first.file, 'src/net/http.ts');
});

test('hybrid: vectors are reused until a file changes; identical text after a touch is not re-embedded', async () => {
  const root = await repo({ 'src/auth/users.ts': AUTH, 'src/net/http.ts': HTTP, 'src/util/math.ts': MATH });
  const emb = fakeEmbedder();
  const r = ranker(root, emb);
  const idx = new CodeIndex(root, undefined, r);
  await idx.search('login');
  await r.idle();
  let before = emb.calls.length;
  const chunkInputs = () => emb.calls.slice(before).flat().filter((t) => t.includes('\n'));
  await idx.search('sum of numbers');
  assert.deepEqual(emb.calls.slice(before), [['sum of numbers']], 'only the query is embedded');

  before = emb.calls.length;
  await fs.writeFile(path.join(root, 'src/util/math.ts'), `${MATH}export function sum(xs: number[]) { return xs.reduce(add, 0); }\n`);
  await idx.search('sum of numbers');
  assert.deepEqual(chunkInputs().map((t) => t.split('\n')[0]), ['src/util/math.ts'], 'only the changed file is embedded again');

  before = emb.calls.length;
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(path.join(root, 'src/net/http.ts'), future, future);
  await idx.search('sum of numbers');
  assert.deepEqual(chunkInputs(), [], 'same text under a new mtime reuses its vector');
});

test('hybrid: falls back to exact BM25 results when embeddings fail, logs once, and gives up after repeated failures', async () => {
  const root = await repo({ 'src/auth/users.ts': AUTH, 'src/net/http.ts': HTTP, 'src/util/math.ts': MATH });
  const plain = await new CodeIndex(root).search('retry request');
  let calls = 0;
  const logs: string[] = [];
  const failing: Embedder = { model: 'm', embed: async () => { calls++; throw new EmbeddingError('Embeddings HTTP 503', { status: 503, transient: true }); } };
  const idx = new CodeIndex(root, undefined, ranker(root, failing, { pauseMs: 0, maxFailures: 3, log: (m) => logs.push(m) }));
  for (let i = 0; i < 5; i++) { assert.deepEqual(await idx.search('retry request'), plain); }
  assert.equal(calls, 3, 'stops calling the gateway after 3 failures in a row');
  assert.equal(logs.filter((l) => /Embeddings failed/.test(l)).length, 1);
  assert.equal(logs.filter((l) => /off for this session/.test(l)).length, 1);
  assert.doesNotMatch(formatCodeHits(plain, 'q', false), /hybrid/);

  // A permanent error (unknown model) turns it off at once.
  let permanent = 0;
  const missing: Embedder = { model: 'm', embed: async () => { permanent++; throw new EmbeddingError('Embeddings HTTP 404', { status: 404 }); } };
  const idx2 = new CodeIndex(root, undefined, ranker(root, missing));
  assert.deepEqual(await idx2.search('retry request'), plain);
  assert.deepEqual(await idx2.search('retry request'), plain);
  assert.equal(permanent, 1);
});

test('hybrid: disabled (no model) is plain BM25 and sends nothing', async () => {
  const root = await repo({ 'src/net/http.ts': HTTP, 'src/util/math.ts': MATH });
  const plain = await new CodeIndex(root).search('retry request');
  const idx = new CodeIndex(root, undefined, ranker(root, async () => undefined));
  assert.deepEqual(await idx.search('retry request'), plain);
});

test('hybrid: chunk text is masked before it is embedded', async () => {
  const root = await repo({ 'src/db.ts': 'export const password = "hunter2hunter2-Q7";\nexport function connect() { return login(password); }\n' });
  const emb = fakeEmbedder();
  const vault = new SecretVault();
  vault.addKnown('hunter2hunter2-Q7', 'password');
  await new CodeIndex(root, undefined, ranker(root, emb, { redact: (t) => vault.redact(t).text })).search('login');
  const sent = emb.calls.flat().join('\n');
  assert.ok(sent.includes('src/db.ts'));
  assert.ok(!sent.includes('hunter2hunter2-Q7'), 'the secret never reaches the embeddings request');
  assert.match(sent, /‹secret:password:\d+›/);
});

test('hybrid: large index embeds the top BM25 candidates first, the rest in the background up to the cap', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 12; i++) { files[`src/m${i}.ts`] = `export function helper${i}(x: number) { return x * ${i}; }\n`; }
  files['src/net/http.ts'] = HTTP;
  const root = await repo(files);
  const emb = fakeEmbedder();
  const r = ranker(root, emb, { smallIndex: 0, immediate: 1, groupSize: 3, maxChunks: 8 });
  const idx = new CodeIndex(root, undefined, r);
  await idx.search('retry request');
  assert.deepEqual(emb.calls[0].map((t) => t.split('\n')[0]), ['retry request', 'src/net/http.ts'], 'query + the best BM25 chunk first');
  await r.idle();
  assert.ok(emb.calls.slice(1).every((b) => b.length <= 3), 'background works in small groups');
  assert.equal(r.size, 8, 'stops at the chunk cap');
});

test('hybrid: vectors persist in the storage folder and are reused after a restart; a new model re-embeds', async () => {
  const root = await repo({ 'src/auth/users.ts': AUTH, 'src/net/http.ts': HTTP });
  const store = await tmpDir('hybrid-store-');
  const first = ranker(root, fakeEmbedder(), { storeDir: store });
  await new CodeIndex(root, undefined, first).search('login');
  await first.idle();
  const saved = await fs.readdir(store);
  assert.equal(saved.length, 1);

  const emb = fakeEmbedder();
  const hits = await new CodeIndex(root, undefined, ranker(root, emb, { storeDir: store })).search('login');
  assert.equal(hits[0].file, 'src/auth/users.ts');
  assert.deepEqual(emb.calls, [['login']], 'nothing but the query is sent after a restart');

  const other = fakeEmbedder('other-embed');
  await new CodeIndex(root, undefined, ranker(root, other, { storeDir: store })).search('login');
  assert.equal(other.calls[0].length, 3, 'a different model does not reuse the old vectors');
});
