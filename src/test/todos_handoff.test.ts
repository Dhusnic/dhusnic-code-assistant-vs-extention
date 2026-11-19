import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { Agent, TODO_TOOL, buildSystemPrompt } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { ChatMessage, LlmFn, StreamResult } from '../core/llm';
import { attachAction, finishAction, formatTodos, mergeTodos, validateTodos } from '../core/todos';
import { collectFacts, renderHandoff, summarizeSession } from '../core/handoff';
import { SessionManager } from '../core/runtime';
import { SessionStore2 } from '../core/store';
import { buildSessionHtml } from '../core/html';
import { recordingUi, tmpDir } from './helpers';

const ROOT = path.join(__dirname, '..', '..');
const text = (content: string): StreamResult => ({ content, toolCalls: [] });
const call = (name: string, args: object, id: string): StreamResult => ({ content: '', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const todos = (...items: Array<[string, string]>) => ({ todos: items.map(([content, status]) => ({ content, status, activeForm: `${content}…` })) });

/* ---------------------------------------------------------------- task list model */

test('todos: validation (statuses, one in_progress, limits, hyphen tolerance)', () => {
  assert.equal(validateTodos(todos(['a', 'pending'], ['b', 'in_progress'])).todos!.length, 2);
  assert.equal(validateTodos({ todos: [{ content: 'x', status: 'in-progress' }] }).todos![0].status, 'in_progress');
  assert.match(validateTodos({}).error!, /non-empty/);
  assert.match(validateTodos(todos(['a', 'in_progress'], ['b', 'in_progress'])).error!, /only one step/);
  assert.match(validateTodos(todos(['a', 'done'])).error!, /invalid status/);
  assert.match(validateTodos({ todos: [{ content: ' ', status: 'pending' }] }).error!, /no content/);
  assert.match(validateTodos({ todos: Array(21).fill({ content: 'x', status: 'pending' }) }).error!, /at most 20/);
});

test('todos: actions attach to the in-progress step, survive list updates, and get their result', () => {
  let list = mergeTodos([], validateTodos(todos(['Survey code', 'in_progress'], ['Write doc', 'pending'])).todos!);
  assert.equal(attachAction(list, { toolId: 't1', detail: 'Search "x"' }), true);
  assert.equal(finishAction(list, 't1', true), true);
  list = mergeTodos(list, validateTodos(todos(['Survey code', 'completed'], ['Write doc', 'in_progress'])).todos!);
  assert.deepEqual(list[0].actions.map(({ toolId, detail, ok }) => ({ toolId, detail, ok })), [{ toolId: 't1', detail: 'Search "x"', ok: true }], 'kept across updates');
  attachAction(list, { toolId: 't2', detail: 'Write plan.md' });
  assert.equal(list[1].actions.length, 1);
  const none = mergeTodos([], validateTodos(todos(['a', 'pending'])).todos!);
  assert.equal(attachAction(none, { toolId: 'x', detail: 'y' }), false, 'nothing in progress → not attached');
  assert.match(formatTodos(validateTodos(todos(['a', 'completed'], ['b', 'pending'])).todos!), /1\/2 done.*Next: mark "b" in_progress/);
});

test('agent: todo_write is offered (also to sub-agents), and plan approval asks for a task list', async () => {
  let offered: string[] = [];
  const llm: LlmFn = async (_c, _m, tools) => { offered = tools.map((t) => t.function.name); return text('x'); };
  for (const subagent of [false, true]) {
    const a = new Agent({ root: '.', llm, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => createFsTools(), subagent });
    await a.send('q', { mode: 'ask', effort: 'medium', model: 'm' }, recordingUi());
    assert.ok(offered.includes(TODO_TOOL), `offered (subagent=${subagent})`);
  }
  assert.match(buildSystemPrompt('ask', 'medium', '/w', ''), /track the steps with todo_write/);
  const agentSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'agent.ts'), 'utf8');
  assert.match(agentSrc, /First turn the plan into a task list with todo_write/);
});

/* ---------------------------------------------------------------- runtime */

