/**
 * Fill-in-the-middle inline completions (core/fim.ts, the FIM path of core/completion.ts, llm.completeText): model
 * family detection, prompt formats per family, stop-token and suffix-overlap post-processing, and the auto-mode
 * fallback to chat. The gateway tests use a local HTTP server on 127.0.0.1; nothing leaves the machine.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { AddressInfo } from 'net';
import { FIM_FORMATS, buildFimPrompt, cleanFim, fimFormatFor, limitToBlock, stripTokens, trimSuffixOverlap } from '../core/fim';
import { CompletionEngine, CompletionMode, buildCompletionMessages, isFimUnsupportedError } from '../core/completion';
import { LlmConfig, completeText, streamChatOnce } from '../core/llm';

const Q = FIM_FORMATS.qwen;

test('family: chosen by model id, only for code models with known FIM tokens', () => {
  const cases: [string, string | undefined][] = [
    ['qwen3-coder-next', 'qwen'], ['Qwen/Qwen3-Coder-30B-A3B-Instruct', 'qwen'], ['Qwen/Qwen2.5-Coder-7B', 'qwen'],
    ['hosted_vllm/qwen2.5-coder:32b', 'qwen'], ['Qwen/Qwen3-32B', undefined], ['qwen2.5-72b-instruct', undefined],
    ['deepseek-ai/deepseek-coder-6.7b-base', 'deepseek'], ['DeepSeek-Coder-V2-Lite-Base', 'deepseek'],
    ['DeepSeek-R1-Distill-Qwen-32B', undefined], ['bigcode/starcoder2-15b', 'starcoder'],
    ['codellama/CodeLlama-13b-hf', 'codellama'], ['gpt-4o', undefined], ['llama-3.1-70b', undefined],
  ];
  for (const [id, fam] of cases) { assert.equal(fimFormatFor(id)?.family, fam, id); }
});

test('prompt: Qwen uses prefix/suffix/middle tokens, and the repo-level format for other files', () => {
  assert.equal(buildFimPrompt(Q, { prefix: 'const a = ', suffix: ';\n', file: 'src/a.ts', language: 'typescript' }),
    '<|fim_prefix|>const a = <|fim_suffix|>;\n<|fim_middle|>');
  const p = buildFimPrompt(Q, {
    prefix: 'import { add } from "./math";\nadd(', suffix: ')', file: 'src/a.ts', language: 'typescript', repo: 'shop',
    context: [{ path: 'src/math.ts', text: 'export function add(a: number, b: number): number;', kind: 'import' }],
  });
  assert.equal(p, '<|fim_prefix|><|repo_name|>shop\n<|file_sep|>src/math.ts\nexport function add(a: number, b: number): number;\n'
    + '<|file_sep|>src/a.ts\nimport { add } from "./math";\nadd(<|fim_suffix|>)<|fim_middle|>');
});

test('prompt: DeepSeek, StarCoder and Code Llama formats; other files become line comments', () => {
  const input = { prefix: 'def f(x):\n    ', suffix: '\n', file: 'a.py', language: 'python', context: [{ path: 'b.py', text: 'def g(y): ...\n', kind: 'import' as const }] };
  assert.equal(buildFimPrompt(FIM_FORMATS.deepseek, input), '<｜fim▁begin｜># Path: b.py\n# def g(y): ...\n\ndef f(x):\n    <｜fim▁hole｜>\n<｜fim▁end｜>');
  assert.equal(buildFimPrompt(FIM_FORMATS.starcoder, { ...input, context: [] }), '<fim_prefix>def f(x):\n    <fim_suffix>\n<fim_middle>');
  assert.equal(buildFimPrompt(FIM_FORMATS.codellama, { ...input, context: [], language: 'typescript', prefix: 'x = ' }), '<PRE> x =  <SUF>\n <MID>');
  assert.match(buildFimPrompt(FIM_FORMATS.starcoder, { ...input, language: 'go' }), /^<fim_prefix>\/\/ Path: b\.py\n\/\/ def g/);
});

test('prompt: control tokens inside the user code are removed so they cannot break the prompt', () => {
  assert.equal(stripTokens('a<|fim_middle|>b<|endoftext|>c', Q), 'abc');
  const p = buildFimPrompt(Q, { prefix: 'x = "<|fim_suffix|>"', suffix: '', file: 'f.py', language: 'python' });
  assert.equal(p.split('<|fim_suffix|>').length, 2, 'only the real suffix token remains');
});

test('stops: every family stops at its FIM tokens and end-of-text / file separators', () => {
  for (const t of ['<|endoftext|>', '<|file_sep|>', '<|fim_prefix|>', '<|fim_middle|>', '<|repo_name|>']) { assert.ok(Q.stop.includes(t), t); }
  assert.ok(FIM_FORMATS.deepseek.stop.includes('<｜fim▁end｜>'));
  assert.ok(FIM_FORMATS.codellama.stop.includes('<EOT>'));
  assert.ok(FIM_FORMATS.starcoder.stop.includes('<file_sep>'));
});

test('clean: cuts at stop tokens the gateway did not strip', () => {
  assert.equal(cleanFim('items.length;<|endoftext|>garbage', 'const n = ', '\n', Q), 'items.length;');
  assert.equal(cleanFim('a + b\n<|file_sep|>other.ts\nexport const z = 1;', 'return ', '', Q), 'a + b');
  assert.equal(cleanFim('<|endoftext|>', 'x = ', '', Q), '');
});

test('clean: mid-statement completions keep only the first line', () => {
  assert.equal(limitToBlock('items.length;\nconsole.log(n);\nreturn n;', 'const n = '), 'items.length;');
  assert.equal(cleanFim('items.length;\nconsole.log(n);', '  const n = ', '\n}', Q), 'items.length;');
});

test('clean: a block opened at the cursor is kept to its end, and a closer already in the suffix is not repeated', () => {
  const prefix = 'function f(a) {';
  assert.equal(cleanFim('\n  if (a) {\n    return 1;\n  }\n  return 2;\n}\n\nfunction g() {}', prefix, '\n}\n', Q), '\n  if (a) {\n    return 1;\n  }\n  return 2;');
  assert.equal(limitToBlock('\n  return 2;\n}\nfunction g() {}', prefix), '\n  return 2;\n}', 'stops after the closing line');
  assert.equal(limitToBlock(' {\n  x();\n} else {\n  y();\n}\nz();', 'if (a)'), ' {\n  x();\n} else {\n  y();\n}', '} else { continues');
});

test('clean: on a blank line, stops when the code dedents out of the cursor block (Python)', () => {
  const prefix = 'class A:\n    def f(self):\n        ';
  assert.equal(cleanFim('x = 1\n        return x\n\n    def g(self):\n        pass', prefix, '\n', Q), 'x = 1\n        return x');
  assert.equal(cleanFim('\n    return x\n\ndef g():\n    pass', 'def f(x):', '\n', Q), '\n    return x', 'statement after the block is dropped');
});

test('clean: the tail that repeats the rest of the cursor line is trimmed', () => {
  assert.equal(trimSuffixOverlap('a, b)', ')'), 'a, b');
  assert.equal(cleanFim('a, b);', 'foo(', ');', Q), 'a, b');
  assert.equal(cleanFim('x', 'foo(', ');', Q), 'x');
  assert.equal(trimSuffixOverlap('\n  y();\n  z();', '\n  z();\n'), '\n  y();', 'a regenerated suffix line is cut');
  assert.equal(trimSuffixOverlap('\n  if (a) {\n    b();\n  }', '\n}'), '\n  if (a) {\n    b();\n  }', 'inner closers at another indent stay');
});

test('fallback: only "unsupported" gateway errors count, not transient ones', () => {
  for (const m of ['LLM HTTP 404: Not Found', 'LLM HTTP 400: {"error":"prompt"}', 'LLM HTTP 501: x', 'LLM HTTP 200 without choices[0].text: completions not supported']) {
    assert.equal(isFimUnsupportedError(new Error(m)), true, m);
  }
  for (const m of ['LLM HTTP 503: busy', 'LLM HTTP 429: slow down', 'ECONNRESET', 'Cancelled']) { assert.equal(isFimUnsupportedError(new Error(m)), false, m); }
});

test('chat prompt: other-file context is included before the file, marked as reference', () => {
  const m = buildCompletionMessages({ prefix: 'add(', suffix: ')', file: 'a.ts', language: 'typescript', context: [{ path: 'm.ts', text: 'export function add(a, b);', kind: 'import' }] });
  assert.match(m[1].content!, /Related code from other files[\s\S]*--- m\.ts \(signatures\)\nexport function add\(a, b\);[\s\S]*File: a\.ts \(typescript\)/);
});

// ---------------------------------------------------------------- local gateway

interface Seen { path: string; body: any }
async function gateway(completions: (res: http.ServerResponse, body: any) => void, chatText = 'chatResult') {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      const body = data ? JSON.parse(data) : undefined;
      seen.push({ path: req.url ?? '', body });
      if (req.url === '/v1/completions') { completions(res, body); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chatText } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const cfg = (model: string): LlmConfig => ({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model, temperature: 0.7, allowSelfSigned: false, maxTokens: 64 });
  return { seen, cfg, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
const json = (res: http.ServerResponse, status: number, obj: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const sig = () => new AbortController().signal;
const req = (prefix: string, suffix = '') => ({ prefix, suffix, language: 'typescript', file: 'src/a.ts' });
const engine = (cfg: LlmConfig, mode: CompletionMode) => new CompletionEngine(streamChatOnce, () => cfg, { completeText, mode: () => mode });

test('completeText: posts the raw prompt with stops, small max_tokens and low temperature; returns choices[0].text', async () => {
  const gw = await gateway((res) => json(res, 200, { choices: [{ text: 'items.length;' }] }));
  try {
    const e = engine(gw.cfg('qwen3-coder-next'), 'auto');
    assert.equal(await e.complete(req('const n = ', ';\n'), sig()), 'items.length');
    assert.equal(gw.seen.length, 1);
    const { path, body } = gw.seen[0];
    assert.equal(path, '/v1/completions');
    assert.equal(body.model, 'qwen3-coder-next');
    assert.equal(body.prompt, '<|fim_prefix|>const n = <|fim_suffix|>;\n<|fim_middle|>');
    assert.ok(body.stop.includes('<|endoftext|>') && body.stop.includes('<|file_sep|>'));
    assert.equal(body.max_tokens, 64);
    assert.equal(body.temperature, 0.1);
    assert.equal(body.stream, false);
    assert.equal(body.messages, undefined);
  } finally { await gw.close(); }
});

test('auto: a gateway without /completions (404) falls back to chat once and is remembered for the session', async () => {
  const gw = await gateway((res) => json(res, 404, { error: 'Not Found' }), 'fromChat');
  try {
    let cfg = gw.cfg('qwen3-coder-next');
    const e = new CompletionEngine(streamChatOnce, () => cfg, { completeText, mode: () => 'auto' });
    assert.equal(await e.complete(req('const a = '), sig()), 'fromChat');
    assert.deepEqual(gw.seen.map((s) => s.path), ['/v1/completions', '/v1/chat/completions']);
    assert.equal(await e.complete(req('const b = '), sig()), 'fromChat');
    assert.deepEqual(gw.seen.map((s) => s.path), ['/v1/completions', '/v1/chat/completions', '/v1/chat/completions'], 'no second /completions call');
    // Another model on the same gateway is tried on its own.
    cfg = gw.cfg('deepseek-coder-6.7b');
    assert.equal(await e.complete(req('const c = '), sig()), 'fromChat');
    assert.equal(gw.seen.filter((s) => s.path === '/v1/completions').length, 2);
  } finally { await gw.close(); }
});

test('auto: a transient failure is not remembered; explicit fim never falls back; chat and unknown models skip FIM', async () => {
  let status = 503;
  const gw = await gateway((res) => (status === 200 ? json(res, 200, { choices: [{ text: 'ok' }] }) : json(res, status, { error: 'x' })));
  try {
    const auto = engine(gw.cfg('qwen3-coder-next'), 'auto');
    assert.equal(await auto.complete(req('a = '), sig()), '');
    status = 200;
    assert.equal(await auto.complete(req('b = '), sig()), 'ok', 'FIM is tried again after a 503');
    assert.equal(gw.seen.filter((s) => s.path.endsWith('/chat/completions')).length, 0);

    status = 404;
    assert.equal(await engine(gw.cfg('qwen3-coder-next'), 'fim').complete(req('c = '), sig()), '');
    assert.equal(gw.seen.filter((s) => s.path.endsWith('/chat/completions')).length, 0, 'fim mode does not fall back');

    gw.seen.length = 0;
    await engine(gw.cfg('qwen3-coder-next'), 'chat').complete(req('d = '), sig());
    await engine(gw.cfg('gpt-4o'), 'auto').complete(req('e = '), sig());
    assert.deepEqual(gw.seen.map((s) => s.path), ['/v1/chat/completions', '/v1/chat/completions']);

    status = 200; gw.seen.length = 0;
    await engine(gw.cfg('some-unknown-model'), 'fim').complete(req('f = '), sig());
    assert.match(gw.seen[0].body.prompt, /^<\|fim_prefix\|>/, 'forced fim on an unknown model uses the Qwen format');
  } finally { await gw.close(); }
});

test('engine: without a completeText function the engine stays on chat (backwards compatible)', () => {
  const e = new CompletionEngine(async () => ({ content: '', toolCalls: [] }), () => undefined);
  assert.equal(e.fimFormat({ baseUrl: '', apiKey: '', model: 'qwen3-coder-next', temperature: 0, allowSelfSigned: true }), undefined);
});
