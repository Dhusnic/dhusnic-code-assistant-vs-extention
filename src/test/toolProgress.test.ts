/**
 * Live progress while the model writes a tool call: the stream reports name, size and target path (throttled),
 * every LlmFn wrapper passes the callback through, the agent hands it to the UI, and the runtime turns it into
 * the status line ("Writing index.html… 14.2 KB").
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { AddressInfo } from 'net';
import { Agent, AgentUi } from '../core/agent';
import { LlmFn, ToolCallProgress, streamChatOnce, toolCallProgress, withRetry } from '../core/llm';
import { withSamplingFallback } from '../core/sampling';
import { toolWritingLabel } from '../core/runtime';
import { recordingUi, text } from './helpers';

const sse = (res: http.ServerResponse, obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const args = (a: string) => ({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: a } }] } }] });

test('toolCallProgress reads the path only once its JSON string is complete, and unescapes it', () => {
  const call = (a: string) => ({ id: '', type: 'function' as const, function: { name: 'write_file', arguments: a } });
  assert.equal(toolCallProgress(0, call('{"path":"src/ind')).path, undefined);
  assert.deepEqual(toolCallProgress(0, call('{"path":"src/index.html","content":"<h')), { index: 0, name: 'write_file', chars: 38, path: 'src/index.html' });
  assert.equal(toolCallProgress(0, call('{"path": "C:\\\\w\\\\a \\"b\\".ts"')).path, 'C:\\w\\a "b".ts');
  assert.equal(toolCallProgress(1, call('{"file_path":"x.py"')).path, 'x.py');
});

test('stream: reports tool-call progress with name, path and growing size, throttled', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'write_file', arguments: '' } }] } }] });
      sse(res, args('{"path":"web/index.html",'));
      // Many small chunks in one burst: the throttle keeps reports far fewer than chunks.
      for (let i = 0; i < 200; i++) { sse(res, args('"x')); }
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] }, finish_reason: 'tool_calls' }] });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const seen: ToolCallProgress[] = [];
    const cfg = { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm', temperature: 0, allowSelfSigned: false, idleTimeoutMs: 2000 };
    const r = await streamChatOnce(cfg, [], [], () => {}, new AbortController().signal, (p) => seen.push(p));
    assert.equal(r.toolCalls[0].function.name, 'write_file');
    assert.ok(seen.length >= 2 && seen.length < 20, `got ${seen.length} reports`);
    assert.equal(seen[0].name, 'write_file');
    assert.equal(seen[0].path, undefined);
    assert.equal(seen[1].path, 'web/index.html', 'a newly known path is reported at once');
    for (let i = 1; i < seen.length; i++) { assert.ok(seen[i].chars >= seen[i - 1].chars); }
  } finally { await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); }
});

test('stream: a throwing progress callback does not break the reply', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }, finish_reason: 'tool_calls' }] });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const cfg = { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm', temperature: 0, allowSelfSigned: false, idleTimeoutMs: 2000 };
    const r = await streamChatOnce(cfg, [], [], () => {}, new AbortController().signal, () => { throw new Error('ui'); });
    assert.equal(r.toolCalls[0].function.arguments, '{"path":"a"}');
  } finally { await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); }
});

test('withRetry and withSamplingFallback pass the progress callback through', async () => {
  let got: unknown;
  const inner: LlmFn = async (_c, _m, _t, _o, _s, onToolProgress) => { got = onToolProgress; return text('ok'); };
  const cb = () => {};
  const cfg = { baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: false };
  await withRetry(withSamplingFallback(inner))(cfg, [], [], () => {}, new AbortController().signal, cb);
  assert.equal(got, cb);
});

test('agent: progress from the model call reaches ui.toolWriting', async () => {
  const llm: LlmFn = async (_c, _m, _t, onToken, _s, onToolProgress) => {
    onToolProgress?.({ index: 0, name: 'write_file', chars: 2048, path: 'index.html' });
    onToken('done');
    return text('done');
  };
  const seen: ToolCallProgress[] = [];
  const ui: AgentUi = { ...recordingUi(true), toolWriting: (p) => seen.push(p) };
  const agent = new Agent({ root: '/w', llm, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: false }), tools: () => [] });
  await agent.send('make a page', { mode: 'auto', effort: 'low', model: 'm' }, ui);
  assert.deepEqual(seen, [{ index: 0, name: 'write_file', chars: 2048, path: 'index.html' }]);
});

test('toolWritingLabel names the file and size for edits, and the tool otherwise', () => {
  assert.equal(toolWritingLabel({ index: 0, name: 'write_file', chars: 14540, path: 'src/web/index.html' }), 'Writing index.html… 14.2 KB');
  assert.equal(toolWritingLabel({ index: 0, name: 'edit_file', chars: 300, path: 'C:\\w\\app.ts' }), 'Editing app.ts… 300 B');
  assert.equal(toolWritingLabel({ index: 0, name: 'multi_edit', chars: 10, path: 'a.ts' }), 'Editing a.ts… 10 B');
  assert.equal(toolWritingLabel({ index: 0, name: 'write_file', chars: 40 }), 'Preparing write_file… 40 B');
  assert.equal(toolWritingLabel({ index: 0, name: 'run_command', chars: 2048 }), 'Preparing run_command… 2.0 KB');
});
