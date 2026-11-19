import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  CURSOR, CompletionEngine, LruCache, MAX_COMPLETION_LINES, PREFIX_CHARS, SUFFIX_CHARS,
  buildCompletionMessages, cleanCompletion, shouldTrigger, trimContext,
} from '../core/completion';
import { LlmFn } from '../core/llm';

const req = (prefix: string, suffix = '') => ({ prefix, suffix, language: 'typescript', file: 'src/a.ts' });

test('prompt: places the cursor marker between prefix and suffix, with file and language', () => {
  const m = buildCompletionMessages(req('const a = ', ';\nexport {}'));
  assert.equal(m[0].role, 'system'); assert.match(m[0].content!, /ONLY the code/);
  assert.match(m[1].content!, /File: src\/a\.ts \(typescript\)/);
  assert.ok(m[1].content!.includes(`const a = ${CURSOR};\nexport {}`));
});

test('prompt: huge files are trimmed to bounded context on line boundaries', () => {
  const prefix = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const suffix = Array.from({ length: 2000 }, (_, i) => `after ${i}`).join('\n');
  const t = trimContext(prefix, suffix);
  assert.ok(t.prefix.length <= PREFIX_CHARS && t.suffix.length <= SUFFIX_CHARS);
  assert.match(t.prefix, /^line \d+/, 'prefix starts at a line boundary');
  assert.ok(t.prefix.endsWith('line 1999\n'), 'keeps the text nearest the cursor');
  assert.match(t.suffix, /^after 0/);
  assert.ok(!t.suffix.includes('after 1999'), 'far-away suffix is dropped');
});

test('trigger: skips empty files and mid-line cursors, allows end-of-line and before closers', () => {
  assert.equal(shouldTrigger('', ''), false);
  assert.equal(shouldTrigger('   \n  ', ''), false);
  assert.equal(shouldTrigger('foo(', ''), true);
  assert.equal(shouldTrigger('foo(', ')'), true);
  assert.equal(shouldTrigger('foo(', '  ) {'), false);
  assert.equal(shouldTrigger('let x = ', 'someIdentifier'), false);
});

test('clean: strips markdown fences and cursor markers', () => {
  assert.equal(cleanCompletion('```ts\nreturn 1;\n```', 'function f() {\n  ', '\n}'), 'return 1;');
  assert.equal(cleanCompletion(`foo${CURSOR}bar`, 'x', ''), 'foobar');
});

test('clean: removes text the model echoed from before the cursor', () => {
  assert.equal(cleanCompletion('const total = items.length;', 'const total = ', ''), 'items.length;');
  assert.equal(cleanCompletion('  return x;', '  ', ''), '  return x;', 'whitespace-only prefix lines are not stripped');
  assert.equal(cleanCompletion('  const y = 2;', '  const y = ', ''), '2;');
});

test('clean: removes text that duplicates what follows the cursor', () => {
  assert.equal(cleanCompletion('a, b);', 'foo(', ');'), 'a, b');
  assert.equal(cleanCompletion('x', 'foo(', ');'), 'x');
});

test('clean: caps length, trims trailing whitespace, and drops empty results', () => {
  const long = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n');
  assert.equal(cleanCompletion(long, 'x\n', '').split('\n').length, MAX_COMPLETION_LINES);
  assert.equal(cleanCompletion('value;   \n\n', 'a = ', ''), 'value;');
  assert.equal(cleanCompletion('   \n', 'a', ''), '');
  assert.equal(cleanCompletion('', 'a', ''), '');
});

test('lru: evicts least recently used and refreshes on get', () => {
  const c = new LruCache<number>(2);
  c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 1); assert.equal(c.get('c'), 3);
  assert.equal(c.size, 2);
});

const CFG = { baseUrl: '', apiKey: 'k', model: 'm', temperature: 0.5, allowSelfSigned: true };
const llmReturning = (...outs: string[]) => {
  let i = 0; const seen: any[] = [];
  const fn: LlmFn = async (cfg, msgs, tools) => { seen.push({ cfg, msgs, tools }); return { content: outs[Math.min(i++, outs.length - 1)], toolCalls: [] }; };
  return { fn, seen };
};

test('engine: returns cleaned text, sends no tools, and caches identical requests', async () => {
  const l = llmReturning('```\nitems.length;\n```');
  const e = new CompletionEngine(l.fn, () => CFG);
  const sig = new AbortController().signal;
  assert.equal(await e.complete(req('const n = '), sig), 'items.length;');
  assert.equal(await e.complete(req('const n = '), sig), 'items.length;');
  assert.equal(l.seen.length, 1, 'second call served from cache');
  assert.deepEqual(l.seen[0].tools, []);
  assert.equal(l.seen[0].cfg.temperature, 0.1, 'low temperature for completions');
  await e.complete(req('const m = '), sig);
  assert.equal(l.seen.length, 2);
});

test('engine: never throws — LLM errors, missing config and aborts all yield an empty string', async () => {
  const boom: LlmFn = async () => { throw new Error('down'); };
  assert.equal(await new CompletionEngine(boom, () => CFG).complete(req('a'), new AbortController().signal), '');
  const l = llmReturning('x');
  assert.equal(await new CompletionEngine(l.fn, () => undefined).complete(req('a'), new AbortController().signal), '');
  assert.equal(l.seen.length, 0, 'no config → no request');
  const ac = new AbortController(); ac.abort();
  assert.equal(await new CompletionEngine(l.fn, () => CFG).complete(req('a'), ac.signal), '');
});

test('engine: an aborted request is not cached', async () => {
  const ac = new AbortController();
  const slow: LlmFn = async () => { ac.abort(); return { content: 'stale', toolCalls: [] }; };
  const e = new CompletionEngine(slow, () => CFG);
  await e.complete(req('q = '), ac.signal);
  const l = llmReturning('fresh');
  const e2 = new CompletionEngine(l.fn, () => CFG);
  assert.equal(await e2.complete(req('q = '), new AbortController().signal), 'fresh');
});
