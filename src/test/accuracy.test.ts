import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Agent, CheckCommand, MAX_CHECK_ROUNDS, buildSystemPrompt, checksPromptSection, exitCodeOf } from '../core/agent';
import { FileReadTracker, applyEdit, clipOutput, commandTimeoutMs, createFsTools, decodeText, encodeText } from '../core/fstools';
import { effortParams } from '../core/policy';
import { fixPrompt, parseSlash } from '../core/slash';
import { Tool, ToolCtx, fnSpec } from '../core/tool';
import { call, fakeLlm, recordingUi, text, tmpDir } from './helpers';

const ctxFor = (root: string): ToolCtx => ({ root, signal: new AbortController().signal, snapshot: async () => undefined });
const tool = (name: string): Tool => createFsTools().find((t) => t.spec.function.name === name)!;

/* ------------------------------------------------------------------ clipOutput */

test('clipOutput: short output is unchanged', () => {
  assert.equal(clipOutput('hello\nworld', 100), 'hello\nworld');
});

test('clipOutput: keeps the start, the end (test summary) and error lines from the middle', () => {
  const lines = ['START of run'];
  for (let i = 0; i < 2000; i++) { lines.push(i === 1000 ? 'Error: expected 2 but got 3 at sum.test.js:12' : `ok ${i} - passing test with some padding text`); }
  lines.push('# tests 2000', '# fail 1', 'END');
  const out = clipOutput(lines.join('\n'), 4000);
  assert.ok(out.length < 4600, `too long: ${out.length}`);
  assert.match(out, /^START of run/);
  assert.match(out, /# fail 1\nEND$/);
  assert.match(out, /Error: expected 2 but got 3/);
  assert.match(out, /chars omitted; error-looking lines/);
});

test('clipOutput: without error lines it just marks the omitted middle', () => {
  const out = clipOutput(`${'a\n'.repeat(5000)}LAST`, 1000);
  assert.match(out, /\[\d+ chars omitted\]/);
  assert.match(out, /LAST$/);
});

test('commandTimeoutMs: default 120s, capped at 600s, ignores junk', () => {
  assert.equal(commandTimeoutMs(undefined), 120000);
  assert.equal(commandTimeoutMs('abc'), 120000);
  assert.equal(commandTimeoutMs(300), 300000);
  assert.equal(commandTimeoutMs(5000), 600000);
});

test('run_command: the exit line stays last even when output is clipped', async () => {
  const root = await tmpDir();
  const cmd = process.platform === 'win32' ? '1..3000 | ForEach-Object { "line $_ padding padding padding" }' : 'for i in $(seq 1 3000); do echo "line $i padding padding padding"; done';
  const out = await tool('run_command').run({ command: cmd }, ctxFor(root));
  assert.match(out, /line 3000 padding padding padding\s*\n\[exit 0\]$/);
  assert.equal(exitCodeOf(out), 0);
});

/* ------------------------------------------------------------------ edits */

test('decode/encodeText round-trips BOM and CRLF', () => {
  const raw = '﻿a\r\nb\r\n';
  const { text: t, format } = decodeText(raw);
  assert.equal(t, 'a\nb\n');
  assert.deepEqual(format, { bom: true, crlf: true });
  assert.equal(encodeText(t, format), raw);
  assert.deepEqual(decodeText('a\nb\n').format, { bom: false, crlf: false });
});

test('applyEdit: LF old_string matches; trailing spaces in the file are tolerated', () => {
  assert.equal(applyEdit('one\ntwo  \nthree\n', { old_string: 'two\nthree', new_string: 'TWO\nTHREE' }), 'one\nTWO\nTHREE\n');
});

test('applyEdit: ambiguous match asks for more context; replace_all changes every one', () => {
  assert.throws(() => applyEdit('x=1\nx=1\n', { old_string: 'x=1', new_string: 'x=2' }), /matches 2 places.*replace_all/);
  assert.equal(applyEdit('x=1\nx=1\n', { old_string: 'x=1', new_string: 'x=2', replace_all: true }), 'x=2\nx=2\n');
});

test('applyEdit: not found shows the closest lines with line numbers', () => {
  const file = 'function add(a, b) {\n  return a + b;\n}\n';
  assert.throws(() => applyEdit(file, { old_string: 'function add(a,b) {\n  return a - b;', new_string: 'x' }), (e: Error) => {
    assert.match(e.message, /not found/);
    assert.match(e.message, /near line 1/);
    assert.match(e.message, /1\tfunction add\(a, b\) \{/);
    return true;
  });
});

test('applyEdit: identical old and new is rejected', () => {
  assert.throws(() => applyEdit('a', { old_string: 'a', new_string: 'a' }), /identical/);
});

test('edit_file: works on a CRLF file with an LF old_string and keeps CRLF + BOM', async () => {
  const root = await tmpDir();
  const f = path.join(root, 'a.cs');
  await fs.writeFile(f, '﻿class A {\r\n  int x = 1;\r\n}\r\n');
  const res = await tool('edit_file').run({ path: 'a.cs', old_string: 'class A {\n  int x = 1;', new_string: 'class A {\n  int x = 2;' }, ctxFor(root));
  assert.equal(res, 'Edited a.cs');
  assert.equal(await fs.readFile(f, 'utf8'), '﻿class A {\r\n  int x = 2;\r\n}\r\n');
});

test('write_file: overwriting a CRLF file keeps CRLF; a new file is written as given', async () => {
  const root = await tmpDir();
  await fs.writeFile(path.join(root, 'old.txt'), 'a\r\nb\r\n');
  await tool('write_file').run({ path: 'old.txt', content: 'x\ny\n' }, ctxFor(root));
  assert.equal(await fs.readFile(path.join(root, 'old.txt'), 'utf8'), 'x\r\ny\r\n');
  await tool('write_file').run({ path: 'new.txt', content: 'x\ny\n' }, ctxFor(root));
  assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'x\ny\n');
});

test('multi_edit: applies edits in order, and applies none when one fails', async () => {
  const root = await tmpDir();
  const f = path.join(root, 'm.py');
  await fs.writeFile(f, 'a = 1\nb = 2\nc = 3\n');
  const t = tool('multi_edit');
  assert.equal(await t.run({ path: 'm.py', edits: [{ old_string: 'a = 1', new_string: 'a = 10' }, { old_string: 'a = 10\nb = 2', new_string: 'a = 10\nb = 20' }] }, ctxFor(root)), 'Edited m.py (2 changes)');
  assert.equal(await fs.readFile(f, 'utf8'), 'a = 10\nb = 20\nc = 3\n');
  await assert.rejects(t.run({ path: 'm.py', edits: [{ old_string: 'c = 3', new_string: 'c = 30' }, { old_string: 'zzz', new_string: 'y' }] }, ctxFor(root)), /edits\[1\]\.old_string not found/);
  assert.equal(await fs.readFile(f, 'utf8'), 'a = 10\nb = 20\nc = 3\n');
  await assert.rejects(t.run({ path: 'm.py', edits: [] }, ctxFor(root)), /non-empty array/);
});

/* ------------------------------------------------------------------ check gate */

const CHECKS: CheckCommand[] = [{ name: 'lint', command: 'lint-cmd', timeoutSeconds: 300 }, { name: 'test', command: 'test-cmd', timeoutSeconds: 600 }];

/** An agent with a fake edit tool and a fake run_command whose exit codes come from `exits` (per command, in call order). */
function gateSetup(steps: any[], exits: Record<string, number[]>, opts: { checks?: CheckCommand[]; subagent?: boolean } = {}) {
  const ran: Array<{ command: string; timeout: number }> = [];
  const edit: Tool = { kind: 'edit', spec: fnSpec('edit_file', '', {}, []), describe: () => 'Edit', run: async () => 'Edited a.ts' };
  const read: Tool = { kind: 'read', spec: fnSpec('read_file', '', {}, []), describe: () => 'Read', run: async () => 'content' };
  const run: Tool = {
    kind: 'exec', spec: fnSpec('run_command', '', {}, []), describe: (a) => `Run: ${a.command}`,
    run: async (a) => {
      ran.push({ command: a.command, timeout: a.timeout_seconds });
      const code = exits[a.command]?.shift() ?? 0;
      // Each failure differs (the run number), so a fix attempt counts as progress; checkFeedback.test.ts covers the opposite.
      return `output of ${a.command}${code ? `\nError: something broke (run ${ran.length})` : ''}\n[exit ${code}]`;
    },
  };
  const llm = fakeLlm(steps);
  const agent = new Agent({
    root: '/w', llm: llm.fn, subagent: opts.subagent,
    getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: false }),
    tools: () => [edit, read, run],
    checks: () => opts.checks ?? CHECKS,
  });
  return { agent, ran, llm, ui: recordingUi(true) };
}
const AUTO = { mode: 'auto', effort: 'medium', model: 'm' } as const;

