import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Agent, TASK_TOOL, buildSystemPrompt } from '../core/agent';
import { ChatMessage, LlmFn, StreamResult } from '../core/llm';
import { createFsTools } from '../core/fstools';
import { call, recordingUi, text, tmpDir } from './helpers';

type Step = StreamResult | ((msgs: ChatMessage[], tools: string[]) => StreamResult | Promise<StreamResult>);

/** Routes LLM calls to a parent or child script based on the system prompt. */
function routed(parent: Step[], child: Step[]) {
  const seen: { who: 'parent' | 'child'; msgs: ChatMessage[]; tools: string[] }[] = [];
  const idx = { parent: 0, child: 0 };
  const fn: LlmFn = async (_c, msgs, tools, onToken) => {
    const who = /SUB-AGENT/.test(msgs[0].content ?? '') ? 'child' : 'parent';
    const names = tools.map((t) => t.function.name);
    seen.push({ who, msgs, tools: names });
    const script = who === 'child' ? child : parent;
    const step = script[Math.min(idx[who]++, script.length - 1)];
    const res = typeof step === 'function' ? await step(msgs, names) : step;
    if (res.content) { onToken(res.content); }
    return res;
  };
  return { fn, seen };
}

function agentFor(root: string, llm: LlmFn) {
  return new Agent({ root, llm, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => createFsTools() });
}
const OPTS = { mode: 'ask', effort: 'medium', model: 'm' } as const;
const task = (description: string, prompt: string, id = `t_${description}`) => call(TASK_TOOL, { description, prompt }, id);

test('task tool is offered to the parent, never to a sub-agent; sub-agent is read-only', async () => {
  const r = routed([task('look', 'find things'), text('parent done')], [text('report')]);
  await agentFor(await tmpDir(), r.fn).send('go', OPTS, recordingUi());
  const parent = r.seen.find((s) => s.who === 'parent')!;
  const child = r.seen.find((s) => s.who === 'child')!;
  assert.ok(parent.tools.includes(TASK_TOOL) && parent.tools.includes('write_file'));
  assert.ok(!child.tools.includes(TASK_TOOL), 'no nested delegation');
  for (const forbidden of ['write_file', 'edit_file', 'run_command']) { assert.ok(!child.tools.includes(forbidden), forbidden); }
  assert.ok(child.tools.includes('read_file') && child.tools.includes('grep'));
});

test('sub-agent starts with a fresh context and returns only its final report', async () => {
  const r = routed([task('look', 'find the answer'), text('parent done')], [text('REPORT: answer is 42')]);
  const agent = agentFor(await tmpDir(), r.fn);
  await agent.send('secret parent context', OPTS, recordingUi());
  const child = r.seen.find((s) => s.who === 'child')!;
  assert.deepEqual(child.msgs.slice(1).map((m) => m.content), ['find the answer'], 'child sees only its prompt');
  assert.ok(!JSON.stringify(child.msgs).includes('secret parent context'));
  const toolMsg = agent.history.find((m) => m.role === 'tool')!;
  assert.equal(toolMsg.content, 'REPORT: answer is 42');
  assert.equal(agent.history.filter((m) => m.role === 'assistant').length, 2, 'child turns do not leak into parent history');
  assert.match(r.seen.find((s) => s.who === 'child')!.msgs[0].content!, /read-only tools/);
});

test('sub-agent can use read tools; progress is forwarded to the UI', async () => {
  const root = await tmpDir();
  await fs.writeFile(path.join(root, 'data.txt'), 'needle in file');
  const r = routed(
    [task('search', 'find needle', 'T1'), text('ok')],
    [call('grep', { pattern: 'needle' }, 'g1'), (msgs) => text(`found: ${msgs.find((m) => m.role === 'tool')!.content}`)],
  );
  const ui = recordingUi(); const progress: string[] = [];
  ui.subProgress = (id, t) => progress.push(`${id}:${t}`);
  const agent = agentFor(root, r.fn);
  await agent.send('go', OPTS, ui);
  assert.deepEqual(progress, ['T1:Search "needle"']);
  assert.match(agent.history.find((m) => m.role === 'tool')!.content!, /found: [^\n]*\ndata\.txt\n\s+1: needle in file/);
});

test('a sub-agent cannot modify files even if the model tries', async () => {
  const root = await tmpDir();
  const r = routed([task('sneaky', 'write a file', 'T'), text('ok')], [call('write_file', { path: 'pwned.txt', content: 'x' }), text('tried')]);
  await agentFor(root, r.fn).send('go', OPTS, recordingUi(true));
  await assert.rejects(fs.stat(path.join(root, 'pwned.txt')));
});

