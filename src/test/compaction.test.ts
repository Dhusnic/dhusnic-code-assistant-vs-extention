import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  EARLIER_SUMMARY_HEADING, SUMMARY_ACK, SUMMARY_SYSTEM, TURN_SUMMARY_TITLE, attachWorkingState, changedFilesFrom, cleanSummary, compactHistory, compactLatestTurn, estimateTokens,
  WORKING_STATE_TITLE, pruneToolOutputs, shouldCompact, transcript, workingState, workingStateFor,
} from '../core/compaction';
import { SUMMARY_PREFIX, historyToUi } from '../core/sessions';
import { Agent } from '../core/agent';
import { ChatMessage } from '../core/llm';
import { createFsTools } from '../core/fstools';
import { call, fakeLlm, recordingUi, text, tmpDir } from './helpers';

const u = (c: string): ChatMessage => ({ role: 'user', content: c });
const a = (c: string | null, tc?: any[]): ChatMessage => ({ role: 'assistant', content: c, tool_calls: tc });
const t = (id: string, c: string): ChatMessage => ({ role: 'tool', tool_call_id: id, content: c });
const tc = (id: string, name = 'read_file', args = '{"path":"x"}') => ({ id, type: 'function' as const, function: { name, arguments: args } });

test('estimateTokens: scales with content and counts tool-call arguments', () => {
  assert.ok(estimateTokens([u('x'.repeat(3500))]) >= 1000);
  const withCall = estimateTokens([a(null, [tc('1', 'read_file', 'y'.repeat(700))])]);
  assert.ok(withCall >= 200);
  assert.equal(estimateTokens([]), 0);
  assert.ok(estimateTokens([u('a')], 3500) >= 1000);
});

test('shouldCompact: threshold is strict and ratio-driven', () => {
  assert.equal(shouldCompact(75, 100, 0.75), false);
  assert.equal(shouldCompact(76, 100, 0.75), true);
  assert.equal(shouldCompact(51, 100, 0.5), true);
});

test('pruneToolOutputs: clips only old, large tool results and never mutates input', () => {
  const big = 'z'.repeat(5000);
  const msgs = [u('q'), a(null, [tc('1')]), t('1', big), a(null, [tc('2')]), t('2', big)];
  const out = pruneToolOutputs(msgs, 2, 1000);
  assert.ok(out[2].content!.length < 1200 && out[2].content!.includes('trimmed'));
  assert.equal(out[4].content, big, 'recent output kept');
  assert.equal(msgs[2].content, big, 'input untouched');
  assert.equal(pruneToolOutputs(msgs, 2, 10000)[2].content, big, 'small outputs untouched');
});

test('transcript: renders tool calls with results and keeps only the recent tail when huge', () => {
  const tr = transcript([u('fix bug'), a('looking', [tc('1', 'grep', '{"pattern":"x"}')]), t('1', 'file.ts:1:x')]);
  assert.match(tr, /USER: fix bug/);
  assert.match(tr, /TOOL grep\(\{"pattern":"x"\}\) -> file\.ts:1:x/);
  const long = transcript(Array.from({ length: 2000 }, (_, i) => u(`message number ${i} `.repeat(5))), 5000);
  assert.ok(long.length < 5100);
  assert.match(long, /^\.\.\.\[earlier part omitted\]/);
  assert.match(long, /message number 1999/);
});

test('compactHistory: summarizes everything before the latest turn and remaps turn indexes', async () => {
  const history = [u('t0'), a('r0'), u('t1'), a('r1'), u('t2'), a(null, [tc('c')]), t('c', 'out'), a('r2')];
  const turnStarts = [0, 2, 4];
  let seen = '';
  const r = await compactHistory(history, turnStarts, async (x) => { seen = x; return 'SUMMARY TEXT'; });
  assert.equal(r.summarized, true);
  assert.match(seen, /USER: t0/); assert.match(seen, /USER: t1/); assert.doesNotMatch(seen, /USER: t2/);
  assert.equal(r.history[0].content, `${SUMMARY_PREFIX}\nSUMMARY TEXT`);
  assert.equal(r.history[1].content, SUMMARY_ACK);
  assert.deepEqual(r.history.slice(2).map((m) => m.content), ['t2', null, 'out', 'r2']);
  assert.deepEqual(r.turnStarts, [2, 2, 2]);
  assert.equal(r.history[r.turnStarts[2]].content, 't2');
});