test('checks: run in order after an edit and pass quietly', async () => {
  const { agent, ran, ui } = gateSetup([call('edit_file', {}), text('done')], {});
  await agent.send('fix it', AUTO, ui);
  assert.deepEqual(ran, [{ command: 'lint-cmd', timeout: 300 }, { command: 'test-cmd', timeout: 600 }]);
  assert.ok(ui.events.includes('info:Project checks passed: lint, test.'));
});

test('checks: do not run when nothing was edited', async () => {
  const { agent, ran, ui } = gateSetup([call('read_file', {}), text('answer')], {});
  await agent.send('explain', AUTO, ui);
  assert.equal(ran.length, 0);
});

test('checks: a failure goes back to the model, which fixes it; checks run again and pass', async () => {
  const { agent, ran, llm, ui } = gateSetup([call('edit_file', {}, 'e1'), text('done'), call('edit_file', {}, 'e2'), text('fixed')], { 'test-cmd': [1, 0] });
  await agent.send('fix it', AUTO, ui);
  assert.deepEqual(ran.map((r) => r.command), ['lint-cmd', 'test-cmd', 'lint-cmd', 'test-cmd']);
  const feedback = llm.calls[2].find((m: any) => m.role === 'user' && /project checks failed/.test(m.content));
  assert.ok(feedback, 'failure was sent to the model');
  assert.match(feedback.content, /### test: `test-cmd`/);
  assert.match(feedback.content, /Error: something broke/);
  assert.ok(ui.events.includes('info:Project checks passed: lint, test.'));
});

test('checks: stop at the first failing check', async () => {
  const { agent, ran, ui } = gateSetup([call('edit_file', {}), text('done'), text('cannot fix'), text('still no'), text('x')], { 'lint-cmd': [1, 1, 1] });
  await agent.send('fix it', AUTO, ui);
  assert.ok(!ran.some((r) => r.command === 'test-cmd'));
});

test(`checks: give up after ${MAX_CHECK_ROUNDS} fix rounds and tell the user`, async () => {
  const steps = [call('edit_file', {}, 'e1'), text('done')];
  for (let i = 0; i < MAX_CHECK_ROUNDS; i++) { steps.push(call('edit_file', {}, `f${i}`), text('try again')); }
  const { agent, ran, ui } = gateSetup(steps, { 'lint-cmd': Array(10).fill(1) });
  await agent.send('fix it', AUTO, ui);
  assert.equal(ran.length, MAX_CHECK_ROUNDS + 1);
  assert.ok(ui.events.some((e) => /still failing .*after 2 fix attempts/.test(e)));
});

test('checks: if the model stops editing after a failure, checks do not loop', async () => {
  const { agent, ran, ui } = gateSetup([call('edit_file', {}), text('done'), text('this failure was already there before my change')], { 'test-cmd': [1] });
  await agent.send('fix it', AUTO, ui);
  assert.equal(ran.length, 2);
});

test('checks: in ask mode they need approval; declining skips them', async () => {
  const { agent, ran } = gateSetup([call('edit_file', {}), text('done')], {});
  const ui = recordingUi((r) => r.name !== 'run_command');
  await agent.send('fix it', { ...AUTO, mode: 'ask' }, ui);
  assert.equal(ran.length, 0);
  assert.ok(ui.approvals.some((r) => r.name === 'run_command' && /lint-cmd/.test(r.detail)));
  assert.ok(ui.events.some((e) => /Project checks skipped/.test(e)));
});

test('checks: skipped for sub-agents and in plan mode', async () => {
  const sub = gateSetup([call('edit_file', {}), text('done')], {}, { subagent: true });
  await sub.agent.send('x', AUTO, sub.ui);
  assert.equal(sub.ran.length, 0);
  const plan = gateSetup([call('read_file', {}), text('plan')], {});
  await plan.agent.send('x', { ...AUTO, mode: 'plan' }, plan.ui);
  assert.equal(plan.ran.length, 0);
});

test('checks: listed in the system prompt so the model can run them itself', async () => {
  const { agent, llm, ui } = gateSetup([text('hi')], {});
  await agent.send('hello', AUTO, ui);
  assert.match(llm.calls[0][0].content, /# Project checks[\s\S]*- lint: `lint-cmd`[\s\S]*- test: `test-cmd`/);
  assert.equal(checksPromptSection([]), '');
  assert.doesNotMatch(buildSystemPrompt('auto', 'medium', '/w', ''), /Project checks/);
});

test('checks: a broken checks provider never breaks the turn', async () => {
  const llm = fakeLlm([text('ok')]);
  const agent = new Agent({ root: '/w', llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: false }), tools: () => [], checks: () => { throw new Error('boom'); } });
  await agent.send('hi', AUTO, recordingUi(true));
  assert.equal(agent.history[agent.history.length - 1].content, 'ok');
});

