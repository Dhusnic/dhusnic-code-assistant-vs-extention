import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SUMMARY_ACK, compactHistory, estimateTokens, pruneToolOutputs, shouldCompact, transcript } from '../core/compaction';
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
  const agent = new Agent({
    root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }),
    tools: () => createFsTools(), contextLimit: () => 8000, compactRatio: () => 0.5,
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
