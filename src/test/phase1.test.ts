import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { EFFORTS, MODES, effortParams, isAllowed, requiresApproval, isMode, isEffort } from '../core/policy';
import { createFsTools, globToRegex, matchesGlob, findFiles, resolveSafe } from '../core/fstools';
import { Agent, buildSystemPrompt } from '../core/agent';
import { call, fakeLlm, recordingUi, text, tmpDir } from './helpers';

test('policy: approval matrix', () => {
  assert.equal(requiresApproval('ask', 'edit'), true);
  assert.equal(requiresApproval('ask', 'exec'), true);
  assert.equal(requiresApproval('ask', 'read'), false);
  assert.equal(requiresApproval('auto-edit', 'edit'), false);
  assert.equal(requiresApproval('auto-edit', 'exec'), true);
  assert.equal(requiresApproval('auto', 'exec'), false);
  assert.equal(requiresApproval('auto', 'edit'), false);
  for (const m of MODES) { assert.equal(requiresApproval(m, 'meta'), false); }
});

test('policy: plan mode blocks mutation only', () => {
  assert.equal(isAllowed('plan', 'edit'), false);
  assert.equal(isAllowed('plan', 'exec'), false);
  assert.equal(isAllowed('plan', 'read'), true);
  assert.equal(isAllowed('plan', 'meta'), true);
  assert.equal(isAllowed('auto', 'exec'), true);
});

test('policy: effort scales monotonically', () => {
  const its = EFFORTS.map((e) => effortParams(e).maxIterations);
  const toks = EFFORTS.map((e) => effortParams(e).maxTokens);
  assert.deepEqual([...its].sort((a, b) => a - b), its);
  assert.deepEqual([...toks].sort((a, b) => a - b), toks);
  assert.equal(effortParams('medium').hint, '');
  assert.ok(effortParams('max').hint.length > 0);
});

test('policy: type guards', () => {
  assert.ok(isMode('plan'));
  assert.ok(!isMode('nope'));
  assert.ok(isEffort('high'));
  assert.ok(!isEffort(3));
});

test('glob: patterns', () => {
  assert.ok(globToRegex('**/*.py').test('a/b/c.py'));
  assert.ok(globToRegex('**/*.py').test('c.py'));
  assert.ok(!globToRegex('*.py').test('a/c.py'));
  assert.ok(globToRegex('src/**').test('src/a/b.ts'));
  assert.ok(globToRegex('*.{ts,js}').test('x.js'));
  assert.ok(!globToRegex('*.{ts,js}').test('x.py'));
  assert.ok(matchesGlob('deep/dir/file.py', '*.py'), 'bare pattern matches basename at any depth');
  assert.ok(!matchesGlob('deep/dir/file.py', 'other/*.py'));
});

