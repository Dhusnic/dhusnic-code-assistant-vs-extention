import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Agent } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { PlanFirstSetting, parsePlanFirstSetting, planFirstActive } from '../core/planFirst';
import { REVIEW_SYSTEM, SelfReviewSetting } from '../core/selfReview';
import { PLAN_FIRST_PROMPT } from '../core/prompts';
import { StreamResult } from '../core/llm';
import { call, fakeLlm, recordingUi, text, tmpDir } from './helpers';

type Effort = 'low' | 'medium' | 'high' | 'max';
const opts = (effort: Effort, mode: 'auto' | 'plan' | 'ask' = 'auto') => ({ mode, effort, model: 'm' } as const);
const isReview = (msgs: any[]) => msgs[0]?.role === 'system' && msgs[0].content === REVIEW_SYSTEM;

async function build(main: StreamResult[], setting: PlanFirstSetting | undefined, extra: { subagent?: boolean; selfReview?: SelfReviewSetting } = {}) {
  const root = await tmpDir('planfirst-');
  await fs.writeFile(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
  await fs.writeFile(path.join(root, 'b.txt'), 'alpha\n');
  let m = 0;
  let reviews = 0;
  const llm = fakeLlm([(msgs) => {
    if (isReview(msgs)) { reviews++; return text('LGTM'); }
    return main[Math.min(m++, main.length - 1)];
  }]);
  const agent = new Agent({
    root, llm: llm.fn, tools: () => createFsTools(),
    getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }),
    planFirst: setting ? () => setting : undefined,
    selfReview: extra.selfReview ? () => extra.selfReview! : undefined,
    subagent: extra.subagent,
  });
  const read = async (f = 'a.txt') => fs.readFile(path.join(root, f), 'utf8');
  return { agent, root, llm, read, mainCalls: () => m, reviews: () => reviews };
}

const readA = call('read_file', { path: 'a.txt' }, 'R1');
const edit = (id: string, newText = 'TWO', oldText = 'two') => call('edit_file', { path: 'a.txt', old_string: oldText, new_string: newText }, id);
const todo = (id = 'T1') => call('todo_write', { todos: [{ content: 'Capitalize two in a.txt', status: 'in_progress' }] }, id);
const both = (...rs: StreamResult[]): StreamResult => ({ content: '', toolCalls: rs.flatMap((r) => r.toolCalls) });
const toolResult = (agent: Agent, id: string) => String(agent.history.find((x) => x.role === 'tool' && x.tool_call_id === id)?.content ?? '');
const held = (agent: Agent, id: string) => /^NOT RUN \(plan first\)/.test(toolResult(agent, id));

test('planFirstActive: max effort by default, every effort with always, never when off, in plan mode or for sub-agents', () => {
  assert.equal(planFirstActive('max', 'max', 'auto', false), true);
  assert.equal(planFirstActive('max', 'high', 'auto', false), false);
  assert.equal(planFirstActive('max', 'low', 'ask', false), false);
  assert.equal(planFirstActive('always', 'low', 'ask', false), true);
  assert.equal(planFirstActive('always', 'medium', 'auto-edit', false), true);
  assert.equal(planFirstActive('off', 'max', 'auto', false), false);
  assert.equal(planFirstActive(undefined, 'max', 'auto', false), false);
  assert.equal(planFirstActive('always', 'max', 'plan', false), false);
  assert.equal(planFirstActive('always', 'max', 'auto', true), false);
  assert.equal(parsePlanFirstSetting('off'), 'off');
  assert.equal(parsePlanFirstSetting('always'), 'always');
  assert.equal(parsePlanFirstSetting('max'), 'max');
  assert.equal(parsePlanFirstSetting('bogus'), 'max');
  assert.equal(parsePlanFirstSetting(undefined), 'max');
});