test('exitCodeOf reads the last [exit N] line only', () => {
  assert.equal(exitCodeOf('x\n[exit 0]'), 0);
  assert.equal(exitCodeOf('x\n[exit 2]\n'), 2);
  assert.equal(exitCodeOf('[stopped]\n[exit null]'), undefined);
  assert.equal(exitCodeOf('ERROR: spawn failed'), undefined);
});

/* ------------------------------------------------------------------ read-before-edit (feature 6) */

const trackedCtx = (root: string): ToolCtx => ({ ...ctxFor(root), reads: new FileReadTracker() });

test('read-before-edit: an unread file cannot be edited; after reading it can', async () => {
  const root = await tmpDir();
  await fs.writeFile(path.join(root, 'a.ts'), 'let x = 1;\n');
  const ctx = trackedCtx(root);
  await assert.rejects(tool('edit_file').run({ path: 'a.ts', old_string: 'x = 1', new_string: 'x = 2' }, ctx), /have not read a\.ts/);
  await tool('read_file').run({ path: 'a.ts' }, ctx);
  assert.equal(await tool('edit_file').run({ path: 'a.ts', old_string: 'x = 1', new_string: 'x = 2' }, ctx), 'Edited a.ts');
  // The agent's own edit counts as read: a second edit needs no re-read.
  assert.equal(await tool('edit_file').run({ path: 'a.ts', old_string: 'x = 2', new_string: 'x = 3' }, ctx), 'Edited a.ts');
});

