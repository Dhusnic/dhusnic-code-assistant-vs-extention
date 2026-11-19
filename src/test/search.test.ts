import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createIgnore, filterFiles, hasGlobChars, matchesGlob } from '../core/glob';
import { FileIndex, SearchEngine, findRipgrep, formatSearch, indexFiles, rankFiles, ripgrepCandidates, search } from '../core/search';
import { createFsTools } from '../core/fstools';
import { tmpDir } from './helpers';

async function repo(files: Record<string, string>): Promise<string> {
  const root = await tmpDir('srch-');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}
const ctxFor = (root: string) => ({ root, signal: new AbortController().signal, snapshot: async () => {} });

/* ---------------------------------------------------------------- ignore rules */

test('gitignore: comments, blanks, anchoring, dir-only, negation, wildcards', () => {
  const ig = createIgnore(['# comment', '', '*.log', '/build', 'cache/', '!keep.log', 'docs/*.tmp', '**/gen/**']);
  assert.equal(ig.ignores('a/b/x.log', false), true);
  assert.equal(ig.ignores('keep.log', false), false, 'negation re-includes');
  assert.equal(ig.ignores('build', true), true);
  assert.equal(ig.ignores('src/build', true), false, 'leading slash anchors to the root');
  assert.equal(ig.ignores('cache', true), true);
  assert.equal(ig.ignores('cache', false), false, 'dir-only rule does not hit a file named cache');
  assert.equal(ig.ignores('docs/a.tmp', false), true);
  assert.equal(ig.ignores('docs/sub/a.tmp', false), false, 'single * does not cross directories');
  assert.equal(ig.ignores('src', true), false);
  assert.equal(ig.test('src/code.ts', false), undefined, 'no rule matched → undefined');
});

test('glob helpers: case-insensitive matching, glob detection, fuzzy ranking', () => {
  assert.ok(matchesGlob('Src/App.TS', '*.ts'));
  assert.ok(hasGlobChars('**/*.py') && hasGlobChars('a{b,c}') && !hasGlobChars('cmdb_controller'));
  const files = ['infraon_api/app/cmdb/cmdb_controller.py', 'infraon_api/tests/test_cmdb_controller.py', 'x/other.py'];
  assert.deepEqual(filterFiles(files, 'cmdb_controller', 5)[0], 'infraon_api/app/cmdb/cmdb_controller.py');
});

/* ---------------------------------------------------------------- index */

test('index: respects root and nested .gitignore, skips node_modules and .git', async () => {
  const root = await repo({
    '.gitignore': 'secret.txt\nbuild/\n',
    'keep.ts': '', 'secret.txt': '', 'build/out.js': '',
    'node_modules/x/i.js': '', '.git/config': '',
    'pkg/.gitignore': '*.gen.ts\n!important.gen.ts\n',
    'pkg/a.ts': '', 'pkg/b.gen.ts': '', 'pkg/important.gen.ts': '', 'pkg/sub/c.gen.ts': '', 'other/b.gen.ts': '',
  });
  assert.deepEqual(await indexFiles(root), ['.gitignore', 'keep.ts', 'other/b.gen.ts', 'pkg/.gitignore', 'pkg/a.ts', 'pkg/important.gen.ts']);
});

test('index: caches results, invalidate() forces a rebuild, concurrent calls share one build', async () => {
  const root = await repo({ 'a.ts': '' });
  const idx = new FileIndex(root, 60_000);
  const [x, y] = await Promise.all([idx.files(), idx.files()]);
  assert.strictEqual(x, y, 'one shared build');
  await fs.writeFile(path.join(root, 'b.ts'), '');
  assert.deepEqual(await idx.files(), ['a.ts'], 'still cached');
  idx.invalidate();
  assert.deepEqual(await idx.files(), ['a.ts', 'b.ts']);
});