test('max effort: the first unplanned edit is held, not run; after todo_write the edit runs', async () => {
  const { agent, read, mainCalls } = await build([readA, edit('E1'), todo(), edit('E2'), text('Done.')], 'max');
  const ui = recordingUi();
  await agent.send('capitalize two', opts('max'), ui);
  assert.ok(held(agent, 'E1'), toolResult(agent, 'E1'));
  assert.match(toolResult(agent, 'E1'), /Call todo_write with the concrete steps/);
  assert.match(toolResult(agent, 'E2'), /^(?!NOT RUN)/);
  assert.equal(await read(), 'one\nTWO\nthree\n');
  assert.equal(mainCalls(), 6, 'one extra round for the hold, one for the usual open-steps reminder at the end');
  assert.ok(ui.events.some((e) => /^info:Plan first:/.test(e)));
  assert.ok(ui.events.some((e) => /^end:fail:Not run yet: plan first/.test(e)), 'the held call is shown as not run');
  assert.deepEqual(agent.lastChanged.map((p) => path.basename(p)), ['a.txt']);
});

test('the gate fires once per turn: a second unplanned edit runs', async () => {
  const { agent, read } = await build([readA, edit('E1'), edit('E2'), text('Done.')], 'max');
  await agent.send('capitalize two', opts('max'), recordingUi());
  assert.ok(held(agent, 'E1'));
  assert.ok(!held(agent, 'E2'));
  assert.equal(await read(), 'one\nTWO\nthree\n');
});

test('every edit of the held response is held together; the next response runs normally', async () => {
  const writeB = call('write_file', { path: 'b.txt', content: 'beta\n' }, 'W1');
  const { agent, read } = await build([readA, both(edit('E1'), writeB), both(todo(), edit('E2')), text('Done.')], 'max');
  await agent.send('change both files', opts('max'), recordingUi());
  assert.ok(held(agent, 'E1') && held(agent, 'W1'), 'no half-applied batch');
  assert.equal(await read('b.txt'), 'alpha\n');
  assert.ok(!held(agent, 'E2'));
  assert.equal(await read(), 'one\nTWO\nthree\n');
});

test('no hold below max effort with the default setting, when off, or without the setting', async () => {
  for (const [setting, effort] of [['max', 'high'], ['max', 'low'], ['off', 'max'], [undefined, 'max']] as const) {
    const { agent, read } = await build([readA, edit('E1'), text('Done.')], setting);
    await agent.send('capitalize two', opts(effort), recordingUi());
    assert.ok(!held(agent, 'E1'), `${setting}/${effort}`);
    assert.equal(await read(), 'one\nTWO\nthree\n');
  }
});

test('always: holds at every effort level', async () => {
  for (const effort of ['low', 'medium', 'high', 'max'] as const) {
    const { agent } = await build([readA, edit('E1'), todo(), edit('E2'), text('Done.')], 'always');
    await agent.send('capitalize two', opts(effort), recordingUi());
    assert.ok(held(agent, 'E1'), effort);
  }
});

test('a plan already written this turn, in the same response, or carried over unfinished: no hold', async () => {
  const a = await build([readA, todo(), edit('E1'), text('Done.')], 'max');
  await a.agent.send('capitalize two', opts('max'), recordingUi());
  assert.ok(!held(a.agent, 'E1'));
  assert.equal(await a.read(), 'one\nTWO\nthree\n');

  const b = await build([readA, both(todo(), edit('E1')), text('Done.')], 'max');
  await b.agent.send('capitalize two', opts('max'), recordingUi());
  assert.ok(!held(b.agent, 'E1'));

  // An invalid todo_write is not a plan.
  const c = await build([readA, call('todo_write', { todos: [] }, 'T0'), edit('E1'), todo(), edit('E2'), text('Done.')], 'max');
  await c.agent.send('capitalize two', opts('max'), recordingUi());
  assert.ok(held(c.agent, 'E1'));

  // Turn 1 writes an unfinished list and stops; turn 2 ("continue") edits right away.
  const d = await build([todo(), text('Stopping here.'), text('Stopping here.'), readA, edit('E1'), text('Done.')], 'max');
  await d.agent.send('plan it', opts('max'), recordingUi());
  await d.agent.send('continue', opts('max'), recordingUi());
  assert.ok(!held(d.agent, 'E1'));
  assert.equal(await d.read(), 'one\nTWO\nthree\n');
});