test('read-before-edit: a file changed on disk after reading must be read again', async () => {
  const root = await tmpDir();
  const f = path.join(root, 'a.ts');
  await fs.writeFile(f, 'let x = 1;\n');
  const ctx = trackedCtx(root);
  await tool('read_file').run({ path: 'a.ts' }, ctx);
  await fs.writeFile(f, 'let x = 1; // changed by the user\n');
  await fs.utimes(f, new Date(), new Date(Date.now() + 5000));
  await assert.rejects(tool('multi_edit').run({ path: 'a.ts', edits: [{ old_string: 'x = 1', new_string: 'x = 2' }] }, ctx), /changed on disk since you last read it/);
  await tool('read_file').run({ path: 'a.ts' }, ctx);
  assert.match(await tool('multi_edit').run({ path: 'a.ts', edits: [{ old_string: 'x = 1', new_string: 'x = 2' }] }, ctx), /Edited/);
});

test('read-before-edit: new files can be written freely; overwriting an unread file is refused', async () => {
  const root = await tmpDir();
  const ctx = trackedCtx(root);
  assert.equal(await tool('write_file').run({ path: 'new.ts', content: 'a' }, ctx), 'Wrote new.ts');
  await fs.writeFile(path.join(root, 'old.ts'), 'b');
  await assert.rejects(tool('write_file').run({ path: 'old.ts', content: 'c' }, ctx), /have not read old\.ts/);
  await assert.rejects(tool('write_file').preview!({ path: 'old.ts', content: 'c' }, ctx), /have not read/);
});