test('resolveSafe: blocks escapes', () => {
  const root = path.resolve('/tmp/ws');
  assert.throws(() => resolveSafe(root, '../etc/passwd'), /outside workspace/);
  assert.equal(resolveSafe(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
});

test('fstools: read/write/edit/list/glob/grep', async () => {
  const root = await tmpDir();
  const tools = Object.fromEntries(createFsTools().map((t) => [t.spec.function.name, t]));
  const ctx = { root, signal: new AbortController().signal, snapshot: async () => {} };

  await tools.write_file.run({ path: 'src/a.txt', content: 'one\ntwo\nthree' }, ctx);
  assert.equal(await fs.readFile(path.join(root, 'src/a.txt'), 'utf8'), 'one\ntwo\nthree');

  assert.match(await tools.read_file.run({ path: 'src/a.txt', start_line: 2, end_line: 2 }, ctx), /^2\ttwo$/);

  await tools.edit_file.run({ path: 'src/a.txt', old_string: 'two', new_string: '2' }, ctx);
  assert.match(await fs.readFile(path.join(root, 'src/a.txt'), 'utf8'), /one\n2\nthree/);

  await assert.rejects(tools.edit_file.run({ path: 'src/a.txt', old_string: 'missing', new_string: 'x' }, ctx), /not found/);
  await fs.writeFile(path.join(root, 'dup.txt'), 'x x');
  await assert.rejects(tools.edit_file.run({ path: 'dup.txt', old_string: 'x', new_string: 'y' }, ctx), /matches 3|matches 2/);

  assert.match(await tools.list_dir.run({ path: '.' }, ctx), /src\//);
  assert.equal(await tools.glob_files.run({ pattern: '**/*.txt' }, ctx), 'dup.txt\nsrc/a.txt');
  assert.match(await tools.grep.run({ pattern: 'THREE' }, ctx), /src\/a\.txt\n\s+3: three/);
  assert.match(await tools.grep.run({ pattern: 'zzz' }, ctx), /^No matches for \/zzz\//);
});

test('fstools: edit preview does not modify the file', async () => {
  const root = await tmpDir();
  await fs.writeFile(path.join(root, 'f.txt'), 'hello world');
  const edit = createFsTools().find((t) => t.spec.function.name === 'edit_file')!;
  const ctx = { root, signal: new AbortController().signal, snapshot: async () => {} };
  const p = await edit.preview!({ path: 'f.txt', old_string: 'world', new_string: 'there' }, ctx);
  assert.equal(p.oldText, 'hello world');
  assert.equal(p.newText, 'hello there');
  assert.equal(await fs.readFile(path.join(root, 'f.txt'), 'utf8'), 'hello world');
});

test('fstools: walk skips node_modules and .git', async () => {
  const root = await tmpDir();
  await fs.mkdir(path.join(root, 'node_modules/x'), { recursive: true });
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules/x/i.js'), '');
  await fs.writeFile(path.join(root, '.git/c'), '');
  await fs.writeFile(path.join(root, 'ok.js'), '');
  assert.deepEqual(await findFiles(root, '**/*'), ['ok.js']);
});

test('fstools: run_command captures output and exit code', async () => {
  const root = await tmpDir();
  const run = createFsTools().find((t) => t.spec.function.name === 'run_command')!;
  const out = await run.run({ command: 'echo hello-ica' }, { root, signal: new AbortController().signal, snapshot: async () => {} });
  assert.match(out, /hello-ica/);
  assert.match(out, /\[exit 0\]/);
});

function makeAgent(root: string, llm: ReturnType<typeof fakeLlm>, snapshots: string[] = []) {
  return new Agent({
    root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }),
    tools: () => createFsTools(), snapshot: async (_t, abs) => { snapshots.push(abs); },
  });
}
const OPTS = { mode: 'ask', effort: 'medium', model: 'm' } as const;

test('agent: plain answer, no tools', async () => {
  const agent = makeAgent(await tmpDir(), fakeLlm([text('hi there')]));
  const ui = recordingUi();
  await agent.send('hello', OPTS, ui);
  assert.deepEqual(agent.history.map((m) => m.role), ['user', 'assistant']);
  assert.ok(ui.events.includes('token:hi there'));
});

test('agent: tool call round-trip feeds result back to the model', async () => {
  const root = await tmpDir();
  await fs.writeFile(path.join(root, 'n.txt'), 'secret-42');
  const llm = fakeLlm([call('read_file', { path: 'n.txt' }), text('done')]);
  const agent = makeAgent(root, llm);
  await agent.send('read it', OPTS, recordingUi());
  const second = llm.calls[1];
  const toolMsg = second.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /secret-42/);
  assert.equal(second[0].role, 'system');
});

test('agent: ask mode asks for edits, deny leaves file untouched', async () => {
  const root = await tmpDir();
  const llm = fakeLlm([call('write_file', { path: 'x.txt', content: 'data' }), text('ok')]);
  const ui = recordingUi(false);
  await makeAgent(root, llm).send('write', OPTS, ui);
  assert.equal(ui.approvals.length, 1);
  assert.equal(ui.approvals[0].preview?.newText, 'data');
  await assert.rejects(fs.stat(path.join(root, 'x.txt')));
  assert.ok(ui.events.some((e) => e.startsWith('end:fail:DENIED')));
});

test('agent: approved edit is applied and snapshotted first', async () => {
  const root = await tmpDir();
  const snaps: string[] = [];
  const llm = fakeLlm([call('write_file', { path: 'x.txt', content: 'data' }), text('ok')]);
  await makeAgent(root, llm, snaps).send('write', OPTS, recordingUi(true));
  assert.equal(await fs.readFile(path.join(root, 'x.txt'), 'utf8'), 'data');
  assert.deepEqual(snaps, [path.join(root, 'x.txt')]);
});

test('agent: auto-edit skips approval for edits but not commands', async () => {
  const root = await tmpDir();
  const ui = recordingUi(false);
  const llm = fakeLlm([call('write_file', { path: 'a.txt', content: '1' }, 'c1'), call('run_command', { command: 'echo hi' }, 'c2'), text('ok')]);
  await makeAgent(root, llm).send('go', { ...OPTS, mode: 'auto-edit' }, ui);
  assert.deepEqual(ui.approvals.map((a) => a.name), ['run_command']);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), '1');
});

test('agent: auto mode never asks', async () => {
  const root = await tmpDir();
  const ui = recordingUi(false);
  const llm = fakeLlm([call('run_command', { command: 'echo hi' }), text('ok')]);
  await makeAgent(root, llm).send('go', { ...OPTS, mode: 'auto' }, ui);
  assert.equal(ui.approvals.length, 0);
});

