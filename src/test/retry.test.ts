import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { LlmFn, isTransientError, withRetry } from '../core/llm';

const CFG = { baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true };
const run = (fn: LlmFn, signal = new AbortController().signal, onToken: (t: string) => void = () => {}) => withRetry(fn, { retries: 3, baseDelayMs: 1 })(CFG, [], [], onToken, signal);

test('isTransientError: gateway and network errors are transient, client errors are not', () => {
  for (const m of ['LLM HTTP 502: <html>', 'LLM HTTP 503: x', 'LLM HTTP 504: x', 'LLM HTTP 429: slow down', 'read ECONNRESET', 'socket hang up']) { assert.ok(isTransientError(new Error(m)), m); }
  for (const m of ['LLM HTTP 400: bad request', 'LLM HTTP 401: nope', 'LLM HTTP 5021: no', 'Cancelled']) { assert.ok(!isTransientError(new Error(m)), m); }
});

test('retry: recovers after transient failures and returns the result', async () => {
  let n = 0;
  const fn: LlmFn = async () => { if (++n < 3) { throw new Error('LLM HTTP 502: bad gateway'); } return { content: 'ok', toolCalls: [] }; };
  assert.equal((await run(fn)).content, 'ok');
  assert.equal(n, 3);
});

test('retry: gives up after the configured number of retries and rethrows', async () => {
  let n = 0;
  const fn: LlmFn = async () => { n++; throw new Error('LLM HTTP 503: down'); };
  await assert.rejects(run(fn), /503/);
  assert.equal(n, 4);
});

test('retry: non-transient errors are not retried', async () => {
  let n = 0;
  const fn: LlmFn = async () => { n++; throw new Error('LLM HTTP 401: invalid key'); };
  await assert.rejects(run(fn), /401/);
  assert.equal(n, 1);
});

test('retry: never retries once tokens were streamed (no duplicated output)', async () => {
  let n = 0; const got: string[] = [];
  const fn: LlmFn = async (_c, _m, _t, onToken) => { n++; onToken('partial'); throw new Error('read ECONNRESET'); };
  await assert.rejects(run(fn, undefined, (t) => got.push(t)), /ECONNRESET/);
  assert.equal(n, 1);
  assert.deepEqual(got, ['partial']);
});

test('retry: abort during backoff cancels promptly', async () => {
  const ac = new AbortController();
  const fn: LlmFn = async () => { throw new Error('LLM HTTP 502: x'); };
  const slow = withRetry(fn, { retries: 3, baseDelayMs: 5000 });
  setTimeout(() => ac.abort(), 30);
  const t0 = Date.now();
  await assert.rejects(slow(CFG, [], [], () => {}, ac.signal), /Cancelled|502/);
  assert.ok(Date.now() - t0 < 1500);
});
