import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FileIndex, NON_TEXT_EXT, SearchEngine, areaOverview, findRipgrep, formatSearch, matchCap, prioritize, ripgrepCandidates, search } from '../core/search';
import { tmpDir } from './helpers';

async function repo(files: Record<string, string>): Promise<string> {
  const root = await tmpDir('srch2-');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}

async function vscodeRg(): Promise<string | undefined> {
  const roots: string[] = [];
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code') : '';
  try { for (const d of await fs.readdir(base)) { roots.push(path.join(base, d, 'resources', 'app')); } } catch { /* not installed */ }
  return findRipgrep(roots.flatMap((r) => ripgrepCandidates(r)), process.env.ICA_RG_PATH);
}

async function engines(root: string): Promise<SearchEngine[]> {
  const out: SearchEngine[] = [{ root, index: new FileIndex(root) }];
  const rg = await vscodeRg();
  if (rg) { out.push({ root, index: new FileIndex(root), rgPath: rg }); }
  return out;
}
const tag = (e: SearchEngine): string => (e.rgPath ? 'rg' : 'js');

test('matchCap: collects about twice what is shown, with a floor', () => {
  assert.equal(matchCap({}), 200);
  assert.equal(matchCap({ maxResults: 10 }), 50);
  assert.equal(matchCap({ maxResults: 300 }), 600);
});

test('early stop: a pattern with many matches stops scanning and says so (all engines)', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 400; i++) { files[`src/f${i}.ts`] = 'const needle = 1;\nconst needle2 = 2;\n'; }
  const root = await repo(files);
  for (const eng of await engines(root)) {
    const res = await search(eng, { pattern: 'needle', maxResults: 10 });
    assert.equal(res.truncated, true, tag(eng));
    assert.ok(res.totalMatches >= 50 && res.totalMatches < 800, `${tag(eng)} stopped early, got ${res.totalMatches}`);
    assert.match(formatSearch(res, { pattern: 'needle', maxResults: 10 }), /more results exist/);
  }
});

test('time budget: an exhausted budget is reported as partial/inconclusive, never as "no matches" (all engines)', async () => {
  const root = await repo({ 'a/x.ts': 'hello world', 'b/y.ts': 'other' });
  for (const eng of await engines(root)) {
    await eng.index.files();
    const o = { pattern: 'zzz_not_present', timeoutMs: 0 };
    const res = await search(eng, o);
    assert.equal(res.timedOut, true, tag(eng));
    const text = formatSearch(res, o);
    assert.match(text, /timed out/i, tag(eng));
    assert.match(text, /inconclusive/, tag(eng));
    assert.doesNotMatch(text, /^No matches/, tag(eng));
    assert.match(text, /Biggest areas: a \(1 files\), b \(1 files\)/, 'area overview from the cached index');
    assert.match(text, /Narrow it with path or glob/);
  }
});