test('read-before-edit: the agent passes its own tracker to tools, and a reset forgets reads', async () => {
  const root = await tmpDir();
  await fs.writeFile(path.join(root, 'a.ts'), 'x');
  const llm = fakeLlm([call('read_file', { path: 'a.ts' }), text('read it')]);
  const agent = new Agent({ root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: false }), tools: () => createFsTools() });
  await agent.send('read', AUTO, recordingUi(true));
  assert.equal(await agent.reads.check(path.join(root, 'a.ts'), 'a.ts'), undefined);
  agent.reset();
  assert.match(String(await agent.reads.check(path.join(root, 'a.ts'), 'a.ts')), /have not read/);
});

/* ------------------------------------------------------------------ limits and cut-off replies (feature 8) */

test('limits: effort levels allow real fix-and-test loops', () => {
  assert.equal(effortParams('medium').maxIterations, 50);
  assert.equal(effortParams('medium').maxTokens, 8192);
  assert.ok(effortParams('low').maxIterations >= 15);
  assert.ok(effortParams('high').maxTokens >= 16384);
});

test('limits: the user settings override the effort level', async () => {
  const llm = fakeLlm([call('read_file', {}, 'r1'), call('read_file', {}, 'r2'), call('read_file', {}, 'r3'), text('never')]);
  const read: Tool = { kind: 'read', spec: fnSpec('read_file', '', {}, []), describe: () => 'Read', run: async () => 'c' };
  const seen: number[] = [];
  const agent = new Agent({
    root: '/w', llm: async (cfg, m, t, on, s) => { seen.push(cfg.maxTokens ?? 0); return llm.fn(cfg, m, t, on, s); },
    getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: false }),
    tools: () => [read], limits: () => ({ maxIterations: 2, maxTokens: 1234 }),
  });
  const ui = recordingUi(true);
  await agent.send('go', AUTO, ui);
  assert.deepEqual(seen, [1234, 1234]);
  assert.ok(ui.events.some((e) => /Stopped after 2 tool rounds\. Send "continue"/.test(e)));
});

test('cut-off: a tool call cut off at the output limit is not run; the model is asked to split it up', async () => {
  const cut = { content: '', finishReason: 'length', toolCalls: [{ id: 'w1', type: 'function' as const, function: { name: 'edit_file', arguments: '{"path":"a.ts","old_str' } }] };
  const { agent, ran, llm, ui } = gateSetup([cut, call('edit_file', {}), text('done')], {}, { checks: [] });
  await agent.send('write a big file', AUTO, ui);
  assert.equal(ran.length, 0);
  assert.ok(!agent.history.some((m) => m.tool_calls?.some((t) => t.id === 'w1')), 'the broken call is not kept in history');
  const nudge = llm.calls[1].find((m: any) => m.role === 'user' && /cut off at the output limit/.test(m.content));
  assert.match(nudge.content, /smaller pieces/);
  assert.ok(ui.events.some((e) => /cut off .* tool call/.test(e)));
});