test('compactHistory: keeps tool_call/tool pairs of the latest turn intact', async () => {
  const history = [u('a'), a('x'), u('b'), a(null, [tc('1'), tc('2')]), t('1', 'o1'), t('2', 'o2')];
  const r = await compactHistory(history, [0, 2], async () => 'S');
  const ids = r.history.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.deepEqual(ids, ['1', '2']);
});

test('compactHistory: single turn or empty summary leaves history alone', async () => {
  const h = [u('only'), a('r')];
  assert.equal((await compactHistory(h, [0], async () => 'S')).summarized, false);
  assert.equal((await compactHistory([u('a'), a('b'), u('c')], [0, 2], async () => '   ')).summarized, false);
});

test('historyToUi: summary pair renders as a single note, not raw messages', () => {
  const r = [u(`${SUMMARY_PREFIX}\nblah`), a(SUMMARY_ACK), u('next'), a('ok')];
  const items = historyToUi(r, [2, 2]);
  assert.deepEqual(items.map((i) => i.type), ['assistant', 'user', 'assistant']);
  assert.match((items[0] as any).text, /summarized/);
});

function agentWith(llm: ReturnType<typeof fakeLlm>, limit: number, ratio = 0.75) {
  return new Agent({
    root: '.', llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }),
    tools: () => createFsTools(), contextLimit: () => limit, compactRatio: () => ratio,
  });
}
const OPTS = { mode: 'ask', effort: 'medium', model: 'm' } as const;
/** The system prompt, memory and tool definitions of the agent's latest request, as the compaction threshold counts them. */
const overheadOf = (agent: Agent): number => {
  const o = agent.lastContext;
  return o ? o.system + o.memory + o.tools + o.mcpTools + o.agentTools : 0;
};
const isSummarizerCall = (msgs: any[]) => msgs[0].role === 'system' && /summarize a conversation/i.test(msgs[0].content);

test('agent: below the threshold nothing is compacted and usage is reported', async () => {
  const llm = fakeLlm([text('hi')]);
  const ui = recordingUi(); const usage: number[][] = []; ui.usage = (x, y) => usage.push([x, y]);
  await agentWith(llm, 100000).send('hello', OPTS, ui);
  assert.equal(llm.calls.length, 1);
  assert.ok(usage.length >= 1 && usage.at(-1)![1] === 100000);
});

test('agent: auto-compaction summarizes old turns and the next request carries the summary', async () => {
  const llm = fakeLlm([
    text('a'.repeat(3000)),                         // turn 1 answer (large)
    (m) => (isSummarizerCall(m) ? text('THE SUMMARY') : text('should not happen')),
    text('final answer'),
  ]);
  const agent = agentWith(llm, 1500, 0.5);
  const ui = recordingUi();
  await agent.send('first question', OPTS, ui);
  await agent.send('second question', OPTS, ui);
  const summarizer = llm.calls.find(isSummarizerCall)!;
  assert.ok(summarizer, 'a summarizer call happened');
  assert.deepEqual(summarizer.slice(1).map((m: any) => m.role), ['user'], 'summarizer gets a single transcript message and no tools context');
  const last = llm.calls.at(-1)!;
  assert.ok(last.some((m: any) => typeof m.content === 'string' && m.content.includes('THE SUMMARY')));
  assert.ok(last.some((m: any) => m.content === 'second question'), 'latest turn kept verbatim');
  assert.ok(!last.some((m: any) => m.content === 'first question'), 'old turn removed');
  assert.ok(ui.events.some((e) => e.startsWith('info:Conversation compacted')));
  assert.equal(agent.turnCount, 2);
});