test('runtime: live task list with per-step actions; only the latest list is kept in the transcript; persisted', async () => {
  const storeDir = await tmpDir('todo-store-');
  const root = await tmpDir('todo-root-');
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  const script: StreamResult[] = [
    call(TODO_TOOL, todos(['Survey files', 'in_progress'], ['Write notes', 'pending']), 'T1'),
    call('list_dir', { path: '.' }, 'L1'),
    call('read_file', { path: 'a.txt' }, 'R1'),
    call(TODO_TOOL, todos(['Survey files', 'completed'], ['Write notes', 'in_progress']), 'T2'),
    call('write_file', { path: 'notes.md', content: '# notes' }, 'W1'),
    call(TODO_TOOL, todos(['Survey files', 'completed'], ['Write notes', 'completed']), 'T3'),
    text('All done.'),
  ];
  let i = 0;
  const llm: LlmFn = async () => script[Math.min(i++, script.length - 1)];
  const make = (dir: string) => new SessionManager({
    store: new SessionStore2(dir), defaults: () => ({ mode: 'auto', effort: 'medium', model: 'm' }),
    createAgent: () => new Agent({ root, llm, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => createFsTools() }),
  });
  const mgr = make(storeDir);
  const s = mgr.newSession();
  await mgr.send(s.id, 'a1', 'survey then write notes');
  const rt = mgr.agent(s.id, 'a1');
  assert.deepEqual(rt.todos.map((t) => [t.content, t.status]), [['Survey files', 'completed'], ['Write notes', 'completed']]);
  assert.deepEqual(rt.todos[0].actions.map((a) => [a.detail, a.ok]), [['List .', true], ['Read a.txt', true]]);
  assert.deepEqual(rt.todos[1].actions.map((a) => [a.detail, a.ok]), [['Write notes.md', true]]);
  assert.equal(rt.log.filter((e) => e.type === 'todos').length, 1, 'transcript keeps one, current, task list');
  await mgr.shutdown();
  const re = await make(storeDir).open(s.id);
  const back = re!.agents.get('a1')!;
  assert.equal(back.todos[0].actions.length, 2);
  assert.equal(back.log.filter((e) => e.type === 'todos').length, 1, 'restored card');
});

/* ---------------------------------------------------------------- handoff */