test('questions and read-only turns are unaffected: no extra model call; the prompt line follows the setting', async () => {
  const { agent, llm, mainCalls } = await build([readA, text('It says two.')], 'max');
  const ui = recordingUi();
  await agent.send('what does a.txt say?', opts('max'), ui);
  assert.equal(mainCalls(), 2);
  assert.ok(!ui.events.some((e) => /Plan first/.test(e)));
  assert.ok(String(llm.calls[0][0].content).includes(PLAN_FIRST_PROMPT));

  const off = await build([text('Hi.')], 'max');
  await off.agent.send('hello', opts('high'), recordingUi());
  assert.ok(!String(off.llm.calls[0][0].content).includes(PLAN_FIRST_PROMPT));
});

test('sub-agents are never held', async () => {
  const { agent, read, llm } = await build([readA, edit('E1'), text('Done.')], 'always', { subagent: true });
  await agent.send('capitalize two', opts('max'), recordingUi());
  assert.ok(!held(agent, 'E1'));
  assert.equal(await read(), 'one\nTWO\nthree\n');
  assert.ok(!String(llm.calls[0][0].content).includes(PLAN_FIRST_PROMPT));
});

test('plan mode: edits are refused by the mode, not held by plan-first', async () => {
  const { agent } = await build([readA, edit('E1'), text('Plan.')], 'always');
  await agent.send('capitalize two', opts('max', 'plan'), recordingUi());
  assert.match(toolResult(agent, 'E1'), /not allowed in plan mode/);
});

test('a held call is not a change, a failure or a repeat: no self-review, no loop-guard nudge', async () => {
  // Held, then the model gives up without changing anything: nothing changed, so no self-review.
  const a = await build([readA, edit('E1'), text('Never mind.')], 'max', { selfReview: 'always' });
  await a.agent.send('capitalize two', opts('max'), recordingUi());
  assert.ok(held(a.agent, 'E1'));
  assert.equal(a.agent.lastChanged.length, 0);
  assert.equal(a.reviews(), 0);

  // The identical edit sent again after the plan is its first real run, and later identical calls count from there.
  const b = await build([readA, edit('E1'), todo(), edit('E2'), edit('E3', 'Two', 'TWO'), text('Done.')], 'max', { selfReview: 'always' });
  const ui = recordingUi();
  await b.agent.send('capitalize two', opts('max'), ui);
  assert.ok(!ui.events.some((e) => /repeated|keeps failing|failed \d+ times/.test(e)), ui.events.filter((e) => e.startsWith('info:')).join('\n'));
  assert.ok(!/system-reminder/.test(toolResult(b.agent, 'E1')));
  assert.equal(await b.read(), 'one\nTwo\nthree\n');
  assert.equal(b.reviews(), 1, 'the real change is reviewed once');
});

test('a plan approved mid-turn (plan mode → auto): the gate applies from then on, until todo_write', async () => {
  const plan = call('exit_plan_mode', { plan: '1. Capitalize two in a.txt' }, 'P1');
  const { agent, read } = await build([readA, plan, edit('E1'), todo(), edit('E2'), text('Done.')], 'max');
  const ui = { ...recordingUi(), approvePlan: async () => 'auto' as const };
  await agent.send('capitalize two', opts('max', 'plan'), ui);
  assert.ok(held(agent, 'E1'));
  assert.ok(!held(agent, 'E2'));
  assert.equal(await read(), 'one\nTWO\nthree\n');
});