test('time budget: partial matches are still shown, flagged PARTIAL, and a scoped search drops the narrowing advice', async () => {
  const root = await repo({ 'a/x.ts': 'needle', 'b/y.ts': 'needle' });
  const eng = (await engines(root))[0];
  await eng.index.files();
  const res = { files: [{ file: 'a/x.ts', count: 1, lines: [{ line: 1, text: 'needle', ctx: false }] }], totalMatches: 1, truncated: true, timedOut: true, engine: 'js' as const, ms: 21000, hint: 'a (1 files)' };
  const text = formatSearch(res, { pattern: 'needle' });
  assert.match(text, /^Found 1\+ match in 1\+ file/);
  assert.match(text, /\[PARTIAL: the 21s time budget ran out/);
  assert.match(text, /Narrow it with path or glob/);
  assert.doesNotMatch(formatSearch(res, { pattern: 'needle', glob: '*.ts' }), /Narrow it with path or glob/);
});

test('non-text files are never opened: binaries, logs, minified bundles and lockfiles are skipped (all engines)', async () => {
  const root = await repo({
    'src/app.ts': 'needle', 'dist2/app.min.js': 'needle', 'data/big.log': 'needle', 'data/events.ndjson': 'needle',
    'img/a.svg': 'needle', 'package-lock.json': 'needle', 'sub/yarn.lock': 'needle', 'notes.txt': 'needle',
  });
  for (const eng of await engines(root)) {
    const res = await search(eng, { pattern: 'needle', mode: 'files' });
    assert.deepEqual(res.files.map((f) => f.file).sort(), ['notes.txt', 'src/app.ts'], tag(eng));
  }
  assert.ok(['log', 'lock', 'png', 'svg', 'ndjson'].every((e) => NON_TEXT_EXT.includes(e)));
});

test('prioritize: relevant source first, tests/vendored/docs last, stable otherwise', () => {
  const out = prioritize(['tests/test_a.py', 'docs/x.md', 'src/misc.py', 'src/verify_token.py', 'vendor/lib.py'], 'verify_token');
  assert.equal(out[0], 'src/verify_token.py');
  assert.equal(out[1], 'src/misc.py');
  assert.deepEqual(new Set(out.slice(2)), new Set(['tests/test_a.py', 'docs/x.md', 'vendor/lib.py']));
});

test('prioritize + early stop: the best files are the ones that make the cut (js engine)', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 120; i++) { files[`tests/t${i}.py`] = 'verify_token()\n'.repeat(3); }
  files['src/auth/verify_token.py'] = 'def verify_token(): pass\n';
  const root = await repo(files);
  const res = await search({ root, index: new FileIndex(root) }, { pattern: 'verify_token', maxResults: 10 });
  assert.equal(res.truncated, true);
  assert.ok(res.files.some((f) => f.file === 'src/auth/verify_token.py'), 'definition found despite 120 noisy test files');
  assert.match(formatSearch(res, { pattern: 'verify_token', maxResults: 10 }).split('\n')[1], /^src\/auth\/verify_token\.py$/);
});

test('areaOverview: top-level folders by size, root files grouped', () => {
  const files = ['a/1', 'a/2', 'a/3', 'b/1', 'c/1', 'README.md'];
  assert.equal(areaOverview(files, 2), 'a (3 files), b (1 files)');
  assert.match(areaOverview(['x', 'y']), /\(root files\) \(2 files\)/);
  assert.match(areaOverview(Array.from({ length: 12000 }, (_, i) => `big/${i}`)), /big \(12,000 files\)/);
});

test('index.peek never triggers a build', async () => {
  const root = await repo({ 'a.ts': '' });
  const idx = new FileIndex(root);
  assert.equal(idx.peek(), undefined);
  await idx.files();
  assert.deepEqual(idx.peek(), ['a.ts']);
  idx.invalidate();
  assert.equal(idx.peek(), undefined);
});

test('engine policy: auto uses ripgrep until the index is warm, then the indexed engine; explicit choices are honoured', async () => {
  const rg = await vscodeRg();
  const root = await repo({ 'a/x.ts': 'needle here', 'b/y.ts': 'no' });
  const index = new FileIndex(root);
  const eng = (prefer: 'auto' | 'ripgrep' | 'builtin'): SearchEngine => ({ root, index, rgPath: rg, prefer });
  if (rg) {
    assert.equal((await search(eng('auto'), { pattern: 'needle' })).engine, 'rg', 'cold index → rg');
    await index.files();
    assert.equal((await search(eng('auto'), { pattern: 'needle' })).engine, 'js', 'warm index → built-in');
    assert.equal((await search(eng('ripgrep'), { pattern: 'needle' })).engine, 'rg', 'forced rg');
  }
  assert.equal((await search(eng('builtin'), { pattern: 'needle' })).engine, 'js', 'forced built-in');
  assert.equal((await search({ root, index, prefer: 'ripgrep' }, { pattern: 'needle' })).engine, 'js', 'no rg binary → falls back');
});

test('auto mode warms the index in the background on a cold first search', async () => {
  const root = await repo({ 'a.ts': 'needle' });
  const index = new FileIndex(root);
  const rg = await vscodeRg();
  if (!rg) { return; }
  await search({ root, index, rgPath: rg, prefer: 'auto' }, { pattern: 'needle' });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(index.peek(), 'index was built after the first search');
});