const H: ChatMessage[] = [
  { role: 'user', content: 'Fix the add bug in math.js and add tests', display: 'Fix the add bug in math.js and add tests' },
  { role: 'assistant', content: null, tool_calls: [
    { id: 'e1', type: 'function', function: { name: 'edit_file', arguments: '{"path":"src\\\\math.js","old_string":"-","new_string":"+"}' } },
    { id: 'e2', type: 'function', function: { name: 'edit_file', arguments: '{"path":"src/denied.js","old_string":"a","new_string":"b"}' } },
    { id: 'w1', type: 'function', function: { name: 'write_file', arguments: '{"path":"test/math.test.js","content":"..."}' } },
    { id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{"command":"npm test"}' } },
    { id: 'c2', type: 'function', function: { name: 'run_command', arguments: '{"command":"npm run lint"}' } },
  ] },
  { role: 'tool', tool_call_id: 'e1', content: 'Edited src/math.js' },
  { role: 'tool', tool_call_id: 'e2', content: 'DENIED by user.' },
  { role: 'tool', tool_call_id: 'w1', content: 'Wrote test/math.test.js' },
  { role: 'tool', tool_call_id: 'c1', content: 'ok\n[exit 0]' },
  { role: 'tool', tool_call_id: 'c2', content: 'error\n[exit 1]' },
  { role: 'user', content: '<agent-notification>…</agent-notification>', display: '🔔 Agent “x” completed' },
  { role: 'assistant', content: 'Fixed and tested.' },
];

test('handoff facts are exact: only successful edits, commands with outcome, agents, requests without notifications', () => {
  const f = collectFacts('Math fix', [
    { id: 'a1', role: 'main', name: 'Main', history: H, todos: [{ content: 'Fix bug', status: 'completed', actions: [] }] },
    { id: 'a2', role: 'sub', name: 'x', type: 'explore', description: 'Find callers', outcome: 'completed', result: 'used in 3 places', history: [] },
  ]);
  assert.deepEqual(f.files, [{ path: 'src/math.js', edits: 1, writes: 0 }, { path: 'test/math.test.js', edits: 0, writes: 1 }]);
  assert.deepEqual(f.commands, [{ command: 'npm test', ok: true }, { command: 'npm run lint', ok: false }]);
  assert.deepEqual(f.agents, [{ type: 'explore', description: 'Find callers', outcome: 'completed' }]);
  assert.deepEqual(f.requests, ['Fix the add bug in math.js and add tests']);
  assert.equal(f.toolCalls, 5);
});

test('handoff: LLM narrative plus exact sections; the LLM receives facts, reports and the conversation', async () => {
  let sent: ChatMessage[] = [];
  const llm: LlmFn = async (_c, msgs) => { sent = msgs; return text('## Goal\n- Fix add\n\n## What was done\n- Fixed\n\n## Key decisions & findings\n- none\n\n## Current state\n- lint fails\n\n## Next steps\n- fix lint'); };
  const agents = [{ id: 'a1', role: 'main' as const, name: 'Main', history: H }, { id: 'a2', role: 'sub' as const, name: 'x', type: 'explore', description: 'Find callers', outcome: 'completed', result: 'used in 3 places', history: [] }];
  const r = await summarizeSession('Math fix', agents, llm, { baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }, new AbortController().signal);
  assert.equal(r.usedLlm, true);
  assert.match(String(sent[0].content), /## Goal[\s\S]*## Next steps/);
  assert.match(String(sent[1].content), /Files changed: src\/math\.js, test\/math\.test\.js/);
  assert.match(String(sent[1].content), /explore agent "Find callers" \(completed\): used in 3 places/);
  assert.match(String(sent[1].content), /USER: Fix the add bug/);
  assert.match(r.text, /^# Session handoff: Math fix\n\n> Paste this into a new session/);
  assert.match(r.text, /## Files changed\n- `src\/math\.js` — edited 1×\n- `test\/math\.test\.js` — written 1×/);
  assert.match(r.text, /## Commands run\n- ✓ `npm test`\n- ✕ `npm run lint`/);
  assert.match(r.text, /## Agents used\n- explore: Find callers \(completed\)/);
  assert.match(r.text, /## How to continue/);
});

test('handoff: without the LLM you still get an accurate factual handoff; empty sessions are handled', async () => {
  const failing: LlmFn = async () => { throw new Error('LLM HTTP 502: down'); };
  const r = await summarizeSession('Math fix', [{ id: 'a1', role: 'main', name: 'Main', history: H }], failing, { baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }, new AbortController().signal);
  assert.equal(r.usedLlm, false);
  assert.match(r.error!, /502/);
  assert.match(r.text, /Automatic summary unavailable \(LLM HTTP 502: down\)/);
  assert.match(r.text, /## Goal\n\n- Fix the add bug/);
  assert.match(r.text, /`src\/math\.js`/);
  const empty = await summarizeSession('', [{ id: 'a1', role: 'main', name: 'Main', history: [] }], failing, { baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }, new AbortController().signal);
  assert.match(empty.text, /# Session handoff: Untitled session/);
  assert.match(empty.text, /no messages yet/);
  assert.match(renderHandoff(collectFacts('t', []), 'x'), /\(no files were changed\)/);
});

/* ---------------------------------------------------------------- UI */

test('UI: summary icon in the header, handoff modal with Copy / Start new session / Regenerate, prefilled new tab', () => {
  const html = buildSessionHtml({ nonce: 'n', cspSource: 'c', cssUri: 'a', jsUri: 'b', mdUri: 'd', logoSvg: '<svg></svg>' });
  assert.match(html, /id="sumBtn" title="Summarize this session/);
  const js = fs.readFileSync(path.join(ROOT, 'media', 'session.js'), 'utf8');
  assert.match(js, /\$\('sumBtn'\)\.onclick = openHandoff/);
  for (const id of ['hCopy', 'hNew', 'hRegen']) { assert.ok(js.includes(`id="${id}"`), id); }
  assert.match(js, /post\(\{ type: 'startWithHandoff', text: \$\('hText'\)\.value \}\)/);
  assert.match(js, /case 'prefill':/);
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'host', 'sessionPanel.ts'), 'utf8');
  assert.match(panel, /case 'summarize': await this\.summarize\(\)/);
  assert.match(panel, /this\.post\(\{ type: 'prefill', text: this\.prefill \}\)/);
});

test('UI: task-list card (status icons, progress, click a step to see its actions) and the todo tool card is hidden', () => {
  const js = fs.readFileSync(path.join(ROOT, 'media', 'session.js'), 'utf8');
  assert.match(js, /case 'todos': renderTodos\(m\.items \|\| \[\]\); break;/);
  assert.match(js, /if \(m\.name === 'todo_write'\) \{ return; \}/);
  assert.match(js, /\$\{done\} of \$\{items\.length\} done/);
  assert.match(js, /openSteps\.has\(t\.content\)/);
  const css = fs.readFileSync(path.join(ROOT, 'media', 'chat.css'), 'utf8');
  for (const sel of ['.ti.todo', '.ti.run', '.ti.done', '.tacts']) { assert.ok(css.includes(sel), sel); }
});

test('UI: the @file / command picker is exactly as wide as the composer, one line per entry', () => {
  const js = fs.readFileSync(path.join(ROOT, 'media', 'session.js'), 'utf8');
  assert.match(js, /m\.style\.width = `\$\{r\.width\}px`; m\.style\.left = `\$\{r\.left\}px`;/);
  const css = fs.readFileSync(path.join(ROOT, 'media', 'chat.css'), 'utf8');
  assert.match(css, /\.menu\.wide \{ max-width: none; overflow-x: hidden; \}/);
  assert.match(css, /\.menu\.wide \.item \.d \{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis;/);
});

test('paths under the workspace are shown relative to it, whatever slash style the model used', async () => {
  const { relativizePaths } = await import('../core/agent');
  const root = process.platform === 'win32' ? String.raw`C:\Users\me\repo` : '/home/me/repo';
  const sep = process.platform === 'win32' ? '\\' : '/';
  assert.equal(relativizePaths(`Read ${root}${sep}src${sep}a.ts`, root), `Read src${sep}a.ts`);
  assert.equal(relativizePaths(`Read ${root.split(sep).join('/')}/src/a.ts`, root), 'Read src/a.ts');
  assert.equal(relativizePaths('Read other/place.ts', root), 'Read other/place.ts');
  assert.equal(relativizePaths(`Search "${root}-not-a-child"`, root), `Search "${root}-not-a-child"`, 'only real children are shortened');
  const abs = `${root}${sep}cfg${sep}app.yaml`;
  const f = collectFacts('t', [{ id: 'a1', role: 'main', name: 'Main', history: [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'w', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: abs, content: '' }) } }] },
    { role: 'tool', tool_call_id: 'w', content: 'Wrote it' },
  ] }], root);
  assert.deepEqual(f.files.map((x) => x.path), ['cfg/app.yaml']);
});

test('todos: each step records how long it took, each action its own duration; reopening resets timing', () => {
  let list = mergeTodos([], validateTodos(todos(['Survey', 'in_progress'], ['Write', 'pending'])).todos!, 1000);
  assert.equal(list[0].startedAt, 1000);
  assert.equal(list[1].startedAt, undefined);
  attachAction(list, { toolId: 'a', detail: 'grep' }, 1500);
  finishAction(list, 'a', true, 4000);
  assert.equal(list[0].actions[0].ms, 2500);
  list = mergeTodos(list, validateTodos(todos(['Survey', 'completed'], ['Write', 'in_progress'])).todos!, 13400);
  assert.deepEqual([list[0].startedAt, list[0].finishedAt], [1000, 13400], 'Survey took 12.4s');
  assert.equal(list[1].startedAt, 13400);
  list = mergeTodos(list, validateTodos(todos(['Survey', 'completed'], ['Write', 'completed'])).todos!, 20000);
  assert.equal(list[1].finishedAt! - list[1].startedAt!, 6600);
  list = mergeTodos(list, validateTodos(todos(['Survey', 'completed'], ['Write', 'pending'])).todos!, 21000);
  assert.deepEqual([list[1].startedAt, list[1].finishedAt], [undefined, undefined], 'reopened step is reset');
  const skipped = mergeTodos([], validateTodos(todos(['Instant', 'completed'])).todos!, 5000);
  assert.equal(skipped[0].finishedAt! - skipped[0].startedAt!, 0, 'completed without ever being in progress → 0s, never negative');
});
