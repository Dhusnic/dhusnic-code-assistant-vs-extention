import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AGENT_TOOL, Agent, AgentGuard, DELEGATION_TOOLS } from '../core/agent';
import { BUILTIN_AGENT_TYPES, toolsForType } from '../core/agentTypes';
import { createFsTools } from '../core/fstools';
import { ChatMessage, LlmFn, StreamResult } from '../core/llm';
import { Mode } from '../core/policy';
import { SessionManager, UiEvent } from '../core/runtime';
import { SessionStore2 } from '../core/store';
import { tmpDir } from './helpers';

/** A mode switched while a chat runs applies from that moment on: to new calls, waiting approvals and sub-agents. */
type Brain = (who: 'main' | 'sub', msgs: ChatMessage[]) => StreamResult | Promise<StreamResult>;
const text = (content: string): StreamResult => ({ content, toolCalls: [] });
const call = (name: string, args: object, id: string): StreamResult => ({ content: '', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toolMsgs = (m: ChatMessage[]) => m.filter((x) => x.role === 'tool').map((x) => String(x.content));
const lastUser = (m: ChatMessage[]) => String([...m].reverse().find((x) => x.role === 'user')?.content ?? '');
const until = async (cond: () => boolean) => { for (let i = 0; i < 300 && !cond(); i++) { await sleep(10); } assert.ok(cond(), 'timed out'); };

/** Rules like the real guard's: "secret.txt" is denied and "guarded.txt" always asks, whatever the mode. */
const rules: AgentGuard = {
  decide: (req) => {
    const p = String(req.args?.path ?? '');
    if (p.endsWith('secret.txt')) { return { effect: 'deny', reason: 'Edit(secret.txt)' }; }
    if (p.endsWith('guarded.txt')) { return { effect: 'ask', reason: 'agent permission settings are protected' }; }
    return {};
  },
};

async function harness(brain: Brain, mode: Mode) {
  const root = await tmpDir('lm-root-');
  const events: Array<[string, UiEvent]> = [];
  let n = 0;
  const mgr: SessionManager = new SessionManager({
    store: new SessionStore2(await tmpDir('lm-store-')), agentTypes: () => BUILTIN_AGENT_TYPES, newSessionId: () => `s${++n}`, saveThrottleMs: 10,
    defaults: () => ({ mode, effort: 'medium', model: 'm' }),
    onEvent: (_s, a, e) => events.push([a, e]),
    createAgent: (sid, aid, spec) => {
      const sub = spec?.role === 'sub' ? spec.type : undefined;
      const llm: LlmFn = async (_c, msgs, _tools, onToken, signal) => {
        const r = await brain(sub ? 'sub' : 'main', msgs);
        if (signal.aborted) { throw new Error('Cancelled'); }
        if (r.content) { onToken(r.content); }
        return r;
      };
      return new Agent({
        root, llm, guard: rules, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }),
        tools: () => (sub ? toolsForType(createFsTools(), sub, DELEGATION_TOOLS) : createFsTools()),
        subagent: !!sub, extraSystem: sub?.prompt, agentTypes: () => BUILTIN_AGENT_TYPES,
        spawn: sub ? undefined : (req) => mgr.spawn(sid, aid, req),
      });
    },
  });
  const s = mgr.newSession();
  const main = mgr.agent(s.id, 'a1');
  const of = (type: string, aid = 'a1') => events.filter(([a, e]) => a === aid && e.type === type).map(([, e]) => e);
  const read = (f: string) => fs.readFile(path.join(root, f), 'utf8').catch(() => undefined);
  return { mgr, sid: s.id, main, of, read };
}

/** Main writes the files in order, one call per step; `before(i)` runs before step i's call is returned. */
function writer(files: string[], before: (i: number) => Promise<void> = async () => {}): Brain {
  return async (_who, msgs) => {
    const i = toolMsgs(msgs).length;
    if (i >= files.length) { return text(`done: ${toolMsgs(msgs).map((t) => t.split('\n')[0]).join(' | ')}`); }
    await before(i);
    return call('write_file', { path: files[i], content: files[i] }, `W${i + 1}`);
  };
}

test('a mode switched during a run makes the later tool calls run without asking', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const h = await harness(writer(['a.txt', 'b.txt'], async (i) => { if (i === 0) { await gate; } }), 'ask');
  const run = h.mgr.send(h.sid, 'a1', 'write two files');
  await until(() => h.main.status === 'running');
  h.mgr.setSettings(h.sid, 'a1', { mode: 'auto' });
  release();
  await run;
  assert.equal(h.of('approve').length, 0, 'nothing asked after the switch');
  assert.equal(await h.read('a.txt'), 'a.txt');
  assert.equal(await h.read('b.txt'), 'b.txt');
});