test('index: expires after the ttl', async () => {
  const root = await repo({ 'a.ts': '' });
  const idx = new FileIndex(root, 20);
  await idx.files();
  await fs.writeFile(path.join(root, 'b.ts'), '');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(await idx.files(), ['a.ts', 'b.ts']);
});

test('index: an invalidate during a build does not cache the stale result', async () => {
  const root = await repo({ 'a.ts': '' });
  const idx = new FileIndex(root, 60_000);
  const pending = idx.files();
  idx.invalidate();
  await pending;
  await fs.writeFile(path.join(root, 'late.ts'), '');
  assert.ok((await idx.files()).includes('late.ts'));
});

/* ---------------------------------------------------------------- search engines */

const FIXTURE = {
  'src/auth.py': 'import jwt\n\ndef verify_token(token):\n    return jwt.decode(token)\n\ndef other():\n    pass\n',
  'src/db.py': 'client = MongoClient(uri)\n# verify_token is not used here\n',
  'tests/test_auth.py': 'from src.auth import verify_token\nverify_token("x")\nverify_token("y")\n',
  'README.md': 'verify_token docs\n',
  'bin.dat': 'verify_token\u0000\u0001binary',
  'node_modules/dep/index.js': 'verify_token',
};

/** Finds VS Code's bundled ripgrep so the rg engine is exercised wherever VS Code is installed (skipped otherwise). */
async function vscodeRgCandidates(): Promise<string[]> {
  const roots: string[] = [];
  if (process.env.ICA_RG_APPROOT) { roots.push(process.env.ICA_RG_APPROOT); }
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code') : '';
  try { for (const d of await fs.readdir(base)) { roots.push(path.join(base, d, 'resources', 'app')); } } catch { /* not installed here */ }
  return roots.flatMap((r) => ripgrepCandidates(r));
}

async function engines(root: string): Promise<SearchEngine[]> {
  const out: SearchEngine[] = [{ root, index: new FileIndex(root) }];
  const rg = await findRipgrep(await vscodeRgCandidates(), process.env.ICA_RG_PATH);
  if (rg) { out.push({ root, index: new FileIndex(root), rgPath: rg }); }
  return out;
}

test('search: content mode finds matches with line numbers; ignores binaries and node_modules (all engines)', async () => {
  const root = await repo(FIXTURE);
  for (const eng of await engines(root)) {
    const res = await search(eng, { pattern: 'verify_token' });
    const byFile = Object.fromEntries(res.files.map((f) => [f.file, f]));
    assert.deepEqual(Object.keys(byFile).sort(), ['README.md', 'src/auth.py', 'src/db.py', 'tests/test_auth.py'], eng.rgPath ? 'rg' : 'js');
    assert.equal(byFile['src/auth.py'].lines[0].line, 3);
    assert.equal(byFile['tests/test_auth.py'].count, 3);
    assert.equal(res.totalMatches, 1 + 1 + 3 + 1);
  }
});

test('search: files and count modes, glob, path and case options (all engines)', async () => {
  const root = await repo(FIXTURE);
  for (const eng of await engines(root)) {
    const tag = eng.rgPath ? 'rg' : 'js';
    const files = await search(eng, { pattern: 'verify_token', mode: 'files', glob: '*.py' });
    assert.deepEqual(files.files.map((f) => f.file).sort(), ['src/auth.py', 'src/db.py', 'tests/test_auth.py'], tag);
    const count = await search(eng, { pattern: 'verify_token', mode: 'count', path: 'tests' });
    assert.deepEqual(count.files.map((f) => [f.file, f.count]), [['tests/test_auth.py', 3]], tag);
    assert.equal((await search(eng, { pattern: 'MONGOCLIENT', ignoreCase: false })).totalMatches, 0, tag);
    assert.equal((await search(eng, { pattern: 'MONGOCLIENT' })).totalMatches, 1, tag);
  }
});