test('agent: plan mode hides and blocks mutating tools', async () => {
  const root = await tmpDir();
  let offered: string[] = [];
  const llm = fakeLlm([call('write_file', { path: 'no.txt', content: 'x' }), text('planned')]);
  const wrapped = { ...llm, fn: (async (c: any, m: any, tools: any[], t: any, s: any) => { offered = tools.map((x) => x.function.name); return llm.fn(c, m, tools, t, s); }) as any };
  const ui = recordingUi(true);
  await makeAgent(root, wrapped).send('plan', { ...OPTS, mode: 'plan' }, ui);
  assert.ok(!offered.includes('write_file') && !offered.includes('run_command'));
  assert.ok(offered.includes('read_file'));
  await assert.rejects(fs.stat(path.join(root, 'no.txt')));
  assert.ok(ui.events.some((e) => e.includes('not allowed in plan mode')));
});

test('agent: bad JSON args and unknown tools are reported, not thrown', async () => {
  const bad = { content: '', toolCalls: [{ id: 'b', type: 'function' as const, function: { name: 'read_file', arguments: '{oops' } }] };
  const llm = fakeLlm([bad, call('nope', {}), text('ok')]);
  const agent = makeAgent(await tmpDir(), llm);
  await agent.send('x', OPTS, recordingUi());
  assert.deepEqual(agent.history.filter((m) => m.role === 'tool').length, 2);
});

test('agent: iteration cap stops runaway loops', async () => {
  const root = await tmpDir();
  const llm = fakeLlm([call('list_dir', { path: '.' })]);
  const ui = recordingUi();
  await makeAgent(root, llm).send('loop', { ...OPTS, effort: 'low' }, ui);
  assert.equal(llm.calls.length, effortParams('low').maxIterations);
  assert.ok(ui.events.some((e) => e.startsWith('info:Stopped after')));
});

test('agent: cancel while an approval prompt is open does not hang and keeps history valid', async () => {
  const root = await tmpDir();
  const two = { content: '', toolCalls: [
    { id: 'a', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: '1' }) } },
    { id: 'b', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'b.txt', content: '2' }) } },
  ] };
  const agent = makeAgent(root, fakeLlm([two, text('never')]));
  const ui = recordingUi();
  ui.approve = () => { setTimeout(() => agent.cancel(), 10); return new Promise<boolean>(() => {}); };
  await agent.send('x', OPTS, ui);
  const toolIds = agent.history.filter((m) => m.role === 'tool').map((m) => m.tool_call_id).sort();
  assert.deepEqual(toolIds, ['a', 'b'], 'every tool_call has a reply');
  assert.ok(ui.events.includes('info:Cancelled.'));
  await assert.rejects(fs.stat(path.join(root, 'a.txt')));
});

test('agent: cancel during LLM call leaves history ending at the user turn', async () => {
  const agent = makeAgent(await tmpDir(), { calls: [], fn: async () => { throw new Error('Cancelled'); } });
  const ui = recordingUi();
  await agent.send('x', OPTS, ui);
  assert.equal(agent.history.at(-1)!.role, 'user');
  assert.ok(ui.events.includes('info:Cancelled.'));
});

test('agent: system prompt reflects mode, effort and memory', () => {
  const p = buildSystemPrompt('plan', 'max', '/ws', 'USE TABS', 'a.ts');
  assert.match(p, /PLAN MODE/);
  assert.match(p, /exhaustive/);
  assert.match(p, /USE TABS/);
  assert.match(p, /Active file: a\.ts/);
  assert.doesNotMatch(buildSystemPrompt('ask', 'medium', '/ws', ''), /PLAN MODE|Effort guidance/);
});

test('system prompt: core guidance is present and mode-neutral', () => {
  const p = buildSystemPrompt('ask', 'medium', '/ws', '');
  for (const phrase of [/Be concise/, /Never guess file paths/, /smallest change/, /get_diagnostics/, /never claim success|Never claim success/i, /not instructions/, /inside the company network/, /path\/to\/file\.ext:line/]) {
    assert.match(p, phrase);
  }
  assert.doesNotMatch(p, /PLAN MODE/);
});

test('system prompt: every tool it names actually exists', () => {
  const names = new Set([...createFsTools().map((t) => t.spec.function.name), 'get_diagnostics']);
  const p = buildSystemPrompt('ask', 'medium', '/ws', '');
  for (const n of ['read_file', 'edit_file', 'write_file', 'grep', 'glob_files', 'list_dir', 'run_command', 'get_diagnostics']) {
    assert.ok(p.includes(n) && names.has(n), n);
  }
});