test('sub-agent approvals are never auto-granted', async () => {
  const root = await tmpDir();
  const r = routed([task('x', 'p'), text('ok')], [call('run_command', { command: 'echo hi' }), text('done')]);
  const ui = recordingUi(true);
  await agentFor(root, r.fn).send('go', OPTS, ui);
  assert.equal(ui.approvals.length, 0, 'run_command is not even registered for the child');
});

test('parallel tasks run concurrently and results keep tool_call order', async () => {
  let active = 0, peak = 0;
  const slow = (label: string, ms: number) => async (): Promise<StreamResult> => {
    active++; peak = Math.max(peak, active);
    await new Promise((res) => setTimeout(res, ms));
    active--; return text(label);
  };
  const two: StreamResult = { content: '', toolCalls: [
    { id: 'a', type: 'function', function: { name: TASK_TOOL, arguments: JSON.stringify({ description: 'A', prompt: 'first' }) } },
    { id: 'b', type: 'function', function: { name: TASK_TOOL, arguments: JSON.stringify({ description: 'B', prompt: 'second' }) } },
  ] };
  const r = routed([two, text('merged')], [(msgs) => (msgs[1].content === 'first' ? slow('R-first', 60)() : slow('R-second', 10)())]);
  const agent = agentFor(await tmpDir(), r.fn);
  await agent.send('go', OPTS, recordingUi());
  assert.equal(peak, 2, 'both sub-agents were active at once');
  const tools = agent.history.filter((m) => m.role === 'tool');
  assert.deepEqual(tools.map((m) => [m.tool_call_id, m.content]), [['a', 'R-first'], ['b', 'R-second']]);
});

test('empty prompt, bad JSON and nested delegation are rejected cleanly', async () => {
  const r1 = routed([task('x', '   '), text('ok')], []);
  const a1 = agentFor(await tmpDir(), r1.fn); await a1.send('go', OPTS, recordingUi());
  assert.match(a1.history.find((m) => m.role === 'tool')!.content!, /non-empty/);

  const r2 = routed([task('outer', 'do it'), text('ok')], [task('inner', 'nested'), text('child done')]);
  const a2 = agentFor(await tmpDir(), r2.fn); await a2.send('go', OPTS, recordingUi());
  const childFirst = r2.seen.filter((s) => s.who === 'child')[1];
  assert.match(childFirst.msgs.find((m) => m.role === 'tool')!.content!, /cannot start further sub-agents|unknown tool/);
});

test('sub-agent failure is reported to the parent, which keeps going', async () => {
  const r = routed([task('x', 'p'), text('parent recovered')], [() => { throw new Error('model exploded'); }]);
  const agent = agentFor(await tmpDir(), r.fn);
  await agent.send('go', OPTS, recordingUi());
  assert.match(agent.history.find((m) => m.role === 'tool')!.content!, /sub-agent failed: model exploded/);
  assert.equal(agent.history.at(-1)!.content, 'parent recovered');
});

test('sub-agent that runs out of steps reports that instead of hanging', async () => {
  const r = routed([task('x', 'p'), text('ok')], [call('list_dir', { path: '.' })]);
  const agent = agentFor(await tmpDir(), r.fn);
  await agent.send('go', { ...OPTS, effort: 'low' }, recordingUi());
  assert.match(agent.history.find((m) => m.role === 'tool')!.content!, /without a final report/);
});

test('cancelling the parent cancels a running sub-agent promptly', async () => {
  let childStarted = false;
  const r = routed([task('x', 'p', 'tc'), text('never')], [async () => { childStarted = true; await new Promise((res) => setTimeout(res, 5000)); return text('late'); }]);
  const agent = agentFor(await tmpDir(), r.fn);
  const ui = recordingUi();
  setTimeout(() => agent.cancel(), 50);
  const t0 = Date.now();
  await agent.send('go', OPTS, ui);
  assert.ok(childStarted);
  assert.ok(Date.now() - t0 < 2000, 'returned long before the child would have finished');
  assert.ok(ui.events.includes('info:Cancelled.'));
  assert.equal(agent.history.at(-1)!.tool_call_id, 'tc');
});

test('plan mode may delegate research (task is a meta tool)', async () => {
  const r = routed([task('x', 'p'), text('planned')], [text('findings')]);
  const agent = agentFor(await tmpDir(), r.fn);
  await agent.send('go', { ...OPTS, mode: 'plan' }, recordingUi());
  assert.equal(agent.history.find((m) => m.role === 'tool')!.content, 'findings');
});

test('system prompt marks sub-agents only when asked', () => {
  assert.match(buildSystemPrompt('auto', 'medium', '/w', '', undefined, true), /SUB-AGENT/);
  assert.doesNotMatch(buildSystemPrompt('auto', 'medium', '/w', ''), /SUB-AGENT/);
});
