import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { AddressInfo } from 'net';
import { Agent } from '../core/agent';
import { LlmConfig, LlmEvent, LlmFn, retryNotice, streamChatOnce, withRetry } from '../core/llm';
import { healthView, probeModel, shouldProbe } from '../core/modelHealth';
import { SessionManager, WAITING_LABEL, waitingLabel } from '../core/runtime';
import { SessionStore2 } from '../core/store';
import { recordingUi, tmpDir } from './helpers';

/*
 * Gateway trouble the user must be able to see: a model that hangs while the gateway still lists it (sidebar
 * Status), stalls that are not retried for minutes (withRetry), and the activity line while the model is silent.
 */

const CFG: LlmConfig = { baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true };
const noop = () => {};
const signal = () => new AbortController().signal;
const stall = () => new Error('LLM stream stalled: the gateway sent nothing for 180 s (ETIMEDOUT).');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A local OpenAI-style gateway on 127.0.0.1; `handler` gets the parsed request body. */
async function gateway(handler: (body: any, res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => handler(raw ? JSON.parse(raw) : {}, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    cfg: { ...CFG, baseUrl: `http://127.0.0.1:${port}`, sampling: { top_k: 20 } } as LlmConfig,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
const sse = (res: http.ServerResponse, obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

/* ---------------------------------------------------------------- B: stalls and retries */

test('retry: a stall is retried only once, and the retry is announced', async () => {
  let n = 0;
  const events: LlmEvent[] = [];
  const fn: LlmFn = async () => { n++; throw stall(); };
  await assert.rejects(withRetry(fn, { baseDelayMs: 1 })(CFG, [], [], noop, signal(), undefined, (e) => events.push(e)), /stalled/);
  assert.equal(n, 2);
  assert.equal(events.length, 1);
  assert.deepEqual({ ...events[0], delayMs: 0 }, { type: 'retry', attempt: 1, of: 1, delayMs: 0, message: 'The model is not responding (nothing received for 180 s); retrying (1/1)…' });
});

test('retry: stallRetries 0 gives up on the first stall', async () => {
  let n = 0;
  const fn: LlmFn = async () => { n++; throw stall(); };
  await assert.rejects(withRetry(fn, { baseDelayMs: 1, stallRetries: 0 })(CFG, [], [], noop, signal()), /stalled/);
  assert.equal(n, 1);
});

test('retry: 503s are still retried three times, each one announced', async () => {
  let n = 0;
  const lines: string[] = [];
  const fn: LlmFn = async () => { n++; throw new Error('LLM HTTP 503: down'); };
  await assert.rejects(withRetry(fn, { baseDelayMs: 1 })(CFG, [], [], noop, signal(), undefined, (e) => { if (e.type === 'retry') { lines.push(e.message); } }), /503/);
  assert.equal(n, 4);
  assert.deepEqual(lines, [1, 2, 3].map((i) => `The gateway returned HTTP 503; retrying (${i}/3)…`));
});

test('retry: a connection reset, then a stall, then success', async () => {
  let n = 0;
  const fn: LlmFn = async () => {
    n++;
    if (n === 1) { throw new Error('read ECONNRESET'); }
    if (n === 2) { throw stall(); }
    return { content: 'ok', toolCalls: [] };
  };
  const lines: string[] = [];
  const r = await withRetry(fn, { baseDelayMs: 1 })(CFG, [], [], noop, signal(), undefined, (e) => { if (e.type === 'retry') { lines.push(e.message); } });
  assert.equal(r.content, 'ok');
  assert.deepEqual(lines, ['The gateway is not responding; retrying (1/3)…', 'The model is not responding (nothing received for 180 s); retrying (1/1)…']);
});

test('retryNotice: 429 says busy', () => {
  assert.equal(retryNotice(new Error('LLM HTTP 429: slow down'), 2, 3), 'The gateway is busy (HTTP 429); retrying (2/3)…');
});

test('stream: onEvent gets "receiving" once, at the first bytes of the reply', async () => {
  const gw = await gateway((_b, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(res, { choices: [{ delta: { content: 'a' } }] });
    setTimeout(() => { sse(res, { choices: [{ delta: { content: 'b' } }] }); res.end('data: [DONE]\n\n'); }, 30);
  });
  try {
    const events: string[] = [];
    const r = await streamChatOnce(gw.cfg, [], [], (t) => events.push(`token:${t}`), signal(), undefined, (e) => events.push(e.type));
    assert.equal(r.content, 'ab');
    assert.deepEqual(events, ['receiving', 'token:a', 'token:b']);
  } finally { await gw.close(); }
});

test('agent: a retry shows an info line and the model-call phases go waiting → receiving → done', async () => {
  let n = 0;
  const llm: LlmFn = async (_c, _m, _t, onToken, _s, _p, onEvent) => {
    n++;
    onEvent?.({ type: 'retry', attempt: 1, of: 1, delayMs: 0, message: 'The model is not responding; retrying (1/1)…' });
    onEvent?.({ type: 'receiving' });
    onToken('hi');
    return { content: 'hi', toolCalls: [] };
  };
  const agent = new Agent({ root: await tmpDir('rel-'), llm, getConfig: () => CFG, tools: () => [] });
  const ui = recordingUi();
  ui.modelCall = (phase) => ui.events.push(`model:${phase}`);
  await agent.send('hello', { mode: 'auto', effort: 'low', model: 'm' }, ui);
  assert.equal(n, 1);
  assert.deepEqual(ui.events.filter((e) => /^(model:|info:The model|token:)/.test(e)), [
    'model:waiting', 'info:The model is not responding; retrying (1/1)…', 'model:waiting', 'model:receiving', 'token:hi', 'model:done',
  ]);
});

test('agent: "done" is reported when the model call fails', async () => {
  const llm: LlmFn = async () => { throw new Error('LLM HTTP 401: no'); };
  const agent = new Agent({ root: await tmpDir('rel-'), llm, getConfig: () => CFG, tools: () => [] });
  const ui = recordingUi();
  ui.modelCall = (phase) => ui.events.push(`model:${phase}`);
  await assert.rejects(agent.send('hello', { mode: 'auto', effort: 'low', model: 'm' }, ui), /401/);
  assert.deepEqual(ui.events.filter((e) => e.startsWith('model:')), ['model:waiting', 'model:done']);
});

/* ---------------------------------------------------------------- C: "Waiting for the model…" */

test('waitingLabel: plain at first, then counts the seconds', () => {
  assert.equal(waitingLabel(5_000), WAITING_LABEL);
  assert.equal(waitingLabel(45_000), 'Waiting for the model… no response for 45 s');
});

async function manager(llm: LlmFn) {
  const root = await tmpDir('rel-root-');
  const activities: string[] = [];
  const store = new SessionStore2(await tmpDir('rel-store-'));
  const mgr: SessionManager = new SessionManager({
    store,
    createAgent: () => new Agent({ root, llm, getConfig: () => CFG, tools: () => [] }),
    defaults: () => ({ mode: 'auto', effort: 'low', model: 'm' }),
    onChange: () => {
      const a = mgr.snapshot()[0]?.agents[0]?.activity;
      if (a && activities[activities.length - 1] !== a) { activities.push(a); }
    },
    newSessionId: () => 's1',
    saveThrottleMs: 10,
    waitNoticeMs: 40,
    waitTickMs: 15,
  });
  return { mgr, activities };
}

test('runtime: the activity line waits for the first byte, counts the silence, then shows the reply', async () => {
  const llm: LlmFn = async (_c, _m, _t, onToken, _s, _p, onEvent) => {
    await sleep(120);
    onEvent?.({ type: 'receiving' });
    await sleep(20);
    onToken('hello');
    return { content: 'hello', toolCalls: [] };
  };
  const { mgr, activities } = await manager(llm);
  const s = mgr.newSession();
  await mgr.send(s.id, 'a1', 'hi');
  const i = activities.indexOf(WAITING_LABEL);
  assert.ok(i >= 0, activities.join(' | '));
  const counted = activities.findIndex((a) => /^Waiting for the model… no response for \d+ s$/.test(a));
  assert.ok(counted > i, activities.join(' | '));
  assert.ok(activities.indexOf('Thinking…', counted) > counted, activities.join(' | '));
  assert.ok(activities.indexOf('Writing response…') > counted, activities.join(' | '));
  assert.equal(mgr.agent(s.id, 'a1').waitTimer, undefined);
  // No timer left behind: nothing changes the line once the turn is over.
  const after = activities.length;
  await sleep(60);
  assert.equal(activities.length, after);
});

test('runtime: stopping while waiting for the model clears the wait timer', async () => {
  const llm: LlmFn = (_c, _m, _t, _o, sig) => new Promise((_r, reject) => sig.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
  const { mgr } = await manager(llm);
  const s = mgr.newSession();
  const run = mgr.send(s.id, 'a1', 'hi').catch(() => undefined);
  await sleep(60);
  const rt = mgr.agent(s.id, 'a1');
  assert.ok(rt.waitTimer);
  assert.match(rt.activity, /^Waiting for the model…/);
  mgr.stop(s.id, 'a1');
  await run;
  await rt.run?.catch(() => undefined);
  assert.equal(rt.waitTimer, undefined);
  assert.doesNotMatch(rt.activity, /^Waiting/);
});

/* ---------------------------------------------------------------- A: model health */

test('shouldProbe: due after the interval, forced by refresh, never while one runs', () => {
  const last = { ok: true, ms: 10, at: 1_000, model: 'm' };
  assert.equal(shouldProbe({ inFlight: false }, 'm', 0), true);
  assert.equal(shouldProbe({ inFlight: false, last }, 'm', 1_000 + 60_000), false);
  assert.equal(shouldProbe({ inFlight: false, last }, 'm', 1_000 + 5 * 60_000), true);
  assert.equal(shouldProbe({ inFlight: false, last }, 'm', 2_000, { force: true }), true);
  assert.equal(shouldProbe({ inFlight: false, last }, 'other', 2_000), true);
  assert.equal(shouldProbe({ inFlight: true, last }, 'm', 10 * 60_000, { force: true }), false);
  assert.equal(shouldProbe({ inFlight: false }, 'm', 0, { force: true, intervalMs: 0 }), false);
});

test('healthView: online with the model latency, gateway up but model silent, offline', () => {
  const up = { ok: true, ms: 104 };
  assert.equal(healthView({}, { inFlight: false }, 'm').state, 'checking');
  assert.deepEqual([healthView({ ok: false, error: 'x' }, { inFlight: false }, 'm').state, healthView({ ok: false }, { inFlight: false }, 'm').label], ['offline', 'Offline']);
  assert.equal(healthView(up, { inFlight: true }, 'm').label, 'Gateway up · checking model…');
  assert.equal(healthView(up, { inFlight: false, last: { ok: true, ms: 812, at: 1, model: 'm' } }, 'm').label, 'Online · 812 ms');
  const bad = healthView(up, { inFlight: false, last: { ok: false, ms: 20_000, at: 1, model: 'm', error: 'no answer within 20 s' } }, 'm');
  assert.deepEqual([bad.state, bad.label, bad.modelError, bad.ok], ['degraded', 'Gateway up · model not responding', 'no answer within 20 s', true]);
  // A probe of another model says nothing about the selected one; with probing off the model list is all there is.
  assert.equal(healthView(up, { inFlight: false, last: { ok: false, ms: 1, at: 1, model: 'old' } }, 'm').state, 'online');
  assert.equal(healthView(up, { inFlight: false }, 'm', false).label, 'Online · 104 ms');
});

test('probeModel: a one-token request without sampling extras; ok when the model answers', async () => {
  let body: any;
  const gw = await gateway((b, res) => {
    body = b;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(res, { choices: [{ delta: { content: 'p' }, finish_reason: 'length' }] });
    res.end('data: [DONE]\n\n');
  });
  try {
    const r = await probeModel(streamChatOnce, gw.cfg, { timeoutMs: 2000 });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.model, 'm');
    assert.equal(body.max_tokens, 1);
    assert.equal(body.top_k, undefined);
    assert.equal(body.messages.length, 1);
  } finally { await gw.close(); }
});

test('probeModel: a model that accepts the request but never answers fails within the timeout', async () => {
  const gw = await gateway(() => { /* accepted, never answered */ });
  try {
    const t0 = Date.now();
    const r = await probeModel(streamChatOnce, gw.cfg, { timeoutMs: 200 });
    assert.equal(r.ok, false);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(r.error, 'no answer within 0 s');
  } finally { await gw.close(); }
});

test('probeModel: an HTTP error is a failed probe with its message', async () => {
  const gw = await gateway((_b, res) => { res.writeHead(500); res.end('backend down'); });
  try {
    const r = await probeModel(streamChatOnce, gw.cfg, { timeoutMs: 2000 });
    assert.deepEqual([r.ok, /LLM HTTP 500: backend down/.test(r.error ?? '')], [false, true]);
  } finally { await gw.close(); }
});