test('search: context lines are marked and adjacent hunks are merged (all engines)', async () => {
  const root = await repo(FIXTURE);
  for (const eng of await engines(root)) {
    const res = await search(eng, { pattern: 'return jwt', context: 1 });
    const f = res.files.find((x) => x.file === 'src/auth.py')!;
    assert.deepEqual(f.lines.map((l) => [l.line, l.ctx]), [[3, true], [4, false], [5, true]], eng.rgPath ? 'rg' : 'js');
    assert.equal(res.totalMatches, 1);
  }
});

test('search: regex features ripgrep lacks (lookahead) transparently fall back to the JS engine', async () => {
  const root = await repo(FIXTURE);
  for (const eng of await engines(root)) {
    const res = await search(eng, { pattern: 'verify_token(?=\\()' });
    assert.equal(res.engine, 'js');
    assert.ok(res.totalMatches >= 2);
  }
});

test('search: invalid regex gives a clear error', async () => {
  const root = await repo(FIXTURE);
  for (const eng of await engines(root)) { await assert.rejects(search(eng, { pattern: '([unclosed' }), /regex|parse|Unmatched|Invalid/i); }
});

test('search: respects .gitignore (all engines)', async () => {
  const root = await repo({ '.gitignore': 'ignored/\n', 'ignored/a.txt': 'needle', 'kept/b.txt': 'needle' });
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  for (const eng of await engines(root)) {
    assert.deepEqual((await search(eng, { pattern: 'needle', mode: 'files' })).files.map((f) => f.file), ['kept/b.txt'], eng.rgPath ? 'rg' : 'js');
  }
});

test('search: aborting returns promptly without throwing', async () => {
  const root = await repo(FIXTURE);
  const ac = new AbortController(); ac.abort();
  for (const eng of await engines(root)) { await search(eng, { pattern: 'verify_token' }, ac.signal); }
});

/* ---------------------------------------------------------------- ranking & formatting */

test('rank: source files whose path mentions the query beat tests and vendored code', () => {
  const mk = (file: string, count: number) => ({ file, count, lines: [] });
  const ranked = rankFiles([mk('tests/test_auth.py', 9), mk('docs/guide.md', 5), mk('src/other.py', 3), mk('src/verify_token.py', 1), mk('node_modules/x/i.js', 50)], 'verify_token');
  assert.equal(ranked[0].file, 'src/verify_token.py');
  assert.equal(ranked.at(-1)!.file.startsWith('node_modules') || ranked.at(-1)!.file.startsWith('tests') || ranked.at(-1)!.file.startsWith('docs'), true);
  assert.ok(ranked.findIndex((f) => f.file === 'src/other.py') < ranked.findIndex((f) => f.file === 'tests/test_auth.py'));
});

