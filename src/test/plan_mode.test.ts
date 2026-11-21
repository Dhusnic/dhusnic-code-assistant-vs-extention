import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Agent, PLAN_TOOL, buildSystemPrompt } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { Mode } from '../core/policy';
import { call, fakeLlm, recordingUi, text, tmpDir } from './helpers';

const PLAN_OPTS = { mode: 'plan', effort: 'medium', model: 'm' } as const;

function build(root: string, llm: ReturnType<typeof fakeLlm>) {
  const offered: string[][] = [];
  const wrapped = (async (c: any, m: any, tools: any[], tok: any, s: any) => { offered.push(tools.map((t) => t.function.name)); return llm.fn(c, m, tools, tok, s); }) as any;
  const agent = new Agent({ root, llm: wrapped, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => createFsTools() });
  return { agent, offered };
}

function planUi(decision: Mode | null | 'hang') {
  const ui = recordingUi(true);
  const modes: Mode[] = [];
  const plans: string[] = [];
  ui.approvePlan = (_id, plan) => { plans.push(plan); return decision === 'hang' ? new Promise(() => {}) : Promise.resolve(decision); };
  ui.modeChanged = (m) => modes.push(m);
  return { ui, modes, plans };
}

test('plan tool is offered only in plan mode', async () => {
  const root = await tmpDir();
  const a = build(root, fakeLlm([text('x')]));
  await a.agent.send('q', PLAN_OPTS, recordingUi());
  assert.ok(a.offered[0].includes(PLAN_TOOL));
  assert.ok(!a.offered[0].includes('write_file'));
  const b = build(root, fakeLlm([text('x')]));
  await b.agent.send('q', { ...PLAN_OPTS, mode: 'ask' }, recordingUi());
  assert.ok(!b.offered[0].includes(PLAN_TOOL));
});

test('plan prompt tells the model to use exit_plan_mode', () => {
  assert.match(buildSystemPrompt('plan', 'medium', '/w', ''), /exit_plan_mode/);
  assert.doesNotMatch(buildSystemPrompt('ask', 'medium', '/w', ''), /exit_plan_mode/);
});

test('approved plan switches mode mid-run: edits become available and are applied', async () => {
  const root = await tmpDir();
  const llm = fakeLlm([
    call(PLAN_TOOL, { plan: '1. create a.txt' }, 'p1'),
    call('write_file', { path: 'a.txt', content: 'hello' }, 'w1'),
    text('done'),
  ]);
  const { agent, offered } = build(root, llm);
  const { ui, modes, plans } = planUi('auto-edit');
  await agent.send('plan it', PLAN_OPTS, ui);
  assert.deepEqual(plans, ['1. create a.txt']);
  assert.deepEqual(modes, ['auto-edit']);
  assert.ok(!offered[0].includes('write_file'));
  assert.ok(offered[1].includes('write_file') && !offered[1].includes(PLAN_TOOL), 'tools refreshed after approval');
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'hello');
  assert.equal(ui.approvals.length, 0, 'auto-edit applies the edit without another prompt');
  const toolMsg = agent.history.find((m) => m.tool_call_id === 'p1')!;
  assert.match(toolMsg.content!, /approved the plan/);
});

test('approving into ask mode keeps per-edit approvals', async () => {
  const root = await tmpDir();
  const llm = fakeLlm([call(PLAN_TOOL, { plan: 'p' }), call('write_file', { path: 'b.txt', content: 'x' }), text('ok')]);
  const { agent } = build(root, llm);
  const { ui } = planUi('ask');
  await agent.send('go', PLAN_OPTS, ui);
  assert.equal(ui.approvals.length, 1);
  assert.equal(ui.approvals[0].name, 'write_file');
});

test('rejected plan keeps plan mode and blocks edits', async () => {
  const root = await tmpDir();
  const llm = fakeLlm([call(PLAN_TOOL, { plan: 'bad plan' }), call('write_file', { path: 'no.txt', content: 'x' }), text('revising')]);
  const { agent, offered } = build(root, llm);
  const { ui, modes } = planUi(null);
  await agent.send('go', PLAN_OPTS, ui);
  assert.deepEqual(modes, []);
  assert.ok(!offered[1].includes('write_file'));
  await assert.rejects(fs.stat(path.join(root, 'no.txt')));
  assert.match(agent.history.find((m) => m.role === 'tool')!.content!, /did not approve/);
});

test('a decision of "plan" counts as not approved', async () => {
  const { agent } = build(await tmpDir(), fakeLlm([call(PLAN_TOOL, { plan: 'p' }), text('ok')]));
  const { ui, modes } = planUi('plan');
  await agent.send('go', PLAN_OPTS, ui);
  assert.deepEqual(modes, []);
});

test('empty plan and missing approver are rejected safely', async () => {
  const a = build(await tmpDir(), fakeLlm([call(PLAN_TOOL, { plan: '   ' }), text('ok')]));
  await a.agent.send('go', PLAN_OPTS, planUi('ask').ui);
  assert.match(a.agent.history.find((m) => m.role === 'tool')!.content!, /non-empty/);

  const b = build(await tmpDir(), fakeLlm([call(PLAN_TOOL, { plan: 'p' }), text('ok')]));
  await b.agent.send('go', PLAN_OPTS, recordingUi());
  assert.match(b.agent.history.find((m) => m.role === 'tool')!.content!, /not available/);
});

test('calling exit_plan_mode outside plan mode is an error', async () => {
  const { agent } = build(await tmpDir(), fakeLlm([call(PLAN_TOOL, { plan: 'p' }), text('ok')]));
  await agent.send('go', { ...PLAN_OPTS, mode: 'ask' }, planUi('auto-edit').ui);
  assert.match(agent.history.find((m) => m.role === 'tool')!.content!, /only available in plan mode/);
});

test('cancel while the plan prompt is open does not hang', async () => {
  const { agent } = build(await tmpDir(), fakeLlm([call(PLAN_TOOL, { plan: 'p' }, 'pp'), text('never')]));
  const { ui } = planUi('hang');
  setTimeout(() => agent.cancel(), 20);
  await agent.send('go', PLAN_OPTS, ui);
  assert.ok(ui.events.includes('info:Cancelled.'));
  assert.equal(agent.history.at(-1)!.role, 'tool');
  assert.equal(agent.history.at(-1)!.tool_call_id, 'pp');
});

test('mode change applies to one turn only — the next send uses the options passed in', async () => {
  const root = await tmpDir();
  const llm = fakeLlm([call(PLAN_TOOL, { plan: 'p' }), text('a'), text('b')]);
  const { agent, offered } = build(root, llm);
  await agent.send('one', PLAN_OPTS, planUi('auto')!.ui);
  await agent.send('two', PLAN_OPTS, recordingUi());
  assert.ok(offered.at(-1)!.includes(PLAN_TOOL), 'next turn in plan mode again');
});
