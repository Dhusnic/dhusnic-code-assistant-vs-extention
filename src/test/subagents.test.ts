import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Agent, AGENT_TOOL, DELEGATION_TOOLS, SEND_TOOL } from '../core/agent';
import { AgentType, BUILTIN_AGENT_TYPES, toolsForType } from '../core/agentTypes';
import { createFsTools } from '../core/fstools';
import { ChatMessage, LlmFn, StreamResult } from '../core/llm';
import { SessionManager, UiEvent } from '../core/runtime';
import { SessionStore2 } from '../core/store';
import { tmpDir } from './helpers';

/**
 * Wires SessionManager exactly like the extension host: main agents get the `agent` and `send_message` tools backed
 * by the runtime; sub-agents get their type's tools and prompt, and cannot delegate further.
 */
type Brain = (who: { role: 'main' | 'sub'; type?: string }, msgs: ChatMessage[], tools: string[]) => StreamResult | Promise<StreamResult>;
const text = (content: string): StreamResult => ({ content, toolCalls: [] });
const call = (name: string, args: object, id: string): StreamResult => ({ content: '', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const calls = (...cs: Array<[string, object, string]>): StreamResult => ({ content: '', toolCalls: cs.map(([name, args, id]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastUser = (m: ChatMessage[]) => String([...m].reverse().find((x) => x.role === 'user')?.content ?? '');
const toolMsgs = (m: ChatMessage[]) => m.filter((x) => x.role === 'tool').map((x) => String(x.content));
const lastIsTool = (m: ChatMessage[]) => m[m.length - 1]?.role === 'tool';

async function harness(brain: Brain, opts: { max?: number; storeDir?: string; types?: AgentType[]; mode?: 'ask' | 'auto' } = {}) {
  const root = await tmpDir('sa-root-');
  const store = new SessionStore2(opts.storeDir ?? await tmpDir('sa-store-'));
  const types = opts.types ?? BUILTIN_AGENT_TYPES;
  const seenTools: Record<string, string[]> = {};
  const events: Array<[string, UiEvent]> = [];
  let n = 0;
  let mgr!: SessionManager;
  mgr = new SessionManager({
    store, agentTypes: () => types, maxConcurrent: () => opts.max ?? 4, newSessionId: () => `s${++n}`, saveThrottleMs: 10,
    defaults: () => ({ mode: opts.mode ?? 'auto', effort: 'medium', model: 'm' }),
    onEvent: (_s, a, e) => events.push([a, e]),
    createAgent: (sid, aid, spec) => {
      const sub = spec?.role === 'sub' ? spec.type : undefined;
      const llm: LlmFn = async (_c, msgs, tools, onToken, signal) => {
        seenTools[aid] = tools.map((t) => t.function.name);
        const r = await brain(sub ? { role: 'sub', type: sub.name } : { role: 'main' }, msgs, seenTools[aid]);
        if (signal.aborted) { throw new Error('Cancelled'); }
        if (r.content) { onToken(r.content); }
        return r;
      };
      return new Agent({
        root, llm, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }),
        tools: () => (sub ? toolsForType(createFsTools(), sub, DELEGATION_TOOLS) : createFsTools()),
        subagent: !!sub, extraSystem: sub?.prompt, agentTypes: () => types,
        spawn: sub ? undefined : (req) => mgr.spawn(sid, aid, req),
        sendToAgent: sub ? undefined : (to, m) => mgr.message(sid, to, m),
      });
    },
  });
  return { mgr, store, root, seenTools, events };
}

const subs = (h: Awaited<ReturnType<typeof harness>>, sid: string) => h.mgr.snapshot().find((s) => s.id === sid)!.agents.filter((a) => a.role === 'sub');

test('foreground agent: runs in its own empty context, its report is the tool result, and it is tracked', async () => {
  let subSaw: ChatMessage[] = [];
  const h = await harness(async (who, msgs) => {
    if (who.role === 'sub') { subSaw = msgs; return text('REPORT: config lives in settings.py:12'); }
    return lastIsTool(msgs) ? text(`Summary: ${toolMsgs(msgs)[0].split('\n')[0]}`) : call(AGENT_TOOL, { description: 'Find config', prompt: 'Where is the config loaded?', subagent_type: 'explore' }, 'T1');
  });
  const s = h.mgr.newSession();
  await h.mgr.send(s.id, 'a1', 'secret main context');
  assert.deepEqual(subSaw.filter((m) => m.role !== 'system').map((m) => m.content), ['Where is the config loaded?'], 'fresh context: only its task');
  assert.match(String(subSaw[0].content), /SUB-AGENT/);
  assert.match(String(subSaw[0].content), /fast codebase explorer/, 'type prompt applied');
  const main = h.mgr.agent(s.id, 'a1');
  assert.match(String(main.agent.history.at(-1)!.content), /Summary: REPORT: config lives in settings\.py:12/);
  const [sub] = subs(h, s.id);
  assert.deepEqual([sub.type, sub.description, sub.outcome, sub.parentId, sub.background], ['explore', 'Find config', 'completed', 'a1', false]);
  assert.ok(main.log.some((e) => e.type === 'agentLink' && e.toolId === 'T1' && e.agentId === sub.id), 'tool card links to the agent');
});

test('types control tools: explore/plan are read-only, general-purpose can edit, nobody can delegate further', async () => {
  const h = await harness(async (who, msgs) => {
    if (who.role === 'sub') { return text('done'); }
    return lastIsTool(msgs) ? text('ok') : calls([AGENT_TOOL, { description: 'e', prompt: 'p', subagent_type: 'explore' }, 'x1'], [AGENT_TOOL, { description: 'g', prompt: 'p' }, 'x2']);
  });
  const s = h.mgr.newSession();
  await h.mgr.send(s.id, 'a1', 'go');
  const [e, g] = subs(h, s.id);
  assert.ok(h.seenTools.a1.includes(AGENT_TOOL) && h.seenTools.a1.includes(SEND_TOOL));
  assert.ok(!h.seenTools[e.id].includes('write_file') && h.seenTools[e.id].includes('grep'));
  assert.ok(h.seenTools[g.id].includes('write_file') && h.seenTools[g.id].includes('run_command'));
  for (const id of [e.id, g.id]) { assert.ok(!h.seenTools[id].includes(AGENT_TOOL) && !h.seenTools[id].includes(SEND_TOOL), 'no nesting'); }
});

test('several agents launched in one turn run in parallel', async () => {
  let active = 0, peak = 0;
  const h = await harness(async (who, msgs) => {
    if (who.role === 'sub') { active++; peak = Math.max(peak, active); await sleep(60); active--; return text(`r:${lastUser(msgs)}`); }
    return lastIsTool(msgs) ? text(toolMsgs(msgs).map((t) => t.split('\n')[0]).join('|')) : calls([AGENT_TOOL, { description: 'a', prompt: 'A' }, 'p1'], [AGENT_TOOL, { description: 'b', prompt: 'B' }, 'p2'], [AGENT_TOOL, { description: 'c', prompt: 'C' }, 'p3']);
  });
  const s = h.mgr.newSession();
  await h.mgr.send(s.id, 'a1', 'fan out');
  assert.equal(peak, 3);
  assert.equal(h.mgr.agent(s.id, 'a1').agent.history.at(-1)!.content, 'r:A|r:B|r:C', 'results in call order');
});

test('background agent: returns at once, the main turn ends, then a notification starts a new main turn with the result', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const h = await harness(async (who, msgs) => {
    if (who.role === 'sub') { await gate; return text('BG RESULT 42'); }
    const u = lastUser(msgs);
    if (u.includes('<agent-notification>')) { return text(`Got it: ${/BG RESULT \d+/.exec(u)![0]}`); }
    return lastIsTool(msgs) ? text('Started it; I will report back.') : call(AGENT_TOOL, { description: 'Long scan', prompt: 'scan everything', run_in_background: true }, 'B1');
  });
  const s = h.mgr.newSession();
  await h.mgr.send(s.id, 'a1', 'do a long scan');
  const main = h.mgr.agent(s.id, 'a1');
  assert.match(toolMsgs(main.agent.history)[0], /Launched general-purpose agent "Long scan" \(id a2\) in the background/);
  assert.equal(main.status, 'idle', 'main is free while the agent works');
  assert.equal(subs(h, s.id)[0].status, 'running');
  release();
  for (let i = 0; i < 300 && main.agent.turnCount < 2; i++) { await sleep(10); }
  await main.run;
  assert.equal(main.agent.turnCount, 2, 'notification became a new turn');
  assert.match(String(main.agent.history.at(-1)!.content), /Got it: BG RESULT 42/);
  const note = main.log.find((e) => e.type === 'userMsg' && e.notification);
  assert.deepEqual(note!.notification, [{ id: 'a2', description: 'Long scan', outcome: 'completed' }]);
  assert.match(note!.text, /^🔔 Agent “Long scan” completed/);
});

test('notifications that arrive while main is busy are queued and delivered when its turn ends', async () => {
  let mainGate!: () => void;
  const mainBusy = new Promise<void>((r) => { mainGate = r; });
  const h = await harness(async (who, msgs) => {
    if (who.role === 'sub') { return text('quick result'); }
    const u = lastUser(msgs);
    if (u.includes('<agent-notification>')) { return text('handled notification'); }
    if (!lastIsTool(msgs)) { return call(AGENT_TOOL, { description: 'Quick', prompt: 'q', run_in_background: true }, 'Q1'); }
    await mainBusy;
    return text('first turn done');
  });
  const s = h.mgr.newSession();
  const first = h.mgr.send(s.id, 'a1', 'go');
  const main = h.mgr.agent(s.id, 'a1');
  for (let i = 0; i < 200 && main.inbox.length === 0; i++) { await sleep(10); }
  assert.equal(main.inbox.length, 1, 'held while main is working');
  assert.equal(main.status, 'running', 'main was still busy when the notification arrived');
  assert.equal(main.agent.turnCount, 1);
  mainGate();
  await first;
  for (let i = 0; i < 300 && main.agent.history.at(-1)!.content !== 'handled notification'; i++) { await sleep(10); }
  assert.equal(main.agent.history.at(-1)!.content, 'handled notification');
  assert.equal(main.inbox.length, 0);
});

test('send_message continues an agent with its context; the reply is delivered as a notification', async () => {
  const subPrompts: string[][] = [];
  const h = await harness(async (who, msgs) => {
    if (who.role === 'sub') { subPrompts.push(msgs.filter((m) => m.role === 'user').map((m) => String(m.content))); return text(`sub turn ${subPrompts.length}`); }
    const u = lastUser(msgs);
    if (u.includes('<agent-notification>')) { return text('noted'); }
    if (u === 'start') { return lastIsTool(msgs) ? text('ok') : call(AGENT_TOOL, { description: 'Helper', prompt: 'first task' }, 'S1'); }
    return lastIsTool(msgs) ? text('sent') : call(SEND_TOOL, { to: 'a2', message: 'now do the second part' }, 'M1');
  });
  const s = h.mgr.newSession();
  await h.mgr.send(s.id, 'a1', 'start');
  await h.mgr.send(s.id, 'a1', 'follow up with the helper');
  const main = h.mgr.agent(s.id, 'a1');
  assert.match(toolMsgs(main.agent.history).at(-1)!, /Message sent to agent a2/);
  for (let i = 0; i < 300 && main.agent.history.at(-1)!.content !== 'noted'; i++) { await sleep(10); }
  assert.deepEqual(subPrompts[1], ['first task', 'now do the second part'], 'the agent kept its context');
  assert.equal(main.agent.history.at(-1)!.content, 'noted');
  assert.match(await h.mgr.message(s.id, 'zz', 'x').then((r) => r.text), /no sub-agent "zz"/);
  assert.match(await h.mgr.message(s.id, 'a1', 'x').then((r) => r.text), /no sub-agent "a1"/, 'the main agent is not a message target');
});

test('unknown type and nested delegation attempts are reported, never crash', async () => {
  const h = await harness(async (who, msgs) => {
    if (who.role === 'sub') { return lastIsTool(msgs) ? text('could not nest') : call(AGENT_TOOL, { description: 'nested', prompt: 'x' }, 'N1'); }
    if (lastIsTool(msgs)) { return text('done'); }
    return lastUser(msgs) === 'bad type' ? call(AGENT_TOOL, { description: 'x', prompt: 'x', subagent_type: 'wizard' }, 'U1') : call(AGENT_TOOL, { description: 'outer', prompt: 'x' }, 'O1');
  });
  const s = h.mgr.newSession();
  await h.mgr.send(s.id, 'a1', 'bad type');
  assert.match(toolMsgs(h.mgr.agent(s.id, 'a1').agent.history)[0], /unknown agent type "wizard"\. Available types: general-purpose, explore, plan, researcher, tester, fork/);
  await h.mgr.send(s.id, 'a1', 'nest');
  const outer = subs(h, s.id)[0];
  assert.match(toolMsgs(h.mgr.agent(s.id, outer.id).agent.history)[0], /sub-agents cannot start further sub-agents/);
});

test('fork type inherits the conversation up to (not including) the call that launched it', async () => {
  let forkSaw: string[] = [];
  const h = await harness(async (who, msgs) => {
    if (who.role === 'sub') { forkSaw = msgs.filter((m) => m.role !== 'system').map((m) => `${m.role}:${m.content ?? ''}`); return text('fork done'); }
    if (lastUser(msgs) === 'earlier question') { return text('earlier answer'); }
    return lastIsTool(msgs) ? text('ok') : call(AGENT_TOOL, { description: 'side quest', prompt: 'try the alternative', subagent_type: 'fork' }, 'F1');
  });
  const s = h.mgr.newSession();
  await h.mgr.send(s.id, 'a1', 'earlier question');
  await h.mgr.send(s.id, 'a1', 'now fork');
  assert.deepEqual(forkSaw, ['user:earlier question', 'assistant:earlier answer', 'user:now fork', 'user:try the alternative']);
});

test('stopping the main conversation stops its foreground agents; background agents keep running', async () => {
  let bgGate!: () => void;
  const bgWait = new Promise<void>((r) => { bgGate = r; });
  const h = await harness(async (who, msgs) => {
    if (who.role === 'sub') {
      if (lastUser(msgs) === 'bg') { await bgWait; return text('bg finished'); }
      await sleep(5000); return text('never');
    }
    if (lastUser(msgs).includes('<agent-notification>')) { return text('saw bg'); }
    return lastIsTool(msgs) ? text('x') : calls([AGENT_TOOL, { description: 'bg', prompt: 'bg', run_in_background: true }, 'K1'], [AGENT_TOOL, { description: 'fg', prompt: 'fg' }, 'K2']);
  });
  const s = h.mgr.newSession();
  const run = h.mgr.send(s.id, 'a1', 'go');
  for (let i = 0; i < 300 && subs(h, s.id).filter((a) => a.status === 'running').length < 2; i++) { await sleep(10); }
  h.mgr.stop(s.id, 'a1');
  await run;
  const [bg, fg] = subs(h, s.id);
  assert.equal(fg.outcome, 'cancelled');
  assert.equal(bg.status, 'running', 'background work survives a stop of the main turn');
  bgGate();
  const main = h.mgr.agent(s.id, 'a1');
  for (let i = 0; i < 300 && main.agent.history.at(-1)!.content !== 'saw bg'; i++) { await sleep(10); }
  assert.equal(main.agent.history.at(-1)!.content, 'saw bg');
});

test('a foreground agent never deadlocks on the concurrency limit (limit 1)', async () => {
  const h = await harness(async (who, msgs) => (who.role === 'sub' ? text('sub ok') : lastIsTool(msgs) ? text('main ok') : call(AGENT_TOOL, { description: 'd', prompt: 'p' }, 'L1')), { max: 1 });
  const s = h.mgr.newSession();
  await Promise.race([h.mgr.send(s.id, 'a1', 'go'), sleep(3000).then(() => { throw new Error('deadlock'); })]);
  assert.equal(h.mgr.agent(s.id, 'a1').agent.history.at(-1)!.content, 'main ok');
});

test('sub-agent approvals follow the session mode and are answered on the sub-agent', async () => {
  const h = await harness(async (who, msgs) => {
    if (who.role === 'sub') { return lastIsTool(msgs) ? text('wrote it') : call('write_file', { path: 'from-sub.txt', content: 'hi' }, 'W1'); }
    // A finished background agent notifies main; main must not start another writer in reply (that would loop forever).
    return lastIsTool(msgs) || lastUser(msgs).includes('<agent-notification>') ? text('ok') : call(AGENT_TOOL, { description: 'writer', prompt: 'write a file', run_in_background: true }, 'A1');
  }, { mode: 'ask' });
  const s = h.mgr.newSession();
  await h.mgr.send(s.id, 'a1', 'go');
  const sub = h.mgr.agent(s.id, 'a2');
  for (let i = 0; i < 300 && sub.status !== 'waiting'; i++) { await sleep(10); }
  assert.equal(sub.status, 'waiting');
  assert.match(subs(h, s.id)[0].activity, /Waiting for approval: Write from-sub\.txt/);
  h.mgr.resolveApproval(s.id, 'a2', 'W1', true);
  await sub.run;
  assert.equal(await fs.readFile(path.join(h.root, 'from-sub.txt'), 'utf8'), 'hi');
});

test('spawnFromUser: a user-started agent runs in the background and reports to the main conversation', async () => {
  const h = await harness(async (who, msgs) => {
    if (who.role === 'sub') { return text('found 3 TODOs'); }
    return text(lastUser(msgs).includes('<agent-notification>') ? 'The explore agent found 3 TODOs.' : 'hi');
  });
  const s = h.mgr.newSession();
  const r = await h.mgr.spawnFromUser(s.id, 'explore', 'List the TODO comments in src');
  assert.equal(r.ok, true);
  const main = h.mgr.agent(s.id, 'a1');
  assert.ok(main.log.some((e) => e.type === 'info' && e.agentId === r.agentId), 'a "started" note with a link');
  for (let i = 0; i < 300 && main.agent.turnCount < 1; i++) { await sleep(10); }
  await main.run;
  assert.equal(main.agent.history.at(-1)!.content, 'The explore agent found 3 TODOs.');
});

test('the agent hierarchy is saved and restored; old multi-agent sessions load as main + sub-agents', async () => {
  const storeDir = await tmpDir('sa-persist-');
  const h = await harness(async (who, msgs) => (who.role === 'sub' ? text('plan: 1. do x') : lastIsTool(msgs) ? text('planned') : call(AGENT_TOOL, { description: 'Make a plan', prompt: 'plan it', subagent_type: 'plan' }, 'P1')), { storeDir });
  const s = h.mgr.newSession();
  await h.mgr.send(s.id, 'a1', 'plan please');
  await h.mgr.shutdown();

  const h2 = await harness(async () => text('x'), { storeDir });
  const re = (await h2.mgr.open(s.id))!;
  const sub = re.agents.get('a2')!;
  assert.deepEqual([re.main().id, sub.role, sub.type, sub.description, sub.outcome, sub.result, sub.parentId], ['a1', 'sub', 'plan', 'Make a plan', 'completed', 'plan: 1. do x', 'a1']);
  assert.ok(re.main().log.some((e) => e.type === 'toolStart' && e.name === 'agent'));

  // a v2 session from the "parallel conversations" era: second agent has no role
  const legacy = new SessionStore2(storeDir);
  const rec = (id: string, name: string) => ({ v: 2, id, sessionId: 'old', name, createdAt: 1, updatedAt: 2, status: 'idle' as const, model: 'm', mode: 'ask', effort: 'medium', history: [{ role: 'user' as const, content: `hi from ${name}` }, { role: 'assistant' as const, content: 'yo' }], turnStarts: [0] });
  await legacy.saveAgent(rec('a1', 'Agent 1')); await legacy.saveAgent(rec('a2', 'Agent 2'));
  await legacy.saveMeta({ v: 2, id: 'old', title: 'old', createdAt: 1, updatedAt: 2, agents: [] });
  const old = (await h2.mgr.open('old'))!;
  assert.equal(old.main().id, 'a1');
  assert.deepEqual([old.agents.get('a2')!.role, old.agents.get('a2')!.type, old.agents.get('a2')!.description], ['sub', 'general-purpose', 'Agent 2']);
});
