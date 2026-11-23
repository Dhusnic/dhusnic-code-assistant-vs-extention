import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Agent } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { ChatMessage, LlmFn, StreamResult } from '../core/llm';
import { AgentSettings, SessionManager, UiEvent } from '../core/runtime';
import { SessionStore2 } from '../core/store';
import { tmpDir } from './helpers';

type Script = (msgs: ChatMessage[]) => StreamResult | Promise<StreamResult>;
const text = (content: string): StreamResult => ({ content, toolCalls: [] });
const call = (name: string, args: object, id: string): StreamResult => ({ content: '', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastUser = (msgs: ChatMessage[]) => [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
const answered = (msgs: ChatMessage[]) => msgs[msgs.length - 1]?.role === 'tool';

interface Harness { mgr: SessionManager; store: SessionStore2; root: string; events: Array<[string, string, UiEvent]>; changes: { n: number }; active: { now: number; peak: number } }

/** A manager whose LLM is a function of the conversation, with live concurrency tracking. */
async function harness(script: Script, opts: { max?: number; storeDir?: string; root?: string; defaults?: Partial<AgentSettings> } = {}): Promise<Harness> {
  const root = opts.root ?? await tmpDir('rt-root-');
  const store = new SessionStore2(opts.storeDir ?? await tmpDir('rt-store-'));
  const active = { now: 0, peak: 0 };
  const llm: LlmFn = async (_c, msgs, _t, onToken, signal) => {
    active.now++; active.peak = Math.max(active.peak, active.now);
    try {
      const res = await script(msgs);
      if (signal.aborted) { throw new Error('Cancelled'); }
      if (res.content) { onToken(res.content); }
      return res;
    } finally { active.now--; }
  };
  const events: Array<[string, string, UiEvent]> = [];
  const changes = { n: 0 };
  let n = 0;
  const mgr = new SessionManager({
    store,
    createAgent: () => new Agent({ root, llm, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => createFsTools() }),
    defaults: () => ({ mode: 'auto', effort: 'medium', model: 'm', ...opts.defaults }),
    onEvent: (s, a, e) => events.push([s, a, e]),
    onChange: () => { changes.n++; },
    maxConcurrent: () => opts.max ?? 4,
    newSessionId: () => `s${++n}`,
    saveThrottleMs: 20,
  });
  return { mgr, store, root, events, changes, active };
}

const slowEcho: Script = async (msgs) => { await sleep(80); return text(`echo: ${lastUser(msgs)}`); };

test('two sessions × two agents run truly in parallel with independent histories', async () => {
  const h = await harness(slowEcho);
  const s1 = h.mgr.newSession(), s2 = h.mgr.newSession();
  const a12 = h.mgr.addAgent(s1.id), a22 = h.mgr.addAgent(s2.id);
  const t0 = Date.now();
  await Promise.all([
    h.mgr.send(s1.id, 'a1', 'one'), h.mgr.send(s1.id, a12.id, 'two'),
    h.mgr.send(s2.id, 'a1', 'three'), h.mgr.send(s2.id, a22.id, 'four'),
  ]);
  assert.equal(h.active.peak, 4);
  // peak === 4 is the proof that all four ran at once; a wall-clock bound only measured how busy the machine was.
  void t0;
  assert.equal(h.mgr.agent(s1.id, a12.id).agent.history.at(-1)!.content, 'echo: two');
  assert.equal(h.mgr.agent(s2.id, 'a1').agent.history.at(-1)!.content, 'echo: three');
  assert.ok(h.mgr.snapshot().every((s) => s.agents.every((a) => a.status === 'idle')));
});

test('the global concurrency limit queues extra agents and runs them as slots free up', async () => {
  const h = await harness(slowEcho, { max: 2 });
  const s = h.mgr.newSession();
  const ids = ['a1', h.mgr.addAgent(s.id).id, h.mgr.addAgent(s.id).id, h.mgr.addAgent(s.id).id];
  const runs = ids.map((a, i) => h.mgr.send(s.id, a, `m${i}`));
  await sleep(10);
  const statuses = h.mgr.snapshot()[0].agents.map((a) => a.status).sort();
  assert.deepEqual(statuses, ['queued', 'queued', 'running', 'running']);
  assert.match(h.mgr.snapshot()[0].agents.find((a) => a.status === 'queued')!.activity, /Queued: 2 agents already running \(limit 2\)/);
  await Promise.all(runs);
  assert.equal(h.active.peak, 2);
  assert.equal(h.mgr.running, 0);
  assert.ok(ids.every((a, i) => h.mgr.agent(s.id, a).agent.history.at(-1)!.content === `echo: m${i}`));
});

test('stopping a queued agent removes its message and restores the input; others keep going', async () => {
  const h = await harness(slowEcho, { max: 1 });
  const s = h.mgr.newSession();
  const b = h.mgr.addAgent(s.id);
  const first = h.mgr.send(s.id, 'a1', 'runs');
  const second = h.mgr.send(s.id, b.id, 'never runs');
  await sleep(5);
  h.mgr.stop(s.id, b.id);
  await second;
  const rew = h.events.find(([, a, e]) => a === b.id && e.type === 'rewound')!;
  assert.equal(rew[2].note, 'Cancelled before it started.');
  assert.equal(h.mgr.agent(s.id, b.id).log.length, 0);
  assert.equal(h.mgr.agent(s.id, b.id).agent.turnCount, 0);
  assert.equal(h.mgr.agent(s.id, b.id).status, 'idle');
  await first;
  assert.equal(h.mgr.agent(s.id, 'a1').agent.history.at(-1)!.content, 'echo: runs');
});

test('sending to a busy agent is refused with a helpful message', async () => {
  const h = await harness(slowEcho);
  const s = h.mgr.newSession();
  const p = h.mgr.send(s.id, 'a1', 'x');
  await assert.rejects(h.mgr.send(s.id, 'a1', 'y'), /already working/);
  await p;
});

test('each agent has its own approvals; waiting status and activity are visible; approving applies the edit', async () => {
  const h = await harness((msgs) => (answered(msgs) ? text('done') : call('write_file', { path: `${lastUser(msgs)}.txt`, content: lastUser(msgs) }, `w-${lastUser(msgs)}`)), { defaults: { mode: 'ask' } });
  const s = h.mgr.newSession();
  const b = h.mgr.addAgent(s.id);
  const r1 = h.mgr.send(s.id, 'a1', 'alpha');
  const r2 = h.mgr.send(s.id, b.id, 'beta');
  // Wait for both prompts rather than a fixed delay: next to 1000 parallel tests 30 ms was sometimes not enough.
  for (let i = 0; i < 300 && h.mgr.snapshot()[0].agents.some((a) => a.status !== 'waiting'); i++) { await sleep(10); }
  const view = h.mgr.snapshot()[0].agents;
  assert.deepEqual(view.map((a) => a.status), ['waiting', 'waiting']);
  assert.match(view[0].activity, /Waiting for approval: Write alpha\.txt/);
  assert.equal(h.mgr.resolveApproval(s.id, 'a1', 'w-alpha', true), true);
  assert.equal(h.mgr.resolveApproval(s.id, 'a1', 'w-alpha', true), false, 'already answered');
  h.mgr.resolveApproval(s.id, b.id, 'w-beta', false);
  await Promise.all([r1, r2]);
  assert.equal(await fs.readFile(path.join(h.root, 'alpha.txt'), 'utf8'), 'alpha');
  await assert.rejects(fs.stat(path.join(h.root, 'beta.txt')));
  const done = h.mgr.agent(s.id, 'a1').log.find((e) => e.type === 'approvalDone')!;
  assert.equal(done.label, 'allowed');
  assert.equal(h.mgr.agent(s.id, b.id).log.find((e) => e.type === 'approvalDone')!.label, 'denied');
  assert.ok(h.mgr.agent(s.id, 'a1').log.find((e) => e.type === 'approve')!.diff, 'diff is part of the replayable transcript');
});

test('stopping an agent that waits for approval resolves the prompt and ends cleanly', async () => {
  const h = await harness(() => call('run_command', { command: 'echo hi' }, 'c1'), { defaults: { mode: 'ask' } });
  const s = h.mgr.newSession();
  const r = h.mgr.send(s.id, 'a1', 'go');
  await sleep(20);
  assert.equal(h.mgr.agent(s.id, 'a1').status, 'waiting');
  h.mgr.stop(s.id, 'a1');
  await r;
  const rt = h.mgr.agent(s.id, 'a1');
  assert.equal(rt.status, 'idle');
  assert.equal(rt.pending.size, 0);
  assert.ok(rt.log.some((e) => e.type === 'approvalDone' && e.label === 'cancelled'));
  assert.ok(rt.log.some((e) => e.type === 'info' && e.text === 'Cancelled.'));
});

test('an LLM failure marks only that agent as errored; it recovers on the next message', async () => {
  let fail = true;
  const h = await harness(async (msgs) => { if (fail && lastUser(msgs) === 'boom') { throw new Error('gateway down'); } return text('fine'); });
  const s = h.mgr.newSession();
  const b = h.mgr.addAgent(s.id);
  await Promise.all([h.mgr.send(s.id, 'a1', 'boom'), h.mgr.send(s.id, b.id, 'ok')]);
  const v = h.mgr.snapshot()[0].agents;
  assert.equal(v[0].status, 'error'); assert.equal(v[0].error, 'gateway down');
  assert.equal(v[1].status, 'idle');
  fail = false;
  await h.mgr.send(s.id, 'a1', 'again');
  assert.equal(h.mgr.agent(s.id, 'a1').status, 'idle');
  assert.equal(h.mgr.agent(s.id, 'a1').error, undefined);
});

test('tokens are coalesced in the transcript; transient events are not stored', async () => {
  const h = await harness(async (msgs) => text(`answer to ${lastUser(msgs)}`));
  const s = h.mgr.newSession();
  await h.mgr.send(s.id, 'a1', 'q');
  const types = h.mgr.agent(s.id, 'a1').log.map((e) => e.type);
  assert.deepEqual(types, ['userMsg', 'token']);
  assert.ok(h.events.some(([, , e]) => e.type === 'start') && h.events.some(([, , e]) => e.type === 'end'));
});

test('everything is saved: a fresh manager on the same store reopens the session with all agents and transcripts', async () => {
  const storeDir = await tmpDir('rt-persist-');
  const h = await harness(slowEcho, { storeDir });
  const s = h.mgr.newSession();
  const b = h.mgr.addAgent(s.id, { mode: 'plan' }, 'Reviewer');
  await Promise.all([h.mgr.send(s.id, 'a1', 'first message'), h.mgr.send(s.id, b.id, 'review please')]);
  await h.mgr.shutdown();

  const h2 = await harness(slowEcho, { storeDir });
  const listed = await h2.store.list();
  assert.deepEqual(listed.map((x) => [x.id, x.title, x.agents, x.turns]), [[s.id, 'first message', 2, 2]]);
  const re = (await h2.mgr.open(s.id))!;
  assert.deepEqual([...re.agents.values()].map((a) => [a.id, a.name, a.settings.mode, a.status]), [['a1', 'Main', 'auto', 'idle'], [b.id, 'Reviewer', 'plan', 'idle']]);
  const t = h2.mgr.transcript(s.id, 'a1').events;
  assert.deepEqual(t.map((e) => e.type), ['userMsg', 'assistantText']);
  assert.equal(t[1].text, 'echo: first message');
  await h2.mgr.send(s.id, 'a1', 'follow-up');
  assert.equal(h2.mgr.agent(s.id, 'a1').agent.turnCount, 2, 'conversation continues');
});

test('progress is saved during a long run; a crash mid-run reopens as "interrupted" with the work so far', async () => {
  const storeDir = await tmpDir('rt-crash-');
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const h = await harness(async (msgs) => {
    if (!answered(msgs)) { return call('list_dir', { path: '.' }, 'l1'); }
    await gate;
    return text('finished');
  }, { storeDir });
  const s = h.mgr.newSession();
  const run = h.mgr.send(s.id, 'a1', 'long task');
  // Wait for the tool round itself (not a fixed time, which flakes under load), then for the throttled save (20 ms).
  for (let i = 0; i < 100 && !h.mgr.agent(s.id, 'a1').agent.history.some((m) => m.role === 'tool'); i++) { await sleep(20); }
  await sleep(150);
  const h2 = await harness(slowEcho, { storeDir });
  const re = (await h2.mgr.open(s.id))!;
  const rt = re.agents.get('a1')!;
  assert.equal(rt.status, 'interrupted');
  assert.ok(rt.agent.history.some((m) => m.role === 'tool'), 'tool round saved before the crash');
  assert.match(rt.log.at(-1)!.text, /interrupted/);
  assert.equal((await h2.store.list())[0].interrupted, true);
  release();
  await run;
});

test('activity snapshot tracks sub-agents of an agent live', async () => {
  let gateOpen!: () => void;
  const gate = new Promise<void>((r) => { gateOpen = r; });
  const h = await harness(async (msgs) => {
    if (/SUB-AGENT/.test(msgs[0].content ?? '')) {
      if (!answered(msgs)) { return call('list_dir', { path: '.' }, 'sub-l'); }
      await gate;
      return text('sub report');
    }
    return answered(msgs) ? text('parent done') : call('agent', { description: 'Scan repo', prompt: 'look around' }, 'T1');
  });
  const s = h.mgr.newSession();
  const r = h.mgr.send(s.id, 'a1', 'delegate');
  await sleep(60);
  const live = h.mgr.snapshot()[0].agents[0];
  assert.equal(live.status, 'running');
  assert.match(live.activity, /Agent \(general-purpose\): Scan repo/);
  assert.deepEqual(live.subtasks.map((t) => [t.title, t.done]), [['Scan repo', false]]);
  assert.match(live.subtasks[0].last, /List/);
  gateOpen();
  await r;
  const after = h.mgr.snapshot()[0].agents[0];
  assert.deepEqual(after.subtasks.map((t) => [t.done, t.ok]), [[true, true]]);
});

test('rewind truncates the transcript and history, and is persisted', async () => {
  const storeDir = await tmpDir('rt-rewind-');
  const h = await harness(async (msgs) => text(`r:${lastUser(msgs)}`), { storeDir });
  const s = h.mgr.newSession();
  await h.mgr.send(s.id, 'a1', 'one');
  await h.mgr.send(s.id, 'a1', 'two');
  await h.mgr.rewind(s.id, 'a1', 1);
  const rt = h.mgr.agent(s.id, 'a1');
  assert.equal(rt.agent.turnCount, 1);
  assert.deepEqual(rt.log.map((e) => e.type), ['userMsg', 'token', 'info']);
  assert.ok(h.events.some(([, , e]) => e.type === 'rewound' && e.turn === 1));
  await h.mgr.shutdown();
  const loaded = (await h.store.loadSession(s.id))!;
  assert.equal(loaded.agents[0].turnStarts.length, 1);
});

test('sub-agents can be added, renamed and removed; the main conversation cannot be removed', async () => {
  const storeDir = await tmpDir('rt-agents-');
  const h = await harness(async () => text('ok'), { storeDir });
  const s = h.mgr.newSession();
  const b = h.mgr.addAgent(s.id);
  assert.equal(b.name, 'Agent 2');
  h.mgr.rename(s.id, 'Tester', b.id);
  h.mgr.rename(s.id, 'My session');
  await h.mgr.send(s.id, b.id, 'hi');
  await assert.rejects(h.mgr.removeAgent(s.id, 'a1'), /main conversation cannot be removed/);
  await h.mgr.send(s.id, 'a1', 'main message');
  const c = h.mgr.addAgent(s.id);
  await h.mgr.removeAgent(s.id, c.id);
  await h.mgr.shutdown();
  const loaded = (await h.store.loadSession(s.id))!;
  assert.equal(loaded.meta.title, 'My session');
  assert.deepEqual(loaded.agents.map((a) => [a.id, a.name, a.role]), [['a1', 'Main', 'main'], [b.id, 'Tester', 'sub']]);
  assert.equal(h.mgr.addAgent(s.id).id, 'a3', 'ids are reused only after removal');
});

test('deleting a session stops its agents and removes it from disk; closing keeps it on disk', async () => {
  const storeDir = await tmpDir('rt-del-');
  const h = await harness(slowEcho, { storeDir });
  const s = h.mgr.newSession();
  await h.mgr.send(s.id, 'a1', 'keep me');
  const s2 = h.mgr.newSession();
  const running = h.mgr.send(s2.id, 'a1', 'delete me');
  await assert.rejects(h.mgr.close(s2.id), /Stop the running agents/);
  await h.mgr.deleteSession(s2.id);
  await running;
  await h.mgr.close(s.id);
  assert.equal(h.mgr.snapshot().length, 0);
  assert.deepEqual((await h.store.list()).map((x) => x.id), [s.id]);
});

test('empty new sessions are not written to disk until they have a message', async () => {
  const h = await harness(slowEcho);
  h.mgr.newSession();
  await h.mgr.shutdown();
  assert.deepEqual(await h.store.list(), []);
});


test('agents in one session do NOT share conversation context', async () => {
  const seen: Record<string, string[]> = {};
  const h = await harness(async (msgs) => {
    const users = msgs.filter((m) => m.role === 'user').map((m) => String(m.content));
    seen[users[0]] = users;
    return text('ok');
  });
  const s = h.mgr.newSession();
  const b = h.mgr.addAgent(s.id);
  await h.mgr.send(s.id, 'a1', 'secret for agent one');
  await h.mgr.send(s.id, b.id, 'question for agent two');
  assert.deepEqual(seen['question for agent two'], ['question for agent two'], 'agent two never sees agent one\'s messages');
});

test('fork: the new agent starts with a copy of the conversation, then both diverge independently', async () => {
  const storeDir = await tmpDir('rt-fork-');
  const prompts: string[][] = [];
  const h = await harness(async (msgs) => { prompts.push(msgs.filter((m) => m.role === 'user').map((m) => String(m.content))); return text(`r${prompts.length}`); }, { storeDir, defaults: { mode: 'plan' } });
  const s = h.mgr.newSession();
  await h.mgr.send(s.id, 'a1', 'shared background');
  const fork = h.mgr.addAgent(s.id, undefined, undefined, 'a1');
  assert.equal(fork.name, 'Main (fork)');
  assert.equal(fork.settings.mode, 'plan', 'settings copied too');
  assert.equal(fork.agent.turnCount, 1);
  assert.match(fork.log.at(-1)!.text, /Forked from Main/);
  assert.ok(fork.usage.used > 0, 'context meter reflects the copied conversation');

  await h.mgr.send(s.id, fork.id, 'only in the fork');
  await h.mgr.send(s.id, 'a1', 'only in the original');
  assert.deepEqual(prompts.at(-2), ['shared background', 'only in the fork']);
  assert.deepEqual(prompts.at(-1), ['shared background', 'only in the original'], 'the original does not see the fork\'s new messages');
  await h.mgr.rewind(s.id, fork.id, 0);
  assert.equal(h.mgr.agent(s.id, 'a1').agent.turnCount, 2, 'rewinding the fork leaves the original untouched');

  await h.mgr.shutdown();
  const loaded = (await h.store.loadSession(s.id))!;
  assert.deepEqual(loaded.agents.map((a) => a.name), ['Main', 'Main (fork)']);
});

test('fork: refuses to fork an agent that is still working', async () => {
  const h = await harness(slowEcho);
  const s = h.mgr.newSession();
  const run = h.mgr.send(s.id, 'a1', 'busy');
  assert.throws(() => h.mgr.addAgent(s.id, undefined, undefined, 'a1'), /Wait for Main to finish/);
  await run;
  assert.equal(h.mgr.addAgent(s.id, undefined, undefined, 'a1').agent.turnCount, 1);
});
