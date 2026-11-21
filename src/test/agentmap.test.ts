import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { Agent, AGENT_TOOL, DELEGATION_TOOLS, buildSystemPrompt, tokensSpent } from '../core/agent';
import { AgentType, BUILTIN_AGENT_TYPES, toolsForType } from '../core/agentTypes';
import { createFsTools } from '../core/fstools';
import { ChatMessage, LlmFn, StreamResult } from '../core/llm';
import { FANOUT_PROMPT } from '../core/prompts';
import { SessionManager } from '../core/runtime';
import { SessionStore2 } from '../core/store';
import { buildSessionHtml } from '../core/html';
import { tmpDir } from './helpers';

/**
 * Parallel fan-out (N tasks -> N sub-agents) and the agent map that monitors it: per-agent tokens and run time are
 * tracked, saved and restored, and the webview renders them.
 */
type Brain = (who: { role: 'main' | 'sub'; aid: string }, msgs: ChatMessage[]) => StreamResult | Promise<StreamResult>;
const text = (content: string, usage?: { prompt: number; completion: number }): StreamResult => ({ content, toolCalls: [], ...(usage ? { usage } : {}) });
const calls = (cs: Array<[string, object, string]>, usage?: { prompt: number; completion: number }): StreamResult => ({
  content: '', toolCalls: cs.map(([name, args, id]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })), ...(usage ? { usage } : {}),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastUser = (m: ChatMessage[]) => String([...m].reverse().find((x) => x.role === 'user')?.content ?? '');
const lastIsTool = (m: ChatMessage[]) => m[m.length - 1]?.role === 'tool';

async function harness(brain: Brain, opts: { max?: number; storeDir?: string } = {}) {
  const root = await tmpDir('am-root-');
  const store = new SessionStore2(opts.storeDir ?? await tmpDir('am-store-'));
  const types: AgentType[] = BUILTIN_AGENT_TYPES;
  let n = 0;
  let mgr!: SessionManager;
  mgr = new SessionManager({
    store, agentTypes: () => types, maxConcurrent: () => opts.max ?? 4, newSessionId: () => `s${++n}`, saveThrottleMs: 10,
    defaults: () => ({ mode: 'auto', effort: 'medium', model: 'm' }),
    createAgent: (sid, aid, spec) => {
      const sub = spec?.role === 'sub' ? spec.type : undefined;
      const llm: LlmFn = async (_c, msgs, _tools, onToken, signal) => {
        const r = await brain({ role: sub ? 'sub' : 'main', aid }, msgs);
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
  return { mgr, store };
}

const TASKS = ['Add a footer', 'Fix the login bug', 'Write API docs', 'Bump the version'];

test('tokensSpent: uses the gateway count, estimates when the gateway reports none', () => {
  assert.equal(tokensSpent({ content: 'x', toolCalls: [], usage: { prompt: 1200, completion: 34 } }, []), 1234);
  const est = tokensSpent({ content: 'a reply of some length', toolCalls: [] }, [{ role: 'user', content: 'x'.repeat(400) }]);
  assert.ok(est > 100 && est < 200, `estimate ~ chars/4, got ${est}`);
  assert.equal(tokensSpent({ content: '', toolCalls: [], usage: { prompt: -5, completion: 0 } }, []), 0, 'never negative');
});

test('the fan-out rule is in the main prompt only (sub-agents cannot delegate)', () => {
  const main = buildSystemPrompt('auto', 'medium', '/r', '', undefined, false);
  const sub = buildSystemPrompt('auto', 'medium', '/r', '', undefined, true);
  assert.ok(main.includes(FANOUT_PROMPT));
  assert.match(main, /one sub-agent per task/);
  assert.ok(!sub.includes('one sub-agent per task'), 'sub-agents do not get delegation instructions');
});

test('four tasks -> four sub-agents running at the same time; each one is tracked with its own tokens and run time', async () => {
  let active = 0, peak = 0;
  const subPrompts: string[] = [];
  const h = await harness(async (who, msgs) => {
    if (who.role === 'sub') {
      subPrompts.push(lastUser(msgs));
      active++; peak = Math.max(peak, active);
      await sleep(80);
      active--;
      return text(`done: ${lastUser(msgs)}`, { prompt: 1000, completion: 200 });
    }
    if (lastIsTool(msgs)) { return text('All four tasks done and verified.', { prompt: 3000, completion: 100 }); }
    return calls(TASKS.map((t, i) => [AGENT_TOOL, { description: t, prompt: t }, `T${i}`] as [string, object, string]), { prompt: 2000, completion: 300 });
  });
  const s = h.mgr.newSession();
  await h.mgr.send(s.id, 'a1', TASKS.map((t, i) => `${i + 1}. ${t}`).join('\n'));

  assert.equal(peak, 4, 'all four ran at once');
  assert.deepEqual([...subPrompts].sort(), [...TASKS].sort(), 'each agent got exactly one task');

  const view = h.mgr.snapshot().find((x) => x.id === s.id)!;
  const subs = view.agents.filter((a) => a.role === 'sub');
  assert.equal(subs.length, 4);
  for (const a of subs) {
    assert.equal(a.outcome, 'completed', a.description);
    assert.equal(a.tokens, 1200, `${a.description}: tokens from its own model calls only`);
    assert.ok(a.runMs >= 70, `${a.description}: run time recorded (${a.runMs}ms)`);
    assert.equal(a.startedAt, undefined, 'not running any more');
  }
  const main = view.agents.find((a) => a.role === 'main')!;
  assert.equal(main.tokens, 2300 + 3100, 'main counts its own two calls, not its sub-agents');
  assert.ok(main.runMs >= 70);
  assert.match(String(h.mgr.agent(s.id, 'a1').agent.history.at(-1)!.content), /All four tasks done/);
});

test('a running agent shows a live startedAt; queued agents (over the limit) have none until they start', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const h = await harness(async (who, msgs) => {
    if (who.role === 'sub') { await gate; return text('ok'); }
    if (lastIsTool(msgs) || /agent-notification/.test(lastUser(msgs))) { return text('noted'); }
    return calls(TASKS.map((t, i) => [AGENT_TOOL, { description: t, prompt: t, run_in_background: true }, `B${i}`] as [string, object, string]));
  }, { max: 2 });
  const s = h.mgr.newSession();
  await h.mgr.send(s.id, 'a1', 'go');
  await sleep(30);
  const subs = h.mgr.snapshot().find((x) => x.id === s.id)!.agents.filter((a) => a.role === 'sub');
  const running = subs.filter((a) => a.status === 'running');
  const queued = subs.filter((a) => a.status === 'queued');
  assert.equal(running.length, 2, 'limit respected');
  assert.equal(queued.length, 2);
  for (const a of running) { assert.ok(a.startedAt, 'running agents tick'); }
  for (const a of queued) { assert.equal(a.startedAt, undefined, 'queue time is not run time'); assert.equal(a.runMs, 0); }
  release();
  for (let i = 0; i < 100 && h.mgr.snapshot()[0].agents.some((a) => a.status !== 'idle'); i++) { await sleep(20); }
  const after = h.mgr.snapshot()[0].agents.filter((a) => a.role === 'sub');
  assert.ok(after.every((a) => a.outcome === 'completed'), 'all four finished');
});

test('tokens and run time are saved with the agent and restored when the session is reopened', async () => {
  const storeDir = await tmpDir('am-persist-');
  const h = await harness(async (who, msgs) => {
    if (who.role === 'sub') { await sleep(20); return text('r', { prompt: 40, completion: 2 }); }
    return lastIsTool(msgs) ? text('ok', { prompt: 10, completion: 1 }) : calls([[AGENT_TOOL, { description: 'one', prompt: 'p' }, 'X']], { prompt: 5, completion: 5 });
  }, { storeDir });
  const s = h.mgr.newSession();
  await h.mgr.send(s.id, 'a1', 'go');
  const before = h.mgr.snapshot()[0].agents.map((a) => [a.id, a.tokens, a.runMs]);
  await h.mgr.shutdown();

  const h2 = await harness(async () => text('x'), { storeDir });
  const re = (await h2.mgr.open(s.id))!;
  const after = [...re.agents.values()].map((a) => [a.id, a.tokens, a.runMs]);
  assert.deepEqual(after, before);
  assert.deepEqual(after.map((x) => x[1]), [21, 42]);
});

test('a corrupt or missing stats block loads as zero instead of failing', async () => {
  const storeDir = await tmpDir('am-bad-');
  const store = new SessionStore2(storeDir);
  const rec = (id: string, stats: any) => ({ v: 2, id, sessionId: 'old', name: id, createdAt: 1, updatedAt: 2, status: 'idle' as const, model: 'm', mode: 'ask', effort: 'medium', history: [{ role: 'user' as const, content: 'hi' }, { role: 'assistant' as const, content: 'yo' }], turnStarts: [0], role: 'main' as const, ...(stats === undefined ? {} : { stats }) });
  await store.saveAgent(rec('a1', { tokens: 'lots', runMs: -4 }) as any);
  await store.saveMeta({ v: 2, id: 'old', title: 'old', createdAt: 1, updatedAt: 2, agents: [] });
  const h = await harness(async () => text('x'), { storeDir });
  const v = (await h.mgr.open('old'))!.main().view();
  assert.deepEqual([v.tokens, v.runMs], [0, 0]);
});

/* ------------------------------------------------------------------ webview: the real agent-map code from session.js */

const ROOT = fs.existsSync(path.join(__dirname, '..', '..', 'media', 'session.js')) ? path.join(__dirname, '..', '..') : process.cwd();
const JS = fs.readFileSync(path.join(ROOT, 'media', 'session.js'), 'utf8');
const { esc } = require(path.join(ROOT, 'media', 'md.js'));

function loadMap(agents: any[], focused = 'a1') {
  const start = JS.indexOf('/* ---------- agent map:');
  const end = JS.indexOf('  function openAgentMap()');
  assert.ok(start > 0 && end > start, 'agent map block found in session.js');
  const els: Record<string, any> = {};
  const el = (id: string) => (els[id] ??= { id, innerHTML: '', textContent: '', hidden: false, title: '', scrollTop: 0, style: {} });
  const env = {
    $: el, esc, agents, state: { agentId: focused },
    BUSY: ['queued', 'running', 'waiting'],
    STATUS_LABEL: { idle: 'Idle', queued: 'Queued', running: 'Working', waiting: 'Needs your approval', error: 'Error', interrupted: 'Interrupted' },
    OUTCOME_LABEL: { completed: 'Completed', failed: 'Failed', cancelled: 'Stopped' },
  };
  const body = `${JS.slice(start, end)}\nreturn { fmtTokens, fmtDur, elapsedOf, renderAgentMap };`;
  el('amBody');
  const api = new Function(...Object.keys(env), body)(...Object.values(env));
  return { ...api, els };
}

const agentView = (o: any) => ({ role: 'sub', status: 'idle', tokens: 0, runMs: 0, updatedAt: 1, ...o });

test('agent map formats time and tokens like the monitor (2m 33s · 70.7k tokens)', () => {
  const { fmtTokens, fmtDur, elapsedOf } = loadMap([]);
  assert.deepEqual([fmtTokens(0), fmtTokens(999), fmtTokens(70_700), fmtTokens(287_600), fmtTokens(1_234_567)], ['0', '999', '70.7k', '287.6k', '1.23M']);
  assert.deepEqual([fmtDur(0), fmtDur(45_000), fmtDur(153_000), fmtDur(3_725_000)], ['0s', '45s', '2m 33s', '1h 2m']);
  assert.equal(elapsedOf({ runMs: 10_000 }), 10_000);
  const live = elapsedOf({ runMs: 10_000, startedAt: Date.now() - 5_000 });
  assert.ok(live >= 15_000 && live < 16_000, 'finished runs + the run in progress');
});

test('agent map renders main + every sub-agent in launch order with status, time, tokens and a summary', () => {
  const agents = [
    agentView({ id: 'a1', role: 'main', model: 'Opus', tokens: 287_600, runMs: 60_000, status: 'running', startedAt: Date.now() }),
    agentView({ id: 'a10', description: 'Tenth <task>', type: 'general-purpose', status: 'queued' }),
    agentView({ id: 'a2', description: 'Chat auto-scroll', type: 'general-purpose', status: 'running', activity: 'Editing chat.js', tokens: 70_700, runMs: 0, startedAt: Date.now() - 153_000 }),
    agentView({ id: 'a3', description: 'Branch name', type: 'explore', outcome: 'completed', tokens: 70_400, runMs: 153_000 }),
    agentView({ id: 'a4', description: 'Office extractor', type: 'general-purpose', status: 'error', outcome: 'failed', error: 'boom' }),
    agentView({ id: 'a5', description: 'Stopped one', outcome: 'cancelled' }),
  ];
  const { renderAgentMap, els } = loadMap(agents, 'a3');
  renderAgentMap();
  const html: string = els.amBody.innerHTML;
  const order = ['Chat auto-scroll', 'Branch name', 'Office extractor', 'Stopped one', 'Tenth &lt;task&gt;'].map((t) => html.indexOf(t));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `launch order a2..a5, a10 (${order})`);
  assert.ok(!html.includes('<task>'), 'descriptions are escaped');
  assert.match(html, /Main conversation/);
  assert.match(html, /Opus · 1m \d+s · 287\.6k tokens/);
  assert.match(html, /general-purpose · 2m 3\ds · 70\.7k tokens/);
  assert.match(html, /Working · Editing chat\.js/);
  assert.match(html, /class="am-node st-done active" data-am="a3"/, 'finished agent shows its outcome; focused one is marked');
  assert.match(html, /st-error[^>]*data-am="a4"/);
  assert.match(html, /Failed: boom/);
  assert.match(html, /st-stopped[^>]*data-am="a5"/);
  const stops = html.match(/data-amstop/g) ?? [];
  assert.equal(stops.length, 2, 'stop buttons only on running/queued sub-agents (never on main)');
  assert.equal(els.amSummary.textContent, '5 sub-agents · 1 running · 1 queued · 1 done · 1 failed · 1 stopped · 428.7k tokens in total');
  assert.equal(els.amProgress.style.width, '60%', '3 of 5 finished');
  assert.equal(els.amBar.hidden, false);
});

test('agent map with no sub-agents explains how to get them and hides the progress bar', () => {
  const { renderAgentMap, els } = loadMap([agentView({ id: 'a1', role: 'main', model: 'm' })]);
  renderAgentMap();
  assert.match(els.amBody.innerHTML, /No sub-agents yet/);
  assert.equal(els.amBar.hidden, true);
  assert.match(els.amSummary.textContent, /^0 sub-agents · 0 tokens in total$/);
});

test('session header has the agent map button, wired in session.js', () => {
  const html = buildSessionHtml({ nonce: 'N', cspSource: 'x:', cssUri: 'c', jsUri: 'j', mdUri: 'm', mermaidUri: 'mm', logoSvg: '<svg viewBox="0 0 1 1"></svg>' });
  assert.match(html, /id="mapBtn"/);
  assert.ok(html.indexOf('agentBtn') < html.indexOf('mapBtn'), 'next to the agent switcher');
  assert.match(JS, /\$\('mapBtn'\)\.onclick = openAgentMap/);
  assert.match(JS, /if \(\$\('agentMap'\)\) \{ renderAgentMap\(\); \}/, 'live refresh on every agents update');
});