test('an approval already waiting is allowed automatically when the user switches to auto, and its prompt is cleared', async () => {
  const h = await harness(writer(['a.txt', 'b.txt']), 'ask');
  const run = h.mgr.send(h.sid, 'a1', 'write two files');
  await until(() => h.main.status === 'waiting');
  assert.equal(h.of('approve').length, 1);
  h.mgr.setSettings(h.sid, 'a1', { mode: 'auto' });
  await run;
  assert.deepEqual(h.of('approvalDone').map((e) => [e.id, e.label]), [['W1', 'allowed (auto mode)']], 'the waiting card is resolved; b.txt never asked');
  assert.equal(h.main.pending.size, 0);
  assert.equal(await h.read('a.txt'), 'a.txt');
  assert.equal(await h.read('b.txt'), 'b.txt');
});

test('switching to a stricter mode makes later calls ask, and plan mode refuses a waiting edit', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const h = await harness(writer(['a.txt', 'b.txt'], async (i) => { if (i === 0) { await gate; } }), 'auto');
  const run = h.mgr.send(h.sid, 'a1', 'write two files');
  await until(() => h.main.status === 'running');
  h.mgr.setSettings(h.sid, 'a1', { mode: 'ask' });
  release();
  await until(() => h.main.status === 'waiting');
  assert.equal(h.of('approve').length, 1, 'a.txt now needs approval');
  assert.equal(await h.read('a.txt'), undefined, 'not written before approval');
  // Still waiting when the user switches to plan mode: the edit has not started, so it is refused.
  h.mgr.setSettings(h.sid, 'a1', { mode: 'plan' });
  await run;
  assert.deepEqual(h.of('approvalDone').map((e) => e.label), ['not allowed in plan mode']);
  assert.equal(await h.read('a.txt'), undefined);
  assert.equal(await h.read('b.txt'), undefined);
  assert.match(toolMsgs(h.main.agent.history)[0], /ERROR: write_file is not allowed in plan mode/);
  assert.match(toolMsgs(h.main.agent.history)[1], /ERROR: write_file is not allowed in plan mode/);
});

test('deny rules still deny and rule asks still ask after switching to auto', async () => {
  const h = await harness(writer(['guarded.txt', 'secret.txt', 'ok.txt']), 'ask');
  const run = h.mgr.send(h.sid, 'a1', 'write files');
  await until(() => h.main.status === 'waiting');
  h.mgr.setSettings(h.sid, 'a1', { mode: 'auto' });
  await sleep(50);
  assert.equal(h.main.status, 'waiting', 'a rule ask is not a mode ask: it keeps waiting');
  assert.equal(h.of('approvalDone').length, 0);
  h.mgr.resolveApproval(h.sid, 'a1', 'W1', true);
  await run;
  const results = toolMsgs(h.main.agent.history);
  assert.match(results[1], /^DENIED by permission rule: Edit\(secret\.txt\)/);
  assert.equal(await h.read('secret.txt'), undefined);
  assert.equal(await h.read('guarded.txt'), 'guarded.txt');
  assert.equal(await h.read('ok.txt'), 'ok.txt');
  assert.equal(h.of('approve').length, 1, 'only the rule ask was shown');
});

test('sub-agents follow a mode switch of the session: a waiting sub-agent approval is allowed on switching to auto', async () => {
  const h = await harness(async (who, msgs) => {
    if (who === 'sub') { return toolMsgs(msgs).length ? text('wrote it') : call('write_file', { path: 'from-sub.txt', content: 'hi' }, 'S1'); }
    return toolMsgs(msgs).length || lastUser(msgs).includes('<agent-notification>') ? text('ok') : call(AGENT_TOOL, { description: 'writer', prompt: 'write a file', run_in_background: true }, 'A1');
  }, 'ask');
  await h.mgr.send(h.sid, 'a1', 'go');
  const sub = h.mgr.agent(h.sid, 'a2');
  await until(() => sub.status === 'waiting');
  h.mgr.setSettings(h.sid, 'a1', { mode: 'auto' });
  await sub.run;
  assert.equal(sub.settings.mode, 'auto');
  assert.deepEqual(h.of('approvalDone', 'a2').map((e) => e.label), ['allowed (auto mode)']);
  assert.equal(await h.read('from-sub.txt'), 'hi');
});