test('agent: summarizer failure degrades gracefully to trimming', async () => {
  let n = 0;
  const llm = { calls: [] as any[], fn: (async (_c: any, m: any[]) => {
    n++;
    if (isSummarizerCall(m)) { throw new Error('boom'); }
    return text('x'.repeat(3000));
  }) as any };
  const agent = agentWith(llm as any, 1500, 0.5);
  const ui = recordingUi();
  await agent.send('q1', OPTS, ui);
  await agent.send('q2', OPTS, ui);
  assert.ok(ui.events.some((e) => e.includes('Could not summarize')));
  assert.ok(n >= 3);
  assert.equal(agent.history.filter((m) => m.role === 'user').length, 2, 'no data loss besides trimmed tool output');
});

test('agent: old bulky tool output is trimmed before resorting to a summary', async () => {
  const root = await tmpDir();
  const fs = await import('fs/promises'); const path = await import('path');
  await fs.writeFile(path.join(root, 'big.txt'), 'line of text\n'.repeat(1500));
  const llm = fakeLlm([
    call('read_file', { path: 'big.txt' }, 'r1'), call('list_dir', { path: '.' }, 'r2'), call('list_dir', { path: '.' }, 'r3'),
    call('list_dir', { path: '.' }, 'r4'), call('list_dir', { path: '.' }, 'r5'), text('done'),
  ]);
  // 8000 tokens for the messages, on top of whatever the system prompt and tools measure.
  const agent: Agent = new Agent({
    root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }),
    tools: () => createFsTools(), contextLimit: () => 8000 + 2 * overheadOf(agent), compactRatio: () => 0.5,
  });
  await agent.send('go', OPTS, recordingUi());
  assert.ok(!llm.calls.some(isSummarizerCall), 'no summarizer call needed');
  const first = agent.history.find((m) => m.role === 'tool' && m.tool_call_id === 'r1')!;
  assert.match(first.content!, /trimmed/);
});

test('agent: manual compact(force) works, reports, and is a no-op with a single turn', async () => {
  const llm = fakeLlm([text('A'), (m) => (isSummarizerCall(m) ? text('S') : text('B')), text('C')]);
  const agent = agentWith(llm, 100000);
  const ui = recordingUi();
  await agent.send('one', OPTS, ui);
  assert.equal(await agent.compact(OPTS, ui, true), false, 'single turn: nothing to summarize');
  await agent.send('two', OPTS, ui);
  await agent.compact(OPTS, ui, true);
  assert.ok(agent.history[0].content!.startsWith(SUMMARY_PREFIX));
  assert.equal(agent.history.at(-1)!.content, 'B');
});

test('agent: compact requested mid-turn runs before the next model call of that turn', async () => {
  let agent!: Agent;
  const llm = fakeLlm([
    text('A'),
    () => { agent.requestCompact(); return call('list_dir', { path: '.' }, 'c1'); },
    (m) => (isSummarizerCall(m) ? text('S') : text('not the summarizer')),
    text('done'),
  ]);
  agent = agentWith(llm, 100000);
  const ui = recordingUi();
  await agent.send('one', OPTS, ui);
  await agent.send('two', OPTS, ui);
  assert.ok(llm.calls.some(isSummarizerCall), 'the turn compacted itself');
  assert.ok(agent.history[0].content!.startsWith(SUMMARY_PREFIX));
  assert.equal(agent.history.at(-1)!.content, 'done');
});

test('agent: rewind after compaction lands on the summary instead of corrupting history', async () => {
  const llm = fakeLlm([text('A'), text('B'), (m) => (isSummarizerCall(m) ? text('S') : text('x')), text('C')]);
  const agent = agentWith(llm, 100000);
  const ui = recordingUi();
  await agent.send('one', OPTS, ui); await agent.send('two', OPTS, ui); await agent.send('three', OPTS, ui);
  await agent.compact(OPTS, ui, true);
  await agent.rewind(1);
  assert.equal(agent.turnCount, 1);
  assert.equal(agent.history.length, 2);
  assert.ok(agent.history[0].content!.startsWith(SUMMARY_PREFIX));
});

/* ------------------------------------------------------------------ head+tail pruning and working state */

