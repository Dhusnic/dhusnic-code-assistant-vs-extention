/**
 * Sampling per model family (core/sampling.ts): which profile a model id gets, how user overrides take precedence,
 * what ends up in the request body, and the one retry without the non-standard fields when a gateway rejects them.
 * The request-body tests use a local HTTP server on 127.0.0.1 standing in for the gateway; nothing leaves the machine.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { AddressInfo } from 'net';
import { LlmConfig, LlmFn, streamChat, streamChatOnce } from '../core/llm';
import { DEFAULT_TEMPERATURE, isUnsupportedParamError, profileFor, resolveSampling, sanitizeOverride, withSamplingFallback } from '../core/sampling';
import { effortParams, EFFORTS } from '../core/policy';

test('profiles: model ids map to their family, case-insensitively and with vendor prefixes', () => {
  const cases: [string, string][] = [
    ['Qwen/Qwen3-Coder-480B-A35B-Instruct', 'qwen3-coder'],
    ['qwen3-coder:30b', 'qwen3-coder'],
    ['hosted_vllm/QWEN3-CODER-30B-A3B', 'qwen3-coder'],
    ['Qwen/Qwen3-235B-A22B-Thinking-2507', 'qwen3-thinking'],
    ['Qwen/Qwen3-32B', 'qwen3'],
    ['Qwen2.5-Coder-32B-Instruct', 'qwen2.5'],
    ['qwen2.5-72b-instruct', 'qwen2.5'],
    ['deepseek-ai/DeepSeek-R1-Distill-Qwen-32B', 'deepseek-r1'],
    ['deepseek-r1', 'deepseek-r1'],
    ['DeepSeek-V3-0324', 'deepseek-v3'],
    ['deepseek-chat', 'deepseek-v3'],
    ['deepseek-coder-v2-instruct', 'deepseek-coder'],
    ['Qwen/QwQ-32B', 'qwq'],
    ['openai/gpt-oss-120b', 'gpt-oss'],
    ['moonshotai/Kimi-K2-Instruct', 'kimi-k2'],
    ['zai-org/GLM-4.6', 'glm-4.5+'],
    ['mistralai/Devstral-Small-2505', 'mistral'],
    ['codestral-latest', 'mistral'],
    ['magistral-small', 'magistral'],
    ['meta-llama/Llama-3.3-70B-Instruct', 'llama'],
    ['company-coder-v1', 'default'],
    ['glm-4-9b-chat', 'default'],
  ];
  for (const [id, want] of cases) { assert.equal(profileFor(id).name, want, id); }
});

test('profiles: whole-word match only (no family is found inside an unrelated word)', () => {
  assert.equal(profileFor('myqwen3-coder').name, 'default');
  assert.equal(profileFor('qwen30').name, 'default');
  assert.equal(profileFor('notllama').name, 'default');
});

test('qwen3-coder gets its published sampling; unknown models get the conservative default', () => {
  assert.deepEqual(resolveSampling('qwen3-coder-30b'), { temperature: 0.7, sampling: { top_p: 0.8, top_k: 20, repetition_penalty: 1.05 } });
  assert.deepEqual(resolveSampling('company-model'), { temperature: DEFAULT_TEMPERATURE, sampling: {} });
});

test('precedence: explicit user values > model profile > default; null removes a profile value', () => {
  const r = resolveSampling('qwen3-coder', { temperature: 0.3, top_k: null, presence_penalty: 0.5 });
  assert.deepEqual(r, { temperature: 0.3, sampling: { top_p: 0.8, repetition_penalty: 1.05, presence_penalty: 0.5 } });
  // A null temperature falls back to the default rather than leaving the request without one.
  assert.equal(resolveSampling('qwen3-coder', { temperature: null }).temperature, DEFAULT_TEMPERATURE);
  // The host spreads the Temperature setting first and the Sampling object over it, so the object wins.
  const user = { ...sanitizeOverride({ temperature: 0.5 }), ...sanitizeOverride({ temperature: 0.1 }) };
  assert.equal(resolveSampling('llama-3', user).temperature, 0.1);
  // An unset Temperature (undefined) does not hide the profile.
  assert.equal(resolveSampling('gpt-oss-20b', sanitizeOverride({ temperature: undefined })).temperature, 1.0);
});

test('sanitizeOverride: drops unknown keys and out-of-range or non-numeric values', () => {
  assert.deepEqual(sanitizeOverride({ temperature: 5, top_p: 0, top_k: 2.5, repetition_penalty: '1.1', foo: 1, presence_penalty: -1 }), { presence_penalty: -1 });
  assert.deepEqual(sanitizeOverride(null), {});
  assert.deepEqual(sanitizeOverride([1, 2]), {});
});

test('effort no longer sets the temperature', () => {
  for (const e of EFFORTS) { assert.equal('temperature' in effortParams(e), false, e); }
});

test('isUnsupportedParamError: recognises rejected-parameter replies only', () => {
  for (const m of [
    'LLM HTTP 400: {"error":{"message":"Unrecognized request argument supplied: top_k"}}',
    'LLM HTTP 400: Unknown parameter: repetition_penalty',
    'LLM HTTP 422: {"detail":[{"type":"extra_forbidden","loc":["body","foo"]}]}',
    'LLM HTTP 400: extra fields not permitted',
    'LLM HTTP 400: unsupported parameter',
  ]) { assert.ok(isUnsupportedParamError(new Error(m)), m); }
  for (const m of ['LLM HTTP 400: context length exceeded', 'LLM HTTP 500: top_k', 'LLM HTTP 401: bad key']) {
    assert.ok(!isUnsupportedParamError(new Error(m)), m);
  }
});

/* ---------------------------------------------------------------- local gateway */

