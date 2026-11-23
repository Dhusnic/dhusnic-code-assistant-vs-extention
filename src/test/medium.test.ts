import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Agent, CheckCommand, narrowCheck, relatedTestsFor, scopeChecks } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { SUMMARY_SYSTEM } from '../core/compaction';
import { expandMentions } from '../core/mentions';
import { detectVerifyCommands } from '../core/verify';
import { Tool, fnSpec } from '../core/tool';
import { call, fakeLlm, recordingUi, text, tmpDir } from './helpers';

const AUTO = { mode: 'auto', effort: 'medium', model: 'm' } as const;
const CFG = () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: false });

/* ------------------------------------------------------------------ flaw 7: checks scoped to the change */

const JEST: CheckCommand = { name: 'test', command: 'npm run test', timeoutSeconds: 600, related: relatedTestsFor('npm run test', 'jest') };
const LINT: CheckCommand = { name: 'lint', command: 'npm run lint', timeoutSeconds: 300 };
const GO: CheckCommand = { name: 'test', command: 'go test ./...', timeoutSeconds: 600, related: relatedTestsFor('go test ./...') };

test('scopeChecks: documentation-only changes need no checks', () => {
  assert.deepEqual(scopeChecks([LINT, JEST], ['README.md', 'docs/guide.mdx', 'img/logo.png', 'LICENSE']), []);
  assert.deepEqual(scopeChecks([LINT, JEST], ['src/a.ts', 'README.md']), [LINT, JEST]);
});

test('narrowCheck: a few code files use the related form; checks without one have none', () => {
  assert.equal(narrowCheck(JEST, ['src/a.ts', 'src/b.ts', 'README.md'])?.command, 'npx jest --findRelatedTests "src/a.ts" "src/b.ts" --passWithNoTests');
  assert.equal(narrowCheck(LINT, ['src/a.ts']), undefined);
});

test('narrowCheck: many files, or files outside the workspace, run the full command', () => {
  const many = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
  assert.equal(narrowCheck(JEST, many), undefined);
  assert.equal(narrowCheck(JEST, ['src/a.ts', 'D:/other/b.ts']), undefined);
});

test('narrowCheck: Go runs the changed packages; any other code file means the full command', () => {
  assert.equal(narrowCheck(GO, ['pkg/api/h.go', 'pkg/api/h_test.go', 'main.go'])?.command, 'go test ./pkg/api .');
  assert.equal(narrowCheck(GO, ['go.mod']), undefined);
  assert.equal(narrowCheck(GO, ['pkg/api/h.go', 'go.mod']), undefined);
});

