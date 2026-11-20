import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { AddressInfo } from 'net';
import { contextLimitFromError, contextWindowFrom, fetchContextWindow, isContextLengthError } from '../core/modelInfo';

/* ------------------------------------------------------------------ parsing */

test('contextWindowFrom: each gateway field is read', () => {
  const cases: Array<[object, number]> = [
    [{ id: 'm', max_model_len: 32768 }, 32768],
    [{ id: 'm', context_length: 131072 }, 131072],
    [{ id: 'm', context_window: 200000 }, 200000],
    [{ id: 'm', max_context_length: 8192 }, 8192],
    [{ id: 'm', max_input_tokens: 65536 }, 65536],
    [{ id: 'm', top_provider: { context_length: 100000 } }, 100000],
    [{ id: 'm', meta: { n_ctx_train: 4096 } }, 4096],
    [{ id: 'm', max_tokens: 16384 }, 16384],
    [{ id: 'm', max_model_len: '40960' }, 40960],
  ];
  for (const [entry, want] of cases) { assert.equal(contextWindowFrom({ data: [entry] }, 'm'), want, JSON.stringify(entry)); }
});

test('contextWindowFrom: max_tokens counts only when large and nothing better exists', () => {
  assert.equal(contextWindowFrom({ data: [{ id: 'm', max_tokens: 4096 }] }, 'm'), undefined);
  assert.equal(contextWindowFrom({ data: [{ id: 'm', max_tokens: 100000, max_model_len: 32768 }] }, 'm'), 32768);
});

test('contextWindowFrom: matches the model id; one entry is used as a fallback; otherwise undefined', () => {
  const body = { data: [{ id: 'a', max_model_len: 1000 }, { id: 'qwen', max_model_len: 32768 }] };
  assert.equal(contextWindowFrom(body, 'qwen'), 32768);
  assert.equal(contextWindowFrom(body, 'missing'), undefined);
  assert.equal(contextWindowFrom({ data: [{ id: 'only', max_model_len: 8192 }] }, 'other-name'), 8192);
});

test('contextWindowFrom: missing, invalid or junk values are undefined', () => {
  assert.equal(contextWindowFrom({ data: [{ id: 'm' }] }, 'm'), undefined);
  assert.equal(contextWindowFrom({ data: [{ id: 'm', max_model_len: -1, context_length: 0, context_window: 'abc' }] }, 'm'), undefined);
  assert.equal(contextWindowFrom(null, 'm'), undefined);
  assert.equal(contextWindowFrom('nope', 'm'), undefined);
  assert.equal(contextWindowFrom({ data: 'x' }, 'm'), undefined);
});

/* ------------------------------------------------------------------ errors */

test('isContextLengthError: real-world messages are recognized', () => {
  const yes = [
    "LLM HTTP 400: {\"object\":\"error\",\"message\":\"This model's maximum context length is 32768 tokens. However, you requested 40000 tokens (39000 in the messages, 1000 in the completion). Please reduce the length of the messages or completion.\"}",
    'LLM HTTP 400: {"error":{"code":"context_length_exceeded","message":"This model\'s maximum context length is 128000 tokens."}}',
    'LLM HTTP 400: {"error":{"message":"the request exceeds the available context size (8192 tokens), try increasing it"}}',
    'LLM HTTP 413: prompt is too long',
    'input is too long for the model',
  ];
  for (const m of yes) { assert.ok(isContextLengthError(new Error(m)), m); }
});

test('isContextLengthError: other errors, and 5xx that mention tokens, are not', () => {
  const no = [
    'LLM HTTP 500: internal error while counting too many tokens in the cache',
    'LLM HTTP 503: busy',
    'LLM HTTP 401: invalid api key',
    'LLM HTTP 400: invalid tool schema',
    'ECONNRESET',
    '',
  ];
  for (const m of no) { assert.ok(!isContextLengthError(new Error(m)), m); }
  assert.ok(!isContextLengthError(undefined));
});

test('contextLimitFromError: the stated limit is extracted', () => {
  assert.equal(contextLimitFromError(new Error("This model's maximum context length is 32768 tokens. However, you requested 40000 tokens")), 32768);
  assert.equal(contextLimitFromError(new Error('LLM HTTP 400: This model\'s maximum context length is 128,000 tokens.')), 128000);
  assert.equal(contextLimitFromError(new Error('the request exceeds the available context size (8192 tokens), try increasing it')), 8192);
  assert.equal(contextLimitFromError(new Error('prompt is too long')), undefined);
  assert.equal(contextLimitFromError('maximum input length is 4096 tokens'), 4096);
});

/* ------------------------------------------------------------------ fetching */

async function serve(handler: http.RequestListener): Promise<{ baseUrl: string; close: () => Promise<void>; seen: string[] }> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => { seen.push(`${req.method} ${req.url} ${req.headers.authorization}`); handler(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`, seen,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

const cfg = (baseUrl: string) => ({ baseUrl, apiKey: 'k', model: 'qwen', temperature: 0, allowSelfSigned: false });

test('fetchContextWindow: reads the window from the gateway', async () => {
  const s = await serve((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'qwen', max_model_len: 65536 }] })); });
  try {
    assert.equal(await fetchContextWindow(cfg(s.baseUrl), 'qwen'), 65536);
    assert.deepEqual(s.seen, ['GET /v1/models Bearer k']);
  } finally { await s.close(); }
});

test('fetchContextWindow: garbage, HTTP errors and unreachable gateways give undefined', async () => {
  const s = await serve((req, res) => {
    if (req.url?.includes('bad')) { res.statusCode = 500; res.end('oops'); return; }
    res.end('not json');
  });
  try {
    assert.equal(await fetchContextWindow(cfg(s.baseUrl), 'qwen'), undefined);
    assert.equal(await fetchContextWindow(cfg(`${s.baseUrl}/bad`), 'qwen'), undefined);
  } finally { await s.close(); }
  assert.equal(await fetchContextWindow(cfg('http://127.0.0.1:1/v1'), 'qwen'), undefined);
  assert.equal(await fetchContextWindow(cfg('not a url'), 'qwen'), undefined);
});

test('fetchContextWindow: a gateway that never answers times out with undefined', async () => {
  const s = await serve(() => { /* never responds */ });
  try {
    const start = Date.now();
    assert.equal(await fetchContextWindow(cfg(s.baseUrl), 'qwen', 200), undefined);
    assert.ok(Date.now() - start < 2000);
  } finally { await s.close(); }
});