test('pruneToolOutputs: keeps the head and the tail of old output, and does not clip twice', () => {
  const big = `HEAD${'m'.repeat(5000)}TAIL-RESULT`;
  const out = pruneToolOutputs([u('q'), a(null, [tc('1')]), t('1', big), u('next')], 1, 1500);
  const c = out[2].content!;
  assert.match(c, /^HEAD/);
  assert.match(c, /TAIL-RESULT$/);
  assert.match(c, /\[\d+ chars of old tool output trimmed to save context\]/);
  assert.ok(c.startsWith(`HEAD${'m'.repeat(996)}\n`), 'head is two thirds of the budget');
  assert.ok(c.length < 1600);
  assert.equal(pruneToolOutputs(out, 1, 1500)[2].content, c, 'already clipped output is left alone');
});

test('workingState: lists changed files with counts, the task list, check results and the request verbatim', () => {
  const s = workingState({
    changed: [{ path: 'src/a.ts', added: 12, removed: 3 }, { path: 'gen/out.js' }, { path: 'src/new.ts', added: 40, removed: 0, rewritten: true }],
    todos: [{ content: 'Add parser', status: 'completed' }, { content: 'Wire it up', status: 'in_progress' }, { content: 'Write tests', status: 'pending' }],
    checks: [{ label: 'npm run lint', ok: true }, { label: 'npm test', ok: false }],
    request: 'Rename `fooBar` to `bazQux` in src/a.ts, but do NOT touch the public API.',
  });
  assert.match(s, /^## Working state/);
  assert.match(s, /Files changed in this session \(3\):\n- src\/a\.ts \(\+12 -3\)\n- gen\/out\.js\n- src\/new\.ts \(\+40 -0, rewritten\)/);
  assert.match(s, /Task list:\n- \[x\] Add parser\n- \[>\] Wire it up\n- \[ \] Write tests/);
  assert.match(s, /Checks after the last change: pass npm run lint; FAIL npm test/);
  assert.match(s, /Latest user request \(verbatim\):\nRename `fooBar` to `bazQux` in src\/a\.ts, but do NOT touch the public API\.$/);
  const empty = workingState({ changed: [], checks: [] });
  assert.match(empty, /Files changed in this session \(0\):\n- none/);
  assert.match(empty, /none ran yet/);
  assert.doesNotMatch(empty, /Task list|Latest user request/);
  assert.ok(workingState({ changed: [], checks: [], request: 'x'.repeat(5000) }).length < 1800, 'request is clipped');
});

test('changedFilesFrom: counts lines from successful edit calls, merges by path and carries earlier summaries forward', () => {
  const edit = (id: string, name: string, args: object) => tc(id, name, JSON.stringify(args));
  const history: ChatMessage[] = [
    u(`${SUMMARY_PREFIX}\nearlier work\n\n${workingState({ changed: [{ path: 'old.ts', added: 5, removed: 1 }, { path: 'src/a.ts', added: 1, removed: 1 }], checks: [] })}`),
    a(SUMMARY_ACK),
    u('go'),
    a(null, [edit('w', 'write_file', { path: 'src/new.ts', content: 'a\nb\nc\n' }), edit('e', 'edit_file', { path: './src/a.ts', old_string: 'x', new_string: 'y\nz' })]),
    t('w', 'Wrote src/new.ts'), t('e', 'Edited src/a.ts'),
    a(null, [
      edit('m', 'multi_edit', { path: 'src/a.ts', edits: [{ old_string: 'p\nq', new_string: 'r' }, { old_string: 's', new_string: 't' }] }),
      edit('bad', 'edit_file', { path: 'src/fail.ts', old_string: 'x', new_string: 'y' }),
      edit('r', 'read_file', { path: 'src/read.ts' }),
    ]),
    t('m', 'Edited src/a.ts (2 changes)'), t('bad', 'ERROR: old_string not found'), t('r', 'contents'),
  ];
  const isEdit = (n: string) => ['write_file', 'edit_file', 'multi_edit'].includes(n);
  assert.deepEqual(changedFilesFrom(history, isEdit, ['gen/out.js', 'src/a.ts']), [
    { path: 'old.ts', added: 5, removed: 1 },
    { path: 'src/a.ts', added: 1 + 2 + 2, removed: 1 + 1 + 3 },
    { path: 'src/new.ts', added: 3, removed: 0, rewritten: true },
    { path: 'gen/out.js' },
  ]);
});

test('workingStateFor: a summary counts only the summarized part; the latest request comes from the latest turn', () => {
  const history: ChatMessage[] = [
    u('first'), a(null, [tc('e1', 'edit_file', JSON.stringify({ path: 'a.ts', old_string: 'x', new_string: 'y' }))]), t('e1', 'Edited a.ts'), a('ok'),
    { role: 'user', content: 'second with an expanded attachment', display: 'second request' },
    a(null, [tc('e2', 'edit_file', JSON.stringify({ path: 'b.ts', old_string: 'x', new_string: 'y' }))]), t('e2', 'Edited b.ts'),
  ];
  const isEdit = (n: string) => n === 'edit_file';
  const forSummary = workingStateFor(history, [0, 4], isEdit, { changed: ['b.ts'], checks: [] }, true);
  assert.match(forSummary, /- a\.ts \(\+1 -1\)\n- b\.ts\n/);
  assert.match(forSummary, /Latest user request \(verbatim\):\nsecond request$/);
  assert.match(workingStateFor(history, [0, 4], isEdit, { changed: [], checks: [] }), /- b\.ts \(\+1 -1\)/);
});

test('attachWorkingState: goes into the latest user or tool message and replaces an earlier block', () => {
  const h = [u('q'), a(null, [tc('1')]), t('1', 'result')];
  const once = attachWorkingState(h, '## Working state (x)\nA');
  assert.match(once[2].content!, /^result\n\n<system-reminder>\n## Working state \(x\)\nA\n<\/system-reminder>$/);
  assert.equal(h[2].content, 'result', 'input untouched');
  const twice = attachWorkingState([...once, u('more')], '## Working state (x)\nB');
  assert.equal(twice[2].content, 'result');
  assert.match(twice[3].content!, /B\n<\/system-reminder>$/);
  assert.deepEqual(attachWorkingState([u('q'), a('answer')], 'S').map((m) => m.content), ['q', 'answer'], 'not after the model\'s own reply');
});

test('SUMMARY_SYSTEM: allows ~900 words and asks for identifiers, paths, errors and constraints verbatim', () => {
  assert.match(SUMMARY_SYSTEM, /900 words/);
  assert.match(SUMMARY_SYSTEM, /verbatim/);
  assert.match(SUMMARY_SYSTEM, /identifiers/);
  assert.match(SUMMARY_SYSTEM, /file paths/);
  assert.match(SUMMARY_SYSTEM, /error messages/);
});

test('agent: the summary is followed by the working state (changed files, tasks, checks, latest request)', async () => {
  const root = await tmpDir();
  const llm = fakeLlm([
    call('todo_write', { todos: [{ content: 'Create util', status: 'completed' }, { content: 'Use it in main', status: 'in_progress' }] }, 't1'),
    call('write_file', { path: 'src/util.ts', content: 'export const one = 1;\nexport const two = 2;\n' }, 'w1'),
    call('edit_file', { path: 'src/util.ts', old_string: 'export const two = 2;', new_string: 'export const two = 2;\nexport const three = 3;' }, 'e1'),
    text('done with step one'),
    text('noted'),
    (m) => (isSummarizerCall(m) ? text('SUMMARY OF WORK') : text('unexpected')),
  ]);
  const agent = new Agent({
    root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }),
    tools: () => createFsTools(), contextLimit: () => 100000,
  });
  const ui = recordingUi();
  await agent.send('create util', { ...OPTS, mode: 'auto' }, ui);
  await agent.send('now use `three` in main.ts; keep exports named', { ...OPTS, mode: 'auto' }, ui);
  await agent.compact(OPTS, ui, true);
  const summarizer = llm.calls.find(isSummarizerCall)!;
  assert.match(summarizer[0].content, /900 words/);
  const head = agent.history[0].content!;
  assert.ok(head.startsWith(`${SUMMARY_PREFIX}\nSUMMARY OF WORK\n\n## Working state`), head);
  assert.match(head, /- src\/util\.ts \(\+4 -1, rewritten\)/);
  assert.match(head, /- \[x\] Create util\n- \[>\] Use it in main/);
  assert.match(head, /Latest user request \(verbatim\):\nnow use `three` in main\.ts; keep exports named/);
  assert.match(head, /Checks after the last change: /);
});