test('detectVerifyCommands: jest and vitest projects get a related form', async () => {
  const jest = await tmpDir();
  await fs.writeFile(path.join(jest, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
  assert.equal((await detectVerifyCommands(jest)).find((c) => c.name === 'test')?.related?.template, 'npx jest --findRelatedTests {files} --passWithNoTests');
  const vitest = await tmpDir();
  await fs.writeFile(path.join(vitest, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  await fs.writeFile(path.join(vitest, 'pnpm-lock.yaml'), '');
  assert.equal((await detectVerifyCommands(vitest)).find((c) => c.name === 'test')?.related?.template, 'pnpm exec vitest related {files} --run --passWithNoTests');
  const plain = await tmpDir();
  await fs.writeFile(path.join(plain, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.equal((await detectVerifyCommands(plain)).find((c) => c.name === 'test')?.related, undefined, 'node --test without patterns is not narrowed');
});

function gate(steps: any[], checks: CheckCommand[]) {
  const ran: string[] = [];
  const edit: Tool = { kind: 'edit', spec: fnSpec('edit_file', '', {}, []), describe: () => 'Edit', run: async () => 'Edited' };
  const run: Tool = { kind: 'exec', spec: fnSpec('run_command', '', {}, []), describe: () => 'Run', run: async (a) => { ran.push(a.command); return 'ok\n[exit 0]'; } };
  const agent = new Agent({ root: path.resolve('/w'), llm: fakeLlm(steps).fn, getConfig: CFG, tools: () => [edit, run], checks: () => checks });
  return { agent, ran, ui: recordingUi(true) };
}

test('gate: a README edit skips the checks and says so', async () => {
  const { agent, ran, ui } = gate([call('edit_file', { path: 'README.md' }), text('done')], [LINT, JEST]);
  await agent.send('docs', AUTO, ui);
  assert.deepEqual(ran, []);
  assert.ok(ui.events.includes('info:Only documentation changed: project checks skipped.'));
  assert.ok(ui.events.some((e) => /Changed 1 file \(documentation only; no checks needed\)/.test(e)));
});

test('gate: the first check of a code edit runs the full commands', async () => {
  const { agent, ran, ui } = gate([call('edit_file', { path: 'src/a.ts' }), text('done')], [LINT, JEST]);
  await agent.send('x', AUTO, ui);
  assert.deepEqual(ran, ['npm run lint', 'npm run test']);
});

test('gate: the model running the full suite itself counts, related form or not', async () => {
  const { agent, ran, ui } = gate([call('edit_file', { path: 'src/a.ts' }, 'e'), call('run_command', { command: 'npm run lint' }, 'l'), call('run_command', { command: 'npm run test' }, 't'), text('done')], [LINT, JEST]);
  await agent.send('x', AUTO, ui);
  assert.deepEqual(ran, ['npm run lint', 'npm run test']);
});

/* ------------------------------------------------------------------ flaw 8: stable system prompt */

test('the active file goes with the user message, so the system prompt never changes between tabs', async () => {
  let active = 'src/a.ts';
  const llm = fakeLlm([text('one'), text('two')]);
  const agent = new Agent({ root: '/w', llm: llm.fn, getConfig: CFG, tools: () => [], activeFile: () => active });
  await agent.send('first', AUTO, recordingUi(true));
  active = 'src/b.ts';
  await agent.send('second', AUTO, recordingUi(true));
  assert.equal(llm.calls[0][0].content, llm.calls[1][0].content, 'identical system prompts');
  assert.doesNotMatch(llm.calls[0][0].content, /Active/);
  assert.match(llm.calls[1].at(-1).content, /second\n\n\(Active editor file: src\/b\.ts\)/);
  assert.equal(agent.history.find((m) => m.role === 'user')!.display, 'first', 'the UI shows what the user typed');
});

/* ------------------------------------------------------------------ flaw 5: tool calls written as text */

test('tool calls written as text are run, and the user is told once', async () => {
  const root = await tmpDir();
  await fs.writeFile(path.join(root, 'a.txt'), 'hello');
  const llm = fakeLlm([
    text('Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n</tool_call>'),
    text('<tool_call>\n<function=read_file>\n<parameter=path>\na.txt\n</parameter>\n</function>\n</tool_call>'),
    text('It says hello.'),
  ]);
  const agent = new Agent({ root, llm: llm.fn, getConfig: CFG, tools: () => createFsTools() });
  const ui = recordingUi(true);
  await agent.send('what is in a.txt?', AUTO, ui);
  const tools = agent.history.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 2);
  assert.match(String(tools[0].content), /1\thello/);
  assert.equal(agent.history.find((m) => m.tool_calls)!.content, 'Let me look.');
  assert.equal(ui.events.filter((e) => /wrote its tool calls as text/.test(e)).length, 1);
  assert.equal(agent.history.at(-1)!.content, 'It says hello.');
});

/* ------------------------------------------------------------------ flaw 6: too long for the model */

test('a "too long" error teaches the real limit, compacts and retries', async () => {
  let calls = 0;
  const seen: number[] = [];
  const agent = new Agent({
    root: '/w', getConfig: CFG, tools: () => [], contextLimit: () => 262144,
    llm: async (cfg, msgs) => {
      if (msgs[0].content === SUMMARY_SYSTEM) { return text('summary'); }
      calls++;
      seen.push(cfg.maxTokens ?? 0);
      if (calls === 1) { throw new Error("LLM HTTP 400: This model's maximum context length is 32768 tokens. However, you requested 40000 tokens."); }
      return text('fine');
    },
  });
  const ui = recordingUi(true);
  await agent.send('hi', AUTO, ui);
  assert.equal(agent.history.at(-1)!.content, 'fine');
  assert.equal(agent.contextUsage().limit, 32768);
  assert.ok(seen[1] <= 8192);
  assert.ok(ui.events.some((e) => /too long for the model \(its limit is 32768 tokens\); compacting/.test(e)));
});

test('other LLM errors are not retried as "too long"', async () => {
  const agent = new Agent({ root: '/w', getConfig: CFG, tools: () => [], llm: async () => { throw new Error('LLM HTTP 401: bad key'); } });
  await assert.rejects(agent.send('hi', AUTO, recordingUi(true)), /401/);
});

/* ------------------------------------------------------------------ flaw 9: @file attachments count as read */

test('expandMentions: files attached in full are reported as read; ranges and truncated files are not', async () => {
  const root = await tmpDir();
  await fs.writeFile(path.join(root, 'a.ts'), 'a\nb\nc\n');
  await fs.writeFile(path.join(root, 'b.ts'), 'x\ny\n');
  const exp = await expandMentions('look at @a.ts and @b.ts:1-1', root);
  assert.deepEqual(exp.read, [path.join(root, 'a.ts')]);
  assert.deepEqual(exp.files.sort(), ['a.ts', 'b.ts']);
});

test('an attached file can be edited without reading it again', async () => {
  const root = await tmpDir();
  await fs.writeFile(path.join(root, 'a.ts'), 'let x = 1;\n');
  const llm = fakeLlm([call('edit_file', { path: 'a.ts', old_string: 'x = 1', new_string: 'x = 2' }), text('done')]);
  const agent = new Agent({ root, llm: llm.fn, getConfig: CFG, tools: () => createFsTools() });
  const exp = await expandMentions('fix @a.ts', root);
  for (const abs of exp.read) { await agent.reads.markRead(abs); }
  await agent.send(exp.text, AUTO, recordingUi(true));
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'let x = 2;\n');
});
