import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Agent } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { TODO_REMINDER_ROUNDS } from '../core/todos';
import { call, fakeLlm, recordingUi, text, tmpDir } from './helpers';

const OPTS = { mode: 'auto', effort: 'medium', model: 'm' } as const;
const LIST = (s1: string, s2 = 'pending') => ({ todos: [
  { content: 'Scaffold', activeForm: 'Scaffolding', status: s1 },
  { content: 'Build UI', activeForm: 'Building UI', status: s2 },
] });

async function build(script: Parameters<typeof fakeLlm>[0], subagent = false) {
  const root = await tmpDir('todo-rem-');
  const llm = fakeLlm(script);
  const agent = new Agent({ root, llm: llm.fn, subagent, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => createFsTools() });
  return { agent, llm };
}
const reminders = (msgs: any[]) => msgs.filter((m) => m.role === 'tool' && /<system-reminder>.*task list/s.test(String(m.content)));

test('a task list left untouched for many tool rounds gets a reminder with its current state (the "stuck on step 1" bug)', async () => {
  const work = Array.from({ length: TODO_REMINDER_ROUNDS * 2 }, (_, i) => call('list_dir', { path: '.' }, `L${i}`));
  const { agent } = await build([call('todo_write', LIST('in_progress'), 'T1'), ...work, call('todo_write', LIST('completed', 'completed'), 'T2'), text('done')]);
  await agent.send('build it', OPTS, recordingUi());
  const r = reminders(agent.history);
  assert.equal(r.length, 2, 'reminded every TODO_REMINDER_ROUNDS rounds, not every round');
  assert.match(String(r[0].content), /1\. \[in_progress\] Scaffold\n2\. \[pending\] Build UI/);
  assert.match(String(r[0].content), new RegExp(`${TODO_REMINDER_ROUNDS} rounds of tool calls`));
  assert.equal(agent.history.at(-1)!.content, 'done');
});

test('no reminder while the model keeps the list current, when it is complete, or for sub-agents', async () => {
  const steady = Array.from({ length: TODO_REMINDER_ROUNDS * 2 }, (_, i) => (i % 2 ? call('todo_write', LIST('in_progress'), `T${i}`) : call('list_dir', { path: '.' }, `L${i}`)));
  const a = await build([...steady, call('todo_write', LIST('completed', 'completed'), 'Tz'), text('ok')]);
  await a.agent.send('go', OPTS, recordingUi());
  assert.equal(reminders(a.agent.history).length, 0);

  const done = Array.from({ length: TODO_REMINDER_ROUNDS + 1 }, (_, i) => call('list_dir', { path: '.' }, `D${i}`));
  const b = await build([call('todo_write', LIST('completed', 'completed'), 'T1'), ...done, text('ok')]);
  await b.agent.send('go', OPTS, recordingUi());
  assert.equal(reminders(b.agent.history).length, 0);

  const c = await build([call('todo_write', LIST('in_progress'), 'T1'), ...done, text('ok')], true);
  await c.agent.send('go', OPTS, recordingUi());
  assert.equal(reminders(c.agent.history).length, 0);
});

test('ending a working turn with open steps asks once to settle the list; the model can then finish', async () => {
  const { agent, llm } = await build([
    call('todo_write', LIST('in_progress'), 'T1'),
    call('list_dir', { path: '.' }, 'L1'),
    text('All built.'),
    call('todo_write', LIST('completed', 'completed'), 'T2'),
    text('All built, list updated.'),
  ]);
  await agent.send('build it', OPTS, recordingUi());
  const asks = agent.history.filter((m) => m.role === 'user' && /unfinished step/.test(String(m.content)));
  assert.equal(asks.length, 1);
  assert.match(String(asks[0].content), /\[in_progress\] Scaffold/);
  assert.equal(agent.history.at(-1)!.content, 'All built, list updated.');
  assert.equal(agent.todoState().todos!.every((t) => t.status === 'completed'), true);
  assert.equal(llm.calls.length, 5);
});

