import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { activeMention, expandMentions, extractMentions, filterFiles } from '../core/mentions';
import { COMMANDS, SlashApi, matchCommands, parseSlash, runSlash } from '../core/slash';
import { tmpDir } from './helpers';

test('mentions: extracts paths and line ranges, ignores emails and duplicates', () => {
  const m = extractMentions('look at @src/a.ts and @b.py:10-20, also @src/a.ts, mail me@x.com');
  assert.deepEqual(m.map((x) => x.raw), ['src/a.ts', 'b.py:10-20']);
  assert.deepEqual(m[1], { raw: 'b.py:10-20', path: 'b.py', start: 10, end: 20 });
});

test('mentions: single line and trailing punctuation', () => {
  const m = extractMentions('see @a.ts:5. then (@b.ts)');
  assert.deepEqual(m.map((x) => x.raw), ['a.ts:5', 'b.ts']);
  assert.equal(m[0].end, 5);
});

test('mentions: expand attaches file contents, original text preserved', async () => {
  const root = await tmpDir();
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'line1\nline2\nline3');
  const r = await expandMentions('explain @src/a.ts', root);
  assert.deepEqual(r.files, ['src/a.ts']);
  assert.match(r.text, /^explain @src\/a\.ts/);
  assert.match(r.text, /<file path="src\/a\.ts">\nline1\nline2\nline3\n<\/file>/);
});

test('mentions: line range slices the file', async () => {
  const root = await tmpDir();
  await fs.writeFile(path.join(root, 'f.txt'), 'a\nb\nc\nd');
  const r = await expandMentions('@f.txt:2-3', root);
  assert.match(r.text, /lines="2-3">\nb\nc\n<\/file>/);
  assert.doesNotMatch(r.text, /\na\n|\nd\n/);
});

test('mentions: missing files, directories and path escapes are reported, never read', async () => {
  const root = await tmpDir();
  await fs.mkdir(path.join(root, 'dir'));
  const outside = path.join(path.dirname(root), 'secret.txt');
  await fs.writeFile(outside, 'TOP SECRET');
  const r = await expandMentions('@nope.ts @dir @../secret.txt', root);
  assert.deepEqual(r.files, []);
  assert.equal(r.missing.length, 3);
  assert.doesNotMatch(r.text, /TOP SECRET/);
  assert.equal(r.text, '@nope.ts @dir @../secret.txt');
});

test('mentions: oversized files are truncated and the total budget is enforced', async () => {
  const root = await tmpDir();
  await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(50000));
  await fs.writeFile(path.join(root, 'b2.txt'), 'y'.repeat(20000));
  await fs.writeFile(path.join(root, 'b3.txt'), 'z'.repeat(20000));
  await fs.writeFile(path.join(root, 'b4.txt'), 'w'.repeat(20000));
  const r = await expandMentions('@big.txt @b2.txt @b3.txt @b4.txt', root);
  assert.match(r.text, /\[truncated\]/);
  assert.ok(r.text.length < 70000);
  assert.ok(r.missing.some((m) => m.includes('budget')));
});

test('filterFiles: prefix beats contains beats path; boost wins ties; limit applies', () => {
  const files = ['docs/readme.md', 'src/reader.ts', 'src/app/read.ts', 'lib/x.ts', 'src/thread.ts'];
  assert.deepEqual(filterFiles(files, 'read').slice(0, 2), ['src/app/read.ts', 'src/reader.ts']);
  assert.ok(filterFiles(files, 'read').includes('src/thread.ts'), 'contains match included');
  assert.deepEqual(filterFiles(files, 'zzz'), []);
  assert.equal(filterFiles(files, '', 2).length, 2);
  assert.equal(filterFiles(files, 'read', 12, new Set(['src/reader.ts']))[0], 'src/reader.ts');
  assert.deepEqual(filterFiles(['A/B.TS'], 'b.t'), ['A/B.TS'], 'case-insensitive');
});

