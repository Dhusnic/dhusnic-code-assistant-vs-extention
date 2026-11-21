import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CodeIndex, codeTokens, formatCodeHits } from '../core/codeSearch';
import { FileIndex } from '../core/search';
import { createFsTools } from '../core/fstools';
import { tmpDir } from './helpers';

async function repo(files: Record<string, string>): Promise<string> {
  const root = await tmpDir('codesearch-');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}
const ctxFor = (root: string) => ({ root, signal: new AbortController().signal, snapshot: async () => {} });

const SESSIONS = `import { Store } from './store';

/** Removes sessions whose token expired. */
export async function cleanupExpiredSessions(store: Store, now: number): Promise<number> {
  const all = await store.listSessions();
  const expired = all.filter((s) => s.expiresAt < now);
  for (const s of expired) { await store.deleteSession(s.id); }
  return expired.length;
}
`;
const HTTP = `export async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let delay = 200;
  for (let i = 0; i < attempts; i++) {
    try { return await fetch(url); } catch { await new Promise((r) => setTimeout(r, delay)); delay *= 2; }
  }
  throw new Error('request failed after retries with exponential backoff');
}
`;
const NOISE = 'export const VERSION = "1.0";\nexport function add(a: number, b: number) { return a + b; }\n';

test('tokens: identifiers split into words, lower-cased, stemmed; question words dropped only from queries', () => {
  assert.deepEqual(codeTokens('getUserName MAX_RETRY_COUNT parseHTTPResponse'), ['get', 'user', 'name', 'max', 'retry', 'count', 'parse', 'http', 'response']);
  assert.deepEqual(codeTokens('expired sessions'), ['expir', 'session']);
  assert.deepEqual(codeTokens('where is the code that handles file uploads', true), ['handle', 'file', 'upload']);
  assert.ok(codeTokens('file upload').includes('file'), 'words like "file" stay searchable in code');
});

test('search: finds code by what it does, ranks the right file first, and shows the matching lines', async () => {
  const root = await repo({ 'src/auth/sessionCleaner.ts': SESSIONS, 'src/net/http.ts': HTTP, 'src/util/math.ts': NOISE });
  const idx = new CodeIndex(root);
  const [first] = await idx.search('where do we clean up expired sessions?');
  assert.equal(first.file, 'src/auth/sessionCleaner.ts');
  assert.ok(first.snippet.some((l) => /cleanupExpiredSessions/.test(l)), 'snippet holds the function');
  assert.match(first.snippet[0], /^\d+\t/, 'snippet lines carry line numbers');
  const [retry] = await idx.search('retry request with backoff');
  assert.equal(retry.file, 'src/net/http.ts');
  assert.deepEqual(await idx.search('the where how'), [], 'a query of only stop words finds nothing');
});

test('search: re-reads changed files, drops deleted ones, honours .gitignore and a sub-folder', async () => {
  const root = await repo({ 'a/one.ts': NOISE, 'b/two.ts': NOISE, '.gitignore': 'generated/\n', 'generated/big.ts': SESSIONS });
  const files = new FileIndex(root, 0);
  const idx = new CodeIndex(root, files);
  assert.deepEqual(await idx.search('expired sessions'), [], 'ignored folders are not indexed');
  await fs.writeFile(path.join(root, 'a/one.ts'), SESSIONS);
  await fs.utimes(path.join(root, 'a/one.ts'), new Date(), new Date(Date.now() + 5000)); // make sure the mtime differs
  assert.equal((await idx.search('expired sessions'))[0]?.file, 'a/one.ts', 'a changed file is picked up');
  assert.deepEqual(await idx.search('expired sessions', { under: 'b' }), [], 'path limits the search to a sub-folder');
  await fs.rm(path.join(root, 'a/one.ts'));
  assert.deepEqual(await idx.search('expired sessions'), [], 'a deleted file disappears');
});

test('search: long files are split into regions and one result per region is returned', async () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `const filler${i} = ${i};`).join('\n');
  const root = await repo({ 'big.ts': `${filler(100)}\nfunction rotateSigningKey() { /* rotate the signing key */ }\n${filler(100)}\n` });
  const hits = await new CodeIndex(root).search('rotate signing key');
  assert.equal(hits.length, 1, 'overlapping regions of one place are merged');
  assert.ok(hits[0].start <= 101 && hits[0].end >= 101, `region ${hits[0].start}-${hits[0].end} contains line 101`);
});

test('tool: search_code is read-only, formats ranked regions, and invalidates with writes', async () => {
  const root = await repo({ 'src/net/http.ts': HTTP });
  const tool = createFsTools().find((t) => t.spec.function.name === 'search_code')!;
  assert.equal(tool.kind, 'read');
  const out = await tool.run({ query: 'retry backoff' }, ctxFor(root));
  assert.match(out, /^1\. src\/net\/http\.ts:1-\d+\n/);
  assert.match(out, /Ranked by word relevance/);
  assert.match(await tool.run({ query: 'kubernetes ingress' }, ctxFor(root)), /no code matched/);
  // The same tool set shares its file index with write_file, so new files are searchable at once.
  const tools = Object.fromEntries(createFsTools().map((t) => [t.spec.function.name, t]));
  await tools.write_file.run({ path: 'src/auth/sessionCleaner.ts', content: SESSIONS }, ctxFor(root));
  assert.match(await tools.search_code.run({ query: 'expired sessions' }, ctxFor(root)), /sessionCleaner\.ts/);
});

test('format: numbered regions with a hint, and a helpful message when nothing matched', () => {
  const out = formatCodeHits([{ file: 'a.ts', start: 1, end: 40, score: 1, snippet: ['3\tfoo()'] }], 'foo', false, 'api/');
  assert.equal(out.split('\n')[0], '1. api/a.ts:1-40');
  assert.match(formatCodeHits([], 'zzz', false), /no code matched "zzz"/);
  assert.match(formatCodeHits([{ file: 'a.ts', start: 1, end: 2, score: 1, snippet: [] }], 'q', true), /Only the first/);
});