test('the end-of-turn ask is sent at most once, and never for a turn that did no work', async () => {
  const a = await build([call('todo_write', LIST('in_progress'), 'T1'), text('stopping: waiting for your API key'), text('still waiting')]);
  await a.agent.send('go', OPTS, recordingUi());
  assert.equal(a.agent.history.filter((m) => m.role === 'user' && /unfinished step/.test(String(m.content))).length, 1);
  assert.equal(a.agent.history.at(-1)!.content, 'still waiting');

  // Next turn is a plain question with no tools: the old open list is not nagged about.
  const before = a.agent.history.length;
  await a.agent.send('what is 2+2?', OPTS, recordingUi());
  assert.equal(a.agent.history.slice(before).filter((m) => m.role === 'user' && /unfinished step/.test(String(m.content))).length, 0);
});

test('todoState reads the latest valid list from the history and counts the rounds since', async () => {
  const { agent } = await build([call('todo_write', LIST('in_progress'), 'T1'), call('list_dir', { path: '.' }, 'L1'), call('todo_write', { todos: [] }, 'bad'), text('x')]);
  await agent.send('go', OPTS, recordingUi());
  const s = agent.todoState();
  assert.equal(s.todos![0].status, 'in_progress', 'an invalid todo_write is skipped');
  assert.equal(s.rounds, 2);
});

test('a project created during the turn gets its checks detected and run before the turn ends', async () => {
  const root = await tmpDir('new-proj-');
  const fsMod = await import('fs');
  const pathMod = await import('path');
  let asked = 0;
  const llm = fakeLlm([
    call('write_file', { path: 'package.json', content: '{"name":"x","scripts":{"test":"node -e 0"}}' }, 'W1'),
    call('write_file', { path: 'index.js', content: 'module.exports = 1;\n' }, 'W2'),
    text('done'),
  ]);
  const agent = new Agent({
    root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => createFsTools(),
    checks: () => { asked++; return fsMod.existsSync(pathMod.join(root, 'package.json')) ? [{ name: 'test', command: 'node -e 0', timeoutSeconds: 60 }] : []; },
  });
  const ui = recordingUi();
  await agent.send('create a project', OPTS, ui);
  assert.equal(asked, 2, 'checked at the start (nothing yet) and again once files exist');
  assert.ok(ui.events.some((e) => /Project checks passed: test/.test(e)), ui.events.join('\n'));
});

test('reaching the tool-round limit with open steps leaves a reminder for the next turn', async () => {
  const root = await tmpDir('todo-rem-');
  const work = Array.from({ length: 5 }, (_, i) => call('list_dir', { path: '.' }, `L${i}`));
  const llm = fakeLlm([call('todo_write', LIST('in_progress'), 'T1'), ...work]);
  const agent = new Agent({
    root, llm: llm.fn, limits: () => ({ maxIterations: 3 }),
    getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => createFsTools(),
  });
  await agent.send('build it', OPTS, recordingUi());
  const last = agent.history.at(-1)!;
  assert.equal(last.role, 'tool', 'no extra user message is added');
  assert.match(String(last.content), /<system-reminder>You are ending your turn, but the task list still has 2 unfinished steps/);
});

test('compaction keeps the latest unfinished task list, so reminders still work afterwards', async () => {
  const { agent } = await build([
    call('todo_write', LIST('in_progress'), 'T1'), text('first turn done'), text('stopping here on purpose'),
    text('second turn'),
    text('SUMMARY OF EARLIER WORK'),
  ]);
  await agent.send('build it', OPTS, recordingUi());
  await agent.send('status?', OPTS, recordingUi());
  assert.ok(agent.todoState().todos, 'list present before compaction');
  assert.equal(await agent.compact(OPTS, recordingUi(), true), true);
  assert.match(String(agent.history[0].content), /SUMMARY OF EARLIER WORK/);
  assert.equal(agent.history[1].tool_calls?.[0].function.name, 'todo_write', 'carried on the summary acknowledgement');
  assert.equal(agent.history[2].role, 'tool');
  assert.equal(agent.history[2].tool_call_id, agent.history[1].tool_calls?.[0].id);
  assert.deepEqual(agent.todoState().todos?.map((t) => t.status), ['in_progress', 'pending']);
});