test('agent: when summarizing fails, the working state is attached to the latest message instead', async () => {
  const llm = {
    fn: (async (_c: any, m: any[]) => {
      if (isSummarizerCall(m)) { throw new Error('gateway down'); }
      return text('ok');
    }) as any,
  };
  const agent = agentWith(llm as any, 100000);
  const ui = recordingUi();
  await agent.send('one', OPTS, ui);
  await agent.send('two', OPTS, ui);
  agent.history.push(u('three'));
  agent.turnStarts.push(agent.history.length - 1);
  await agent.compact(OPTS, ui, true);
  assert.ok(ui.events.some((e) => e.includes('Could not summarize')));
  assert.match(agent.history.at(-1)!.content!, /^three\n\n<system-reminder>\n## Working state[^]*Latest user request \(verbatim\):\nthree\n<\/system-reminder>$/);
});

/* ------------------------------------------------------------------ one long turn, and the prompt/tool overhead */

test('compactLatestTurn: summarizes the earlier steps of the turn, keeps the request and the latest steps verbatim', async () => {
  const history: ChatMessage[] = [
    u('old'), a('r0'),
    { role: 'user', content: 'do the big job\n[expanded attachment]', display: 'do the big job' },
    a(null, [tc('1')]), t('1', 'o1'), a(null, [tc('2'), tc('3')]), t('2', 'o2'), t('3', 'o3'), a(null, [tc('4')]), t('4', 'o4'), a(null, [tc('5')]), t('5', 'o5'),
  ];
  let seen = '';
  const carry = { call: tc('carry', 'todo_write', '{"todos":[]}'), result: 'tasks' };
  const r = await compactLatestTurn(history, [0, 2], async (x) => { seen = x; return 'STEPS SUMMARY'; }, 3, carry, (cut) => `${WORKING_STATE_TITLE}\ncut ${cut}`);
  assert.equal(r.summarized, true);
  assert.deepEqual(r.turnStarts, [0, 2]);
  assert.match(seen, /^USER REQUEST: do the big job/);
  assert.match(seen, /-> o1/); assert.match(seen, /-> o3/); assert.doesNotMatch(seen, /-> o4/);
  const req = r.history[2];
  assert.equal(req.display, 'do the big job', 'the UI still shows what the user typed');
  assert.ok(req.content!.startsWith('do the big job\n[expanded attachment]\n\n<system-reminder>\n'));
  assert.ok(req.content!.endsWith(`${TURN_SUMMARY_TITLE}\nSTEPS SUMMARY\n\n${WORKING_STATE_TITLE}\ncut 8\n</system-reminder>`), req.content!);
  assert.deepEqual(r.history.slice(3).map((m) => m.tool_call_id ?? m.role), ['assistant', 'carry', 'assistant', '4', 'assistant', '5'], 'cut at a model step, carry after the request');
  assert.deepEqual(r.history.slice(0, 2), history.slice(0, 2), 'earlier turns untouched');

  // A second pass folds the first summary in instead of nesting it.
  let again = '';
  const r2 = await compactLatestTurn(r.history, r.turnStarts, async (x) => { again = x; return 'NEWER'; }, 2);
  assert.match(again, /EARLIER STEPS \(already summarized\):\nSTEPS SUMMARY\nLATER STEPS:/);
  assert.equal(r2.history[2].content!.split('<system-reminder>').length, 2, 'one reminder in the request');
  assert.match(r2.history[2].content!, /\nNEWER\n<\/system-reminder>$/);
});

test('compactLatestTurn: nothing to do when the turn is short or the summary is empty', async () => {
  assert.equal((await compactLatestTurn([u('q'), a(null, [tc('1')]), t('1', 'o')], [0], async () => 'S', 2)).summarized, false);
  const h = [u('q'), a(null, [tc('1')]), t('1', 'o'), a(null, [tc('2')]), t('2', 'o'), a('done')];
  assert.equal((await compactLatestTurn(h, [0], async () => '  ', 2)).summarized, false);
  assert.equal((await compactLatestTurn(h, [0], async () => 'S', 2)).summarized, true);
});

test('changedFilesFrom: reads only the latest Working state block, which already includes the earlier ones', () => {
  const block = (n: number) => workingState({ changed: [{ path: 'a.ts', added: n, removed: 0 }], checks: [] });
  const history: ChatMessage[] = [
    u(`${SUMMARY_PREFIX}\nS\n\n${block(2)}`), a(SUMMARY_ACK),
    u(`req\n\n<system-reminder>\n${TURN_SUMMARY_TITLE}\nT\n\n${block(5)}\n</system-reminder>`),
  ];
  assert.deepEqual(changedFilesFrom(history, () => true), [{ path: 'a.ts', added: 5, removed: 0 }]);
});

test('agent: one long turn is compacted by summarizing its own earlier steps', async () => {
  const root = await tmpDir();
  const fs = await import('fs/promises'); const path = await import('path');
  await fs.writeFile(path.join(root, 'f.txt'), 'some text\n'.repeat(120));
  // The summarizer may be asked at any step: it answers whenever asked, and the agent reads the file 10 times.
  let step = 0;
  const reply = (m: any[]) => (isSummarizerCall(m) ? text('TURN SUMMARY') : step < 10 ? call('read_file', { path: 'f.txt' }, `r${step++}`) : text('done'));
  const llm = fakeLlm(Array.from({ length: 20 }, () => reply));
  // Room for about 2000 tokens of messages on top of the system prompt and tools.
  const agent: Agent = new Agent({
    root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }),
    tools: () => createFsTools(), contextLimit: () => Math.ceil((overheadOf(agent) + 2000) / 0.75), compactRatio: () => 0.75,
  });
  const ui = recordingUi();
  await agent.send('read it many times', OPTS, ui);
  assert.ok(llm.calls.some(isSummarizerCall), `the turn was summarized: ${ui.events.join(' | ')}`);
  const req = agent.history.find((m) => m.role === 'user')!;
  assert.equal(req.display ?? req.content, 'read it many times');
  assert.match(req.content!, /TURN SUMMARY/);
  assert.equal(agent.turnCount, 1);
  const ids = new Set(agent.history.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []));
  assert.ok(agent.history.filter((m) => m.role === 'tool').every((m) => ids.has(m.tool_call_id!)), 'every tool result follows its call');
});