test('activeMention: only when the caret is inside an @token', () => {
  assert.deepEqual(activeMention('fix @src/ap'), { query: 'src/ap', start: 4 });
  assert.deepEqual(activeMention('@'), { query: '', start: 0 });
  assert.equal(activeMention('mail a@b.com'), undefined);
  assert.equal(activeMention('done @a.ts '), undefined);
});

test('slash: parsing', () => {
  assert.deepEqual(parseSlash('/help'), { name: 'help', args: '', known: true });
  assert.deepEqual(parseSlash('/mode  auto '), { name: 'mode', args: 'auto', known: true });
  assert.equal(parseSlash('/new')!.name, 'clear');
  assert.equal(parseSlash('/rewind')!.name, 'undo');
  assert.equal(parseSlash('/bogus')!.known, false);
  assert.equal(parseSlash('/usr/bin/ls how?'), null, 'paths are not commands');
  assert.equal(parseSlash('hello /help'), null);
  assert.equal(parseSlash('/plan fix the bug\nplease')!.args, 'fix the bug\nplease');
});

test('slash: matchCommands filters by prefix', () => {
  assert.deepEqual(matchCommands('/m').map((c) => c.name), ['mcp', 'mode', 'model', 'memory']);
  assert.equal(matchCommands('').length, COMMANDS.length);
  assert.deepEqual(matchCommands('zz'), []);
});

function fakeApi() {
  const log: string[] = [];
  const api: SlashApi = {
    info: (t) => log.push(`info:${t}`), newChat: () => log.push('new'), undo: async () => { log.push('undo'); }, compact: async () => { log.push('compact'); }, mcp: async (a) => { log.push(`mcp:${a}`); }, agents: () => { log.push('agents'); }, skills: () => { log.push('skills'); },
    openHistory: () => log.push('history'), setMode: (m) => log.push(`mode:${m}`), setEffort: (e) => log.push(`effort:${e}`),
    setModel: (n) => log.push(`model:${n}`), currentModel: () => 'm1', models: () => ['m1', 'm2'],
    send: async (p, d) => { log.push(`send:${d ?? ''}:${p.slice(0, 12)}`); },
  };
  return { api, log };
}

test('runSlash: simple commands dispatch', async () => {
  const { api, log } = fakeApi();
  for (const t of ['/clear', '/undo', '/history', '/mode auto', '/effort HIGH', '/model m2']) { await runSlash(parseSlash(t)!, api); }
  assert.deepEqual(log.filter((l) => !l.startsWith('info')), ['new', 'undo', 'history', 'mode:auto', 'effort:high', 'model:m2']);
});

test('runSlash: invalid arguments give usage and change nothing', async () => {
  const { api, log } = fakeApi();
  await runSlash(parseSlash('/mode turbo')!, api);
  await runSlash(parseSlash('/effort 11')!, api);
  await runSlash(parseSlash('/model nope')!, api);
  assert.equal(log.filter((l) => !l.startsWith('info')).length, 0);
  assert.match(log[0], /Usage: \/mode/);
  assert.match(log[2], /Unknown model "nope"/);
});

test('runSlash: /plan switches mode and optionally sends the task', async () => {
  const a = fakeApi();
  await runSlash(parseSlash('/plan')!, a.api);
  assert.deepEqual(a.log.filter((l) => !l.startsWith('info')), ['mode:plan']);
  const b = fakeApi();
  await runSlash(parseSlash('/plan add caching')!, b.api);
  assert.deepEqual(b.log, ['mode:plan', 'send::add caching']);
});

test('runSlash: /init and /review send prompts shown as the command', async () => {
  const { api, log } = fakeApi();
  await runSlash(parseSlash('/init')!, api); await runSlash(parseSlash('/review')!, api);
  assert.match(log[0], /^send:\/init:Analyze/);
  assert.match(log[1], /^send:\/review:Review the/);
});

test('runSlash: unknown command is reported, /help lists every command', async () => {
  const { api, log } = fakeApi();
  assert.equal(await runSlash(parseSlash('/bogus')!, api), true);
  assert.match(log[0], /Unknown command/);
  await runSlash(parseSlash('/help')!, api);
  for (const c of COMMANDS) { assert.ok(log[1].includes(`/${c.name}`), c.name); }
});
