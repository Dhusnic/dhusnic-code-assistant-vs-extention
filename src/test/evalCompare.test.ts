/**
 * Tests for the agent-comparison parts of the eval harness: the metering proxy (meter.ts), the Cline driver's pure
 * helpers (cline.ts) and the side-by-side report. The proxy is tested against a fake gateway on loopback; nothing
 * here leaves the machine and no real Cline is started.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { AddressInfo } from 'net';
import { clineArgs, clineEnv, clineLauncher, setupClineHome, summarizeClineEvents } from '../eval/cline';
import { rewriteChatBody, startMeter, usageFromSse } from '../eval/meter';
import { parseArgs } from '../eval/run';
import { EvalReport, formatReport, RunResult } from '../eval/runner';
import { tmpDir } from './helpers';

interface Seen { url: string; auth: string; body: any }

/** A fake gateway: answers chat requests with a short SSE stream (with usage when asked), records what it got. */
async function fakeGateway(opts: { rejectTopK?: boolean } = {}): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = b ? JSON.parse(b) : null;
      seen.push({ url: req.url ?? '', auth: String(req.headers.authorization ?? ''), body });
      if (opts.rejectTopK && body && 'top_k' in body) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: top_k' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] })}\n\n`);
      if (body?.stream_options?.include_usage) { res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 7 } })}\n\n`); }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, close: () => new Promise((r) => server.close(() => r())) };
}

function post(url: string, body: unknown, key = 'placeholder'): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'content-length': data.length } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('meter: forwards to the gateway with the real key, forces sampling, adds include_usage and counts tokens', async () => {
  const gw = await fakeGateway();
  const meter = await startMeter({ upstream: gw.url, apiKey: 'real-key', force: { temperature: 0.7, top_p: 0.8 } });
  try {
    const r = await post(`${meter.url}/chat/completions`, { model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }], temperature: 0 }, meter.agentKey);
    assert.equal(r.status, 200);
    assert.match(r.text, /"content":"hi"/);
    assert.equal(gw.seen.length, 1);
    assert.equal(gw.seen[0].url, '/v1/chat/completions');
    assert.equal(gw.seen[0].auth, 'Bearer real-key');
    assert.equal(gw.seen[0].body.temperature, 0.7);
    assert.equal(gw.seen[0].body.top_p, 0.8);
    assert.equal(gw.seen[0].body.stream_options.include_usage, true);
    const t = meter.totals();
    assert.equal(t.calls, 1);
    assert.equal(t.promptTokens, 120);
    assert.equal(t.completionTokens, 7);
    meter.reset();
    assert.equal(meter.totals().calls, 0);
  } finally { await meter.close(); await gw.close(); }
});

test('meter: drops forced non-standard fields after the gateway rejects them, and keeps them out', async () => {
  const gw = await fakeGateway({ rejectTopK: true });
  const meter = await startMeter({ upstream: gw.url, apiKey: 'k', force: { temperature: 0.7, top_k: 20 }, droppable: ['top_k', 'repetition_penalty'] });
  try {
    const r = await post(`${meter.url}/chat/completions`, { model: 'm', stream: true, messages: [] });
    assert.equal(r.status, 200);
    assert.equal(gw.seen.length, 2);
    assert.equal(gw.seen[1].body.top_k, undefined);
    assert.equal(gw.seen[1].body.temperature, 0.7);
    await post(`${meter.url}/chat/completions`, { model: 'm', stream: true, messages: [] });
    assert.equal(gw.seen.length, 3, 'no second rejection');
    assert.deepEqual(meter.forced(), { temperature: 0.7 });
    assert.equal(meter.totals().calls, 2);
  } finally { await meter.close(); await gw.close(); }
});

test('meter: reports a gateway that cannot be reached as a failed call', async () => {
  const meter = await startMeter({ upstream: 'http://127.0.0.1:9/v1', apiKey: 'k' });
  try {
    const r = await post(`${meter.url}/chat/completions`, { model: 'm', messages: [] });
    assert.equal(r.status, 502);
    assert.equal(meter.totals().failedCalls, 1);
  } finally { await meter.close(); }
});

test('meter helpers: usage from SSE and request rewriting', () => {
  assert.deepEqual(usageFromSse('data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n'), { prompt: 5, completion: 2 });
  assert.equal(usageFromSse('data: [DONE]\n'), undefined);
  const { body, stream } = rewriteChatBody(Buffer.from('{"stream":false,"temperature":1}'), { temperature: 0.2 });
  assert.equal(stream, false);
  assert.deepEqual(JSON.parse(body.toString()), { stream: false, temperature: 0.2 });
  assert.equal(rewriteChatBody(Buffer.from('not json')).body.toString(), 'not json');
});

test('cline: isolated settings, explicit provider, no route out and no gateway secrets', async () => {
  const home = await tmpDir();
  const cfg = { bin: 'x', baseUrl: 'http://127.0.0.1:5000/v1', apiKey: 'placeholder', model: 'qwen', home };
  setupClineHome(cfg);
  const providers = JSON.parse(fs.readFileSync(path.join(home, 'data', 'settings', 'providers.json'), 'utf8'));
  assert.equal(providers.providers['openai-compatible'].settings.baseUrl, cfg.baseUrl);
  assert.equal(providers.providers['openai-compatible'].settings.apiKey, 'placeholder');

  const args = clineArgs(cfg, 'repo', 'fix it', 120);
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(at('-P'), 'openai-compatible');
  assert.equal(at('-m'), 'qwen');
  assert.ok(path.isAbsolute(at('-c')) && path.isAbsolute(at('--data-dir')), 'Cline resolves relative paths against --cwd');
  assert.ok(args.includes('--yolo') && args.includes('--json'));
  assert.equal(args[args.length - 1], 'fix it');

  const env = clineEnv(cfg, { PATH: 'p', INFRAON_EVAL_API_KEY: 'secret', OPENAI_API_KEY: 'o', https_proxy: 'http://corp:8080' });
  assert.equal(env.INFRAON_EVAL_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:9');
  assert.equal(env.https_proxy, 'http://127.0.0.1:9');
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost');
  assert.equal(env.DO_NOT_TRACK, '1');
  assert.equal(env.PATH, 'p');
});

test('cline: launcher resolution and event summary', async () => {
  const dir = await tmpDir();
  const launcher = path.join(dir, 'node_modules', 'cline', 'bin', 'cline');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, '#!/usr/bin/env node\n');
  assert.deepEqual(clineLauncher(dir), { cmd: process.execPath, args: [launcher] });
  assert.throws(() => clineLauncher(path.join(dir, 'missing')), /not found/);

  const ev = (o: unknown) => JSON.stringify(o);
  const s = summarizeClineEvents([
    ev({ type: 'agent_event', event: { type: 'content_start', toolName: 'read_files' } }),
    ev({ type: 'agent_event', event: { type: 'content_start', toolName: 'editor' } }),
    ev({ type: 'agent_event', event: { type: 'content_start', toolName: 'editor' } }),
    ev({ type: 'agent_event', event: { type: 'content_start' } }),
    'not json',
    ev({ type: 'run_result', finishReason: 'completed', iterations: 4, text: 'All tests pass.' }),
  ]);
  assert.deepEqual(s, { toolCalls: { read_files: 1, editor: 2 }, finishReason: 'completed', iterations: 4, lastText: 'All tests pass.' });
});

test('eval args: --agent and Cline options', () => {
  const a = parseArgs(['--agent', 'both', '--cline', 'D:/tools/cline', '--native-sampling']);
  assert.ok(typeof a !== 'string');
  assert.deepEqual(a.agents, ['infraon', 'cline']);
  assert.equal(a.cline, 'D:/tools/cline');
  assert.equal(a.nativeSampling, true);
  const d = parseArgs([]);
  assert.ok(typeof d !== 'string');
  assert.deepEqual(d.agents, ['infraon']);
  assert.match(String(parseArgs(['--agent', 'copilot'])), /infraon, cline or both/);
});

test('comparison report: per task and per agent, naming the tasks where the agents differ', () => {
  const run = (agent: 'infraon' | 'cline', task: string, passed: boolean, durationMs: number): RunResult => ({
    agent, task, run: 1, passed, reason: passed ? 'passed' : 'check failed', durationMs, llmCalls: 4, promptTokens: 1000, completionTokens: 100,
    llmMs: durationMs / 2, avgFirstByteMs: 300, failedLlmCalls: 0, toolCalls: {}, filesChanged: [], checkOutput: '', logFile: '', timedOut: false,
  });
  const sum = (rs: RunResult[]) => ({
    tasks: 2, runs: rs.length, passed: rs.filter((r) => r.passed).length, passRate: rs.filter((r) => r.passed).length / rs.length,
    perTask: Object.fromEntries(['a', 'b'].map((t) => [t, { passed: rs.filter((r) => r.task === t && r.passed).length, runs: rs.filter((r) => r.task === t).length }])),
  });
  const runs = [run('infraon', 'a', true, 10_000), run('cline', 'a', true, 20_000), run('infraon', 'b', true, 30_000), run('cline', 'b', false, 40_000)];
  const rep: EvalReport = {
    startedAt: '', model: 'qwen', effort: 'medium', repeat: 1, agents: ['infraon', 'cline'], runs, summary: sum(runs),
    byAgent: { infraon: sum(runs.filter((r) => r.agent === 'infraon')), cline: sum(runs.filter((r) => r.agent === 'cline')) },
    forcedSampling: { temperature: 0.7 },
  };
  const out = formatReport(rep);
  assert.match(out, /infraon pass/);
  assert.match(out, /infraon\s+100\.0%\s+2\/2\s+20\.0 s/);
  assert.match(out, /cline\s+50\.0%\s+1\/2\s+30\.0 s/);
  assert.match(out, /same sampling for all agents: temperature=0\.7/);
  assert.match(out, /Tasks where results differ: b/);
});