test('format: grouped output, truncation hint, no-match message, modes', async () => {
  const root = await repo(FIXTURE);
  const eng = (await engines(root))[0];
  const res = await search(eng, { pattern: 'verify_token' });
  const text = formatSearch(res, { pattern: 'verify_token' });
  assert.match(text, /^Found 6 matches in 4 files \(js, \d+ ms\)/);
  assert.ok(text.indexOf('src/auth.py') < text.indexOf('tests/test_auth.py'), 'ranked: source before tests');
  assert.match(text, /src\/auth\.py\n {2}3: def verify_token/);
  assert.match(formatSearch(res, { pattern: 'verify_token', maxResults: 2 }), /more results exist/);
  assert.match(formatSearch(await search(eng, { pattern: 'nope' }), { pattern: 'nope' }), /^No matches for \/nope\//);
  const files = formatSearch(await search(eng, { pattern: 'verify_token', mode: 'files' }), { pattern: 'verify_token', mode: 'files' });
  assert.doesNotMatch(files, /\d+: /);
  assert.match(formatSearch(await search(eng, { pattern: 'verify_token', mode: 'count' }), { pattern: 'verify_token', mode: 'count' }), /test_auth\.py: 3/);
});

test('format: very long lines are clipped', async () => {
  const root = await repo({ 'a.txt': `needle ${'x'.repeat(5000)}\n` });
  const eng = (await engines(root))[0];
  const text = formatSearch(await search(eng, { pattern: 'needle' }), { pattern: 'needle' });
  assert.ok(text.length < 400);
});

/* ---------------------------------------------------------------- tools */

test('tool glob_files: name fragments, globs, sub-path, ordering and the result cap', async () => {
  const files: Record<string, string> = { 'app/cmdb/cmdb_controller.py': '', 'tests/test_cmdb_controller.py': '', 'x/other.py': '', 'sub/deep/y.ts': '' };
  for (let i = 0; i < 230; i++) { files[`many/f${String(i).padStart(3, '0')}.log`] = ''; }
  const root = await repo(files);
  const tool = createFsTools().find((t) => t.spec.function.name === 'glob_files')!;
  const run = (a: object) => tool.run(a, ctxFor(root));
  assert.equal((await run({ pattern: 'cmdb_controller' })).split('\n')[0], 'app/cmdb/cmdb_controller.py');
  assert.equal(await run({ pattern: '**/*.ts' }), 'sub/deep/y.ts');
  assert.equal(await run({ pattern: '*.py', path: 'x' }), 'x/other.py');
  assert.equal(await run({ pattern: 'zzz' }), '(no matches)');
  const big = await run({ pattern: '*.log' });
  assert.equal(big.split('\n').length, 201);
  assert.match(big, /\[30 more files/);
  await assert.rejects(run({ pattern: 'x', path: '../outside' }), /outside workspace/);
});

test('tool grep: output modes, path scoping, option validation', async () => {
  const root = await repo(FIXTURE);
  const grep = createFsTools().find((t) => t.spec.function.name === 'grep')!;
  const run = (a: object) => grep.run(a, ctxFor(root));
  assert.match(await run({ pattern: 'verify_token', output_mode: 'count' }), /src\/auth\.py: 1/);
  assert.match(await run({ pattern: 'verify_token', output_mode: 'bogus' }), /^Found 6 matches/, 'unknown mode falls back to content');
  assert.doesNotMatch(await run({ pattern: 'verify_token', path: 'tests' }), /src\/auth\.py/);
  assert.match(await run({ pattern: 'jwt', context: 1, glob: '*.py' }), /\n {2}2- /);
  await assert.rejects(run({ pattern: 'x', path: '../..' }), /outside workspace/);
});

test('tools: writes and commands invalidate the index so new files are found immediately', async () => {
  const root = await repo({ 'a.ts': 'one' });
  const tools = Object.fromEntries(createFsTools().map((t) => [t.spec.function.name, t]));
  const ctx = ctxFor(root);
  assert.equal(await tools.glob_files.run({ pattern: 'fresh' }, ctx), '(no matches)');
  await tools.write_file.run({ path: 'fresh_file.ts', content: 'needle-in-new-file' }, ctx);
  assert.equal(await tools.glob_files.run({ pattern: 'fresh' }, ctx), 'fresh_file.ts');
  assert.match(await tools.grep.run({ pattern: 'needle-in-new' }, ctx), /fresh_file\.ts/);
  await tools.run_command.run({ command: process.platform === 'win32' ? 'New-Item cmd_made.txt -ItemType File | Out-Null' : 'touch cmd_made.txt' }, ctx);
  assert.equal(await tools.glob_files.run({ pattern: 'cmd_made' }, ctx), 'cmd_made.txt');
});

test('ripgrep discovery: ignores missing candidates, prefers a user path', async () => {
  const found = await findRipgrep(['/definitely/not/here/rg'], '/also/missing');
  assert.ok(found === undefined || found === 'rg', 'missing paths are skipped; only the PATH fallback can match');
  const cands = ripgrepCandidates('/app', 'win32', 'x64');
  assert.ok(cands.every((c) => c.endsWith('rg.exe')));
  assert.ok(cands.some((c) => c.includes('ripgrep-universal') && c.includes('win32-x64')));
});