test('cut-off: cut-off text is continued; recoveries are capped', async () => {
  const cutText = { content: 'part', toolCalls: [], finishReason: 'length' };
  const { agent, llm, ui } = gateSetup([cutText, cutText, cutText, cutText, cutText], {}, { checks: [] });
  await agent.send('explain', AUTO, ui);
  assert.equal(llm.calls.length, 4, '3 recoveries, then the 4th cut-off reply is accepted as the answer');
  assert.ok(llm.calls[1].some((m: any) => m.role === 'user' && /Continue exactly where you stopped/.test(m.content)));
});

test('cut-off: a complete tool call with finish_reason length still runs', async () => {
  const ok = { content: '', finishReason: 'length', toolCalls: [{ id: 'e1', type: 'function' as const, function: { name: 'edit_file', arguments: '{}' } }] };
  const { agent, ran, ui } = gateSetup([ok, text('done')], {});
  await agent.send('x', AUTO, ui);
  assert.equal(ran.length, 2, 'the edit ran, so the checks ran');
});

/* ------------------------------------------------------------------ test-first (feature 9) */

test('/fix: test-first workflow with the bug description', () => {
  const p = parseSlash('/fix totals are off by one');
  assert.ok(p?.known);
  const prompt = fixPrompt('totals are off by one');
  assert.match(prompt, /totals are off by one/);
  assert.match(prompt, /fails because of this bug/);
  assert.match(prompt, /Do not change the test to make it pass/);
  assert.match(fixPrompt(''), /ask_user_question/);
  assert.match(buildSystemPrompt('auto', 'medium', '/w', ''), /Fix bugs test-first/);
});

/* ------------------------------------------------------------------ verification summary (feature 10) */

test('summary: lists the checks that ran after the last change', async () => {
  const { agent, ui } = gateSetup([call('edit_file', { path: 'a.ts' }), text('done')], {});
  const seen: any[] = [];
  ui.verification = (v) => seen.push(v);
  await agent.send('x', AUTO, ui);
  assert.ok(ui.events.includes('info:Changed 1 file. Checked after the last change: ✓ lint-cmd · ✓ test-cmd'));
  assert.deepEqual(seen[0].changed, ['a.ts']);
});

test('summary: says plainly when nothing was verified', async () => {
  const { agent, ui } = gateSetup([call('edit_file', { path: 'a.ts' }), text('done')], {}, { checks: [] });
  await agent.send('x', AUTO, ui);
  assert.ok(ui.events.some((e) => /Changed 1 file\. Not verified/.test(e)));
});

test('summary: a check before the last edit does not count; a failing check shows ✗', async () => {
  const { agent, ui } = gateSetup([
    call('run_command', { command: 'npm test' }, 'r1'), call('edit_file', { path: 'b.ts' }, 'e1'), call('run_command', { command: 'npm run lint' }, 'r2'), text('done'),
  ], { 'npm run lint': [1] }, { checks: [] });
  await agent.send('x', AUTO, ui);
  const line = ui.events.find((e) => /Changed 1 file/.test(e))!;
  assert.match(line, /✗ npm run lint/);
  assert.doesNotMatch(line, /npm test/);
});

test('summary: nothing is reported for a turn without changes', async () => {
  const { agent, ui } = gateSetup([call('read_file', {}), text('answer')], {});
  await agent.send('x', AUTO, ui);
  assert.ok(!ui.events.some((e) => /Changed \d+ file/.test(e)));
});
