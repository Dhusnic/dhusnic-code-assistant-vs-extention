import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { AddressInfo } from 'net';
import { LlmConfig, isTransientError, streamChatOnce, withRetry } from '../core/llm';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void;

/** A local OpenAI-style gateway; `handler` gets the request number (1-based). Always closed by the caller. */
async function gateway(handler: Handler): Promise<{ cfg: (idleMs?: number) => LlmConfig; close: () => Promise<void>; requests: () => number }> {
  let n = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => handler(req, res, ++n));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    cfg: (idleMs) => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm', temperature: 0, allowSelfSigned: false, idleTimeoutMs: idleMs }),
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
    requests: () => n,
  };
}

const sse = (res: http.ServerResponse, obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const head = (res: http.ServerResponse) => res.writeHead(200, { 'Content-Type': 'text/event-stream' });
const token = (t: string) => ({ choices: [{ delta: { content: t } }] });
const noop = () => {};
const signal = () => new AbortController().signal;

test('stream: a normal reply resolves with content, tool calls and finish reason', async () => {
  const gw = await gateway((_q, res) => {
    head(res);
    sse(res, token('Hel'));
    sse(res, token('lo'));
    sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'read_file', arguments: '{"path":' } }] } }] });
    sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: 'tool_calls' }] });
    res.end('data: [DONE]\n\n');
  });
  try {
    const tokens: string[] = [];
    const r = await streamChatOnce(gw.cfg(1000), [{ role: 'user', content: 'hi' }], [], (t) => tokens.push(t), signal());
    assert.equal(r.content, 'Hello');
    assert.deepEqual(tokens, ['Hel', 'lo']);
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].function.name, 'read_file');
    assert.equal(r.toolCalls[0].function.arguments, '{"path":"a.ts"}');
    assert.equal(r.finishReason, 'tool_calls');
  } finally { await gw.close(); }
});

test('stream: a gateway that accepts but never answers is ended as stalled', async () => {
  const gw = await gateway(() => { /* never respond */ });
  try {
    const started = Date.now();
    await assert.rejects(streamChatOnce(gw.cfg(200), [], [], noop, signal()), /stalled/);
    assert.ok(Date.now() - started < 2000);
  } finally { await gw.close(); }
});

test('stream: tokens then silence is ended as stalled; the stall error is transient', async () => {
  const gw = await gateway((_q, res) => { head(res); sse(res, token('partial')); });
  try {
    await assert.rejects(streamChatOnce(gw.cfg(200), [], [], noop, signal()), (e: Error) => {
      assert.match(e.message, /stalled/);
      assert.ok(isTransientError(e));
      return true;
    });
  } finally { await gw.close(); }
});

test('stream: the idle timer restarts on every chunk, so a slow but steady stream succeeds', async () => {
  const gw = await gateway((_q, res) => {
    head(res);
    let i = 0;
    const timer = setInterval(() => {
      if (i < 10) { sse(res, token(String(i++))); return; }
      clearInterval(timer);
      res.end('data: [DONE]\n\n');
    }, 100);
  });
  try {
    const r = await streamChatOnce(gw.cfg(250), [], [], noop, signal());
    assert.equal(r.content, '0123456789');
  } finally { await gw.close(); }
});

test('retry: a stall before any text is retried and succeeds', async () => {
  const gw = await gateway((_q, res, n) => {
    if (n === 1) { return; }
    head(res);
    sse(res, token('ok'));
    res.end('data: [DONE]\n\n');
  });
  try {
    const r = await withRetry(streamChatOnce, { baseDelayMs: 10 })(gw.cfg(200), [], [], noop, signal());
    assert.equal(r.content, 'ok');
    assert.equal(gw.requests(), 2);
  } finally { await gw.close(); }
});

test('retry: a stall after text was shown is not retried (output would repeat)', async () => {
  const gw = await gateway((_q, res) => { head(res); sse(res, token('shown')); });
  try {
    await assert.rejects(withRetry(streamChatOnce, { baseDelayMs: 10 })(gw.cfg(200), [], [], noop, signal()), /stalled/);
    assert.equal(gw.requests(), 1);
  } finally { await gw.close(); }
});

test('cancel: aborting rejects with Cancelled and leaves no timer running', async () => {
  const gw = await gateway((_q, res) => { head(res); sse(res, token('x')); });
  try {
    const ac = new AbortController();
    const p = streamChatOnce(gw.cfg(60_000), [], [], noop, ac.signal);
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(p, /Cancelled/);
    // A leftover 60 s idle timer would keep this test file running; node --test finishing quickly shows it is cleared.
  } finally { await gw.close(); }
});

test('stream: a socket destroyed mid-reply rejects instead of returning a partial answer', async () => {
  const gw = await gateway((_q, res) => {
    head(res);
    sse(res, token('half'));
    setTimeout(() => res.socket?.destroy(), 50);
  });
  try {
    await assert.rejects(streamChatOnce(gw.cfg(5000), [], [], noop, signal()));
  } finally { await gw.close(); }
});

test('stream: HTTP errors are still reported with their status', async () => {
  const gw = await gateway((_q, res) => { res.writeHead(503); res.end('busy'); });
  try {
    await assert.rejects(streamChatOnce(gw.cfg(1000), [], [], noop, signal()), /LLM HTTP 503: busy/);
  } finally { await gw.close(); }
});