type Reply = (res: http.ServerResponse, body: Record<string, unknown>, n: number) => void;

async function gateway(reply: Reply) {
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => { const b = JSON.parse(raw); bodies.push(b); reply(res, b, bodies.length); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    bodies,
    cfg: (extra: Partial<LlmConfig> = {}): LlmConfig => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm', temperature: 0.2, allowSelfSigned: false, ...extra }),
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

const ok = (res: http.ServerResponse) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
};
const rejectExtras: Reply = (res, body) => {
  if ('top_k' in body || 'repetition_penalty' in body) { res.writeHead(400); res.end('{"error":{"message":"Unrecognized request argument supplied: top_k"}}'); return; }
  ok(res);
};
const signal = () => new AbortController().signal;

test('request body: sampling fields are sent only when defined', async () => {
  const gw = await gateway((res) => ok(res));
  try {
    const { temperature, sampling } = resolveSampling('qwen3-coder');
    await streamChatOnce(gw.cfg({ temperature, sampling }), [{ role: 'user', content: 'hi' }], [], () => {}, signal());
    await streamChatOnce(gw.cfg(), [{ role: 'user', content: 'hi' }], [], () => {}, signal());
    await streamChatOnce(gw.cfg({ sampling: { top_p: 0.9, top_k: undefined } }), [], [], () => {}, signal());
    const [a, b, c] = gw.bodies;
    assert.equal(a.temperature, 0.7);
    assert.equal(a.top_p, 0.8);
    assert.equal(a.top_k, 20);
    assert.equal(a.repetition_penalty, 1.05);
    assert.equal('presence_penalty' in a, false);
    assert.equal(b.temperature, 0.2);
    for (const k of ['top_p', 'top_k', 'repetition_penalty', 'presence_penalty']) { assert.equal(k in b, false, k); }
    assert.equal(c.top_p, 0.9);
    assert.equal('top_k' in c, false);
  } finally { await gw.close(); }
});

test('fallback: a gateway that rejects top_k is retried once without the non-standard fields, then remembered', async () => {
  const gw = await gateway(rejectExtras);
  try {
    const cfg = gw.cfg({ temperature: 0.7, sampling: { top_p: 0.8, top_k: 20, repetition_penalty: 1.05 } });
    const r = await streamChat(cfg, [{ role: 'user', content: 'hi' }], [], () => {}, signal());
    assert.equal(r.content, 'ok');
    assert.equal(gw.bodies.length, 2);
    assert.equal(gw.bodies[0].top_k, 20);
    assert.equal('top_k' in gw.bodies[1], false);
    assert.equal('repetition_penalty' in gw.bodies[1], false);
    assert.equal(gw.bodies[1].top_p, 0.8, 'standard fields are kept');
    assert.equal(gw.bodies[1].temperature, 0.7);
    // The same gateway and model are not asked with the extras again.
    await streamChat(cfg, [{ role: 'user', content: 'again' }], [], () => {}, signal());
    assert.equal(gw.bodies.length, 3);
    assert.equal('top_k' in gw.bodies[2], false);
  } finally { await gw.close(); }
});

test('fallback: other errors, and requests without extras, are not retried by it', async () => {
  let n = 0;
  const failing: LlmFn = async () => { n++; throw new Error('LLM HTTP 400: Unknown parameter: top_k'); };
  const cfg: LlmConfig = { baseUrl: 'x', apiKey: '', model: 'm', temperature: 0.2, allowSelfSigned: false };
  await assert.rejects(withSamplingFallback(failing)(cfg, [], [], () => {}, signal()), /400/);
  assert.equal(n, 1, 'nothing to strip, so no retry');

  n = 0;
  const other: LlmFn = async () => { n++; throw new Error('LLM HTTP 400: context length exceeded'); };
  await assert.rejects(withSamplingFallback(other)({ ...cfg, sampling: { top_k: 20 } }, [], [], () => {}, signal()), /context length/);
  assert.equal(n, 1);

  n = 0;
  const always: LlmFn = async () => { n++; throw new Error('LLM HTTP 400: Unknown parameter: top_k'); };
  await assert.rejects(withSamplingFallback(always)({ ...cfg, sampling: { top_k: 20 } }, [], [], () => {}, signal()), /400/);
  assert.equal(n, 2, 'retried exactly once');
});