test('agent: the compaction threshold counts the system prompt and tool definitions', async () => {
  const llm = fakeLlm([text('A'), text('B'), (m) => (isSummarizerCall(m) ? text('S') : text('x'))]);
  const agent = agentWith(llm, 100000);
  const ui = recordingUi();
  await agent.send('one', OPTS, ui); await agent.send('two', OPTS, ui);
  agent.lastContext = { system: 1000, memory: 0, tools: 0, mcpTools: 0, agentTools: 0, toolCount: 0, mcpCount: 0 };
  assert.equal(await agent.compact(OPTS, ui), false, 'small overhead: under the threshold');
  agent.lastContext = { system: 70000, memory: 0, tools: 6000, mcpTools: 0, agentTools: 0, toolCount: 0, mcpCount: 0 };
  await agent.compact(OPTS, ui);
  assert.ok(llm.calls.some(isSummarizerCall), 'messages alone are tiny, but the whole request is over 75%');
  assert.ok(agent.history[0].content!.startsWith(SUMMARY_PREFIX));
});

/* ------------------------------------------------------------------ repeated compaction keeps the earlier summary */

test('transcript: an earlier summary goes first and whole, without its Working state, and is never dropped', () => {
  const narrative = `GOAL: migrate auth. CONSTRAINT: do not touch the public API. ${'detail '.repeat(1200)}END-OF-SUMMARY`;
  const summary = u(`${SUMMARY_PREFIX}\n${narrative}\n\n${workingState({ changed: [{ path: 'a.ts', added: 1, removed: 0 }], checks: [] })}`);
  const later = Array.from({ length: 400 }, (_, i) => u(`later message ${i} `.repeat(20)));
  const tr = transcript([summary, a(SUMMARY_ACK), ...later], 5000);
  assert.ok(tr.startsWith(`${EARLIER_SUMMARY_HEADING}\nGOAL: migrate auth. CONSTRAINT: do not touch the public API.`));
  assert.match(tr, /END-OF-SUMMARY\n\nCONVERSATION SINCE THAT SUMMARY:\n\.\.\.\[earlier part omitted\]/, 'whole, though over 4000 chars and the oldest part');
  assert.doesNotMatch(tr, /## Working state/, 'the state block is rebuilt by code, not re-summarized');
  assert.match(tr, /later message 399/);
  assert.doesNotMatch(transcript([u('q'), a('r')]), /EARLIER SUMMARY/);
});

test('transcript: a request keeps the summary of its own earlier steps whole', () => {
  const steps = `STEP-START ${'s'.repeat(5000)} STEP-END`;
  const tr = transcript([u(`do it\n\n<system-reminder>\n${TURN_SUMMARY_TITLE}\n${steps}\n\n${WORKING_STATE_TITLE}\nx\n</system-reminder>`), a('ok')]);
  assert.match(tr, /^USER: do it\nEARLIER STEPS OF THIS REQUEST \(summarized\): STEP-START s+ STEP-END\nASSISTANT: ok$/);
});

test('compactHistory: a second compaction hands the first summary to the summarizer in full', async () => {
  const first = await compactHistory([u('t0 keep exports named'), a('r0'), u('t1'), a('r1')], [0, 2], async () => `FIRST ${'x'.repeat(6000)} TAIL`);
  const history = [...first.history, a('r1b'), u('t2'), a('r2')];
  let seen = '';
  await compactHistory(history, [...first.turnStarts, history.length - 2], async (x) => { seen = x; return 'SECOND'; });
  assert.match(seen, /^EARLIER SUMMARY[^\n]*\nFIRST x{6000} TAIL\n\nCONVERSATION SINCE THAT SUMMARY:\nUSER: t1\nASSISTANT: r1\nASSISTANT: r1b$/, 'the acknowledgement is left out');
  assert.match(SUMMARY_SYSTEM, /carry its goals, constraints and decisions forward/);
});

test('cleanSummary: drops thinking blocks; an unclosed one leaves nothing', () => {
  assert.equal(cleanSummary('<think>planning</think>\nThe summary.'), 'The summary.');
  assert.equal(cleanSummary('<think>still thinking when the cap hit'), '');
  assert.equal(cleanSummary('  plain  '), 'plain');
});

test('agent: a summary cut off by the token cap is retried with a larger cap, then refused', async () => {
  const cut = (content: string) => ({ content, toolCalls: [], finishReason: 'length' });
  const caps: number[] = [];
  const run = async (answers: any[]) => {
    let k = 0;
    const llm = { fn: (async (cfg: any, m: any[]) => {
      if (!isSummarizerCall(m)) { return text('ok'); }
      caps.push(cfg.maxTokens);
      return answers[k++];
    }) as any };
    const agent = agentWith(llm as any, 100000);
    const ui = recordingUi();
    await agent.send('one', OPTS, ui); await agent.send('two', OPTS, ui);
    await agent.compact(OPTS, ui, true);
    return { agent, ui };
  };
  const ok = await run([cut('half a summ'), text('<think>hmm</think>FULL SUMMARY')]);
  assert.deepEqual(caps, [2048, 4096]);
  assert.equal(ok.agent.history[0].content!.split('\n')[1], 'FULL SUMMARY');
  const bad = await run([cut('half'), cut('still half')]);
  assert.ok(!bad.agent.history[0].content!.startsWith(SUMMARY_PREFIX), 'a cut-off summary is not accepted');
  assert.ok(bad.ui.events.some((e) => e.includes('Could not summarize the conversation (the summary was cut off)')));
});
