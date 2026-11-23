/**
 * Live checks against the real company LLM gateway, through the same code the extension uses (llm.ts, sampling.ts,
 * the Agent loop). They answer "is the gateway answering, and does our exact request shape work?" when sessions hang.
 *
 * Design:
 * - Never part of `npm run test:unit` (that glob does not descend into test/live/), so unit tests stay offline as the
 *   project rules require. Run with `npm run test:live`; every test is skipped unless INFRAON_LIVE_API_KEY is set.
 * - Settings come from the environment only, never from VS Code or files: INFRAON_LIVE_API_KEY (required),
 *   INFRAON_LIVE_BASE_URL (default: the extension's default gateway), INFRAON_LIVE_MODEL (default qwen3-coder-next),
 *   INFRAON_LIVE_SELF_SIGNED=0 to verify TLS (default: accept the gateway's internal certificate). The key is never printed.
 * - Each request uses a short stall timeout and no retries, so a gateway that accepts but never answers fails in
 *   seconds with a clear message instead of the agent's minutes of retrying. Each test logs its timings.
 * - The tests narrow a hang down step by step: plain request, then our per-model sampling fields, then a streamed tool
 *   call (which also exercises the live file-writing progress), then a whole agent turn with real tools.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Agent } from '../../core/agent';
import { createFsTools } from '../../core/fstools';
import { LlmConfig, LlmFn, ToolCallProgress, ToolSpec, listModels, streamChat, streamChatOnce } from '../../core/llm';
import { resolveSampling } from '../../core/sampling';
import { recordingUi, tmpDir } from '../helpers';

const KEY = process.env.INFRAON_LIVE_API_KEY ?? '';
const BASE = process.env.INFRAON_LIVE_BASE_URL ?? 'https://172.16.48.75:30400/v1';
const MODEL = process.env.INFRAON_LIVE_MODEL ?? 'qwen3-coder-next';
const STALL_MS = Number(process.env.INFRAON_LIVE_STALL_MS ?? 60_000);
const skip = KEY ? false : 'set INFRAON_LIVE_API_KEY to run the live gateway tests';
const T = { skip, timeout: 240_000 };

/** The config the extension sends for this model: per-model sampling from sampling.ts, unless `plain`. */
function config(plain = false, maxTokens = 512): LlmConfig {
  const base = { baseUrl: BASE, apiKey: KEY, model: MODEL, allowSelfSigned: process.env.INFRAON_LIVE_SELF_SIGNED !== '0', idleTimeoutMs: STALL_MS, maxTokens };
  if (plain) { return { ...base, temperature: 0.2 }; }
  const s = resolveSampling(MODEL);
  return { ...base, temperature: s.temperature, sampling: s.sampling };
}

const signal = () => AbortSignal.timeout(200_000);
const log = (label: string, started: number, extra = '') => console.log(`  [live] ${label}: ${Date.now() - started} ms ${extra}`);

/** Wraps an LlmFn to time the first streamed byte of text or tool call and the whole request. */
function timed(fn: LlmFn, label: string): LlmFn {
  return async (cfg, messages, tools, onToken, sig, onToolProgress) => {
    const started = Date.now();
    let first = 0;
    const mark = () => { if (!first) { first = Date.now() - started; } };
    const r = await fn(cfg, messages, tools, (t) => { mark(); onToken(t); }, sig, (p) => { mark(); onToolProgress?.(p); });
    log(label, started, `(first output ${first || '-'} ms, ${r.usage?.prompt ?? '?'} prompt + ${r.usage?.completion ?? '?'} completion tokens, finish ${r.finishReason ?? '?'})`);
    return r;
  };
}

test('live: the gateway lists the model', T, async () => {
  const started = Date.now();
  const models = await listModels(config(true));
  log('GET /models', started, `(${models.length} models)`);
  assert.ok(models.includes(MODEL), `${MODEL} is not served; the gateway has: ${models.join(', ')}`);
});

test('live: a plain request (no extra sampling fields) answers', T, async () => {
  const r = await timed(streamChatOnce, 'plain request')(config(true), [{ role: 'user', content: 'Reply with exactly: pong' }], [], () => {}, signal());
  assert.match(r.content, /pong/i);
});

test('live: the request with our per-model sampling fields answers (what 0.28.0 sends)', T, async () => {
  const cfg = config();
  console.log(`  [live] sampling for ${MODEL}: temperature ${cfg.temperature}, ${JSON.stringify(cfg.sampling)}`);
  const r = await timed(streamChatOnce, 'sampled request')(cfg, [{ role: 'user', content: 'Reply with exactly: pong' }], [], () => {}, signal());
  assert.match(r.content, /pong/i);
});

test('live: a streamed write_file tool call reports progress with the path and growing size', T, async () => {
  const tools: ToolSpec[] = [{ type: 'function', function: {
    name: 'write_file', description: 'Create or overwrite a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  } }];
  const seen: ToolCallProgress[] = [];
  const r = await timed(streamChatOnce, 'tool call')(config(false, 4096), [
    { role: 'user', content: 'Use write_file to create index.html: a small HTML page with a heading "Hello" and three paragraphs of placeholder text. Call the tool now, no explanation.' },
  ], tools, () => {}, signal(), (p) => seen.push(p));
  const call = r.toolCalls.find((c) => c.function.name === 'write_file');
  assert.ok(call, `no write_file call; reply was: ${r.content.slice(0, 300)}`);
  const args = JSON.parse(call.function.arguments);
  assert.match(String(args.path), /index\.html$/);
  console.log(`  [live] ${seen.length} progress reports, last: ${JSON.stringify(seen[seen.length - 1])}`);
  assert.ok(seen.length >= 1, 'no progress was reported while the tool call streamed');
  assert.ok(seen.some((p) => p.path && /index\.html$/.test(p.path)), 'the path never appeared in the progress');
});

test('live: a whole agent turn with real tools creates the file (same loop and wrappers as the extension)', T, async () => {
  const root = await tmpDir('ica-live-');
  try {
    const llm = timed(streamChat, 'agent request');
    const ui = recordingUi(true);
    const writing: string[] = [];
    const agent = new Agent({ root, llm, getConfig: () => config(), tools: () => createFsTools() });
    const started = Date.now();
    await agent.send('Create a file hello.txt containing exactly the word hi. Then stop.', { mode: 'auto', effort: 'max', model: MODEL }, { ...ui, toolWriting: (p) => writing.push(`${p.name}:${p.chars}`) });
    log('agent turn', started, `(${ui.events.filter((e) => e.startsWith('start:')).length} tool calls, ${writing.length} progress reports)`);
    const errors = ui.events.filter((e) => /^info:.*(error|failed|stalled)/i.test(e));
    assert.deepEqual(errors, [], 'the agent reported errors');
    assert.equal((await fs.readFile(path.join(root, 'hello.txt'), 'utf8')).trim(), 'hi');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
