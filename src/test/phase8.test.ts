import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { McpClient, McpManager, McpServerConfig, mcpConfigHash, parseMcpConfig, toolName } from '../core/mcp';
import { Agent } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { call, fakeLlm, recordingUi, text, tmpDir } from './helpers';

const FIXTURE = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'fake-mcp.js');
const server = (env: Record<string, string> = {}): McpServerConfig => ({ command: process.execPath, args: [FIXTURE], env });

const live: Array<{ stop(): void }> = [];
const track = <T extends { stop(): void }>(x: T): T => { live.push(x); return x; };
after(() => live.forEach((x) => x.stop()));

test('config: accepts both {mcpServers:{}} and bare maps, validates fields', () => {
  const a = parseMcpConfig({ mcpServers: { one: { command: 'node', args: ['x.js'], env: { A: '1' } } } });
  assert.deepEqual(Object.keys(a.servers), ['one']);
  assert.deepEqual(parseMcpConfig({ two: { command: 'py' } }).servers.two.command, 'py');
  const bad = parseMcpConfig({ a: {}, b: { command: 'x', args: 'nope' }, c: { command: 'x', env: { K: 1 } }, ok: { command: 'x', disabled: true } });
  assert.deepEqual(Object.keys(bad.servers), ['ok']);
  assert.equal(bad.servers.ok.disabled, true);
  assert.equal(bad.errors.length, 3);
  assert.deepEqual(parseMcpConfig(undefined), { servers: {}, errors: [] });
  assert.equal(parseMcpConfig('str').errors.length, 1);
});

test('config: hash changes when command, args or env change', () => {
  const base = mcpConfigHash('s', { command: 'a', args: ['1'] });
  assert.equal(base, mcpConfigHash('s', { command: 'a', args: ['1'] }));
  assert.notEqual(base, mcpConfigHash('s', { command: 'a', args: ['2'] }));
  assert.notEqual(base, mcpConfigHash('s', { command: 'b', args: ['1'] }));
  assert.notEqual(base, mcpConfigHash('s', { command: 'a', args: ['1'], env: { X: '1' } }));
  assert.notEqual(base, mcpConfigHash('t', { command: 'a', args: ['1'] }));
});

test('toolName: sanitizes, truncates to 64 chars and de-duplicates', () => {
  const taken = new Set<string>();
  assert.equal(toolName('my server', 'do it!', taken), 'mcp__my_server__do_it_');
  assert.equal(toolName('my server', 'do it!', taken), 'mcp__my_server__do_it__2');
  const long = toolName('s', 'x'.repeat(200), new Set());
  assert.equal(long.length, 64);
  const t2 = new Set<string>(); const a = toolName('s', 'y'.repeat(200), t2); const b = toolName('s', 'y'.repeat(200), t2);
  assert.notEqual(a, b); assert.ok(b.length <= 64);
});

test('client: initialize, list and call tools; ignores server-initiated requests', async () => {
  const c = track(new McpClient('fake', server(), process.cwd()));
  await c.start();
  const tools = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['echo', 'lookup', 'fail', 'weird name!']);
  assert.deepEqual(await c.callTool('echo', { text: 'hi' }), { text: 'echo:hi', isError: false });
  const l = await c.callTool('lookup', { key: 'k' });
  assert.equal(l.text, 'value-of-k\n[image omitted]');
  assert.equal((await c.callTool('fail', {})).isError, true);
  await new Promise((r) => setTimeout(r, 120)); // let the roots/list request arrive and be answered
  assert.equal(c.closed, false);
  await assert.rejects(c.callTool('nope', {}), /unknown tool nope/);
});

test('client: pagination collects all pages', async () => {
  const c = track(new McpClient('fake', server({ FAKE_PAGED: '1' }), process.cwd()));
  await c.start();
  assert.equal((await c.listTools()).length, 4);
});

test('client: init timeout and missing command fail fast with clear errors', async () => {
  const slow = track(new McpClient('slow', server({ FAKE_NO_INIT: '1' }), process.cwd()));
  await assert.rejects(slow.start(300), /timed out|stopped/);
  const missing = track(new McpClient('nope', { command: 'definitely-not-a-real-binary-xyz.exe' }, process.cwd()));
  await assert.rejects(missing.start(2000), /ENOENT|exited|stopped|spawn/);
});

test('client: request timeout, cancellation and server crash reject pending calls', async () => {
  const slow = track(new McpClient('slow', server({ FAKE_SLOW: '1' }), process.cwd()));
  await slow.start();
  await assert.rejects(slow.callTool('echo', { text: 'x' }, undefined, 200), /timed out/);

  const ac = new AbortController();
  const p = slow.callTool('echo', { text: 'x' }, ac.signal, 5000);
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(p, /Cancelled/);

  const crash = track(new McpClient('crash', server({ FAKE_CRASH_ON_CALL: '1' }), process.cwd()));
  await crash.start();
  await assert.rejects(crash.callTool('echo', { text: 'x' }), /exited \(code 3\)/);
  assert.equal(crash.closed, true);
  await assert.rejects(crash.callTool('echo', { text: 'x' }), /not running/);
});

test('manager: exposes namespaced tools, marks read-only hints as read, others as exec', async () => {
  const m = track({ stop: () => mgr.stopAll() }); const mgr = new McpManager(process.cwd());
  const status = await mgr.reload({ fake: server() });
  assert.deepEqual(status, [{ name: 'fake', status: 'connected', tools: 4 }]);
  const byName = Object.fromEntries(mgr.tools().map((t) => [t.spec.function.name, t]));
  assert.ok(byName.mcp__fake__echo && byName.mcp__fake__lookup && byName.mcp__fake__weird_name_);
  assert.equal(byName.mcp__fake__lookup.kind, 'read');
  assert.equal(byName.mcp__fake__echo.kind, 'exec');
  assert.equal((byName.mcp__fake__weird_name_.spec.function.parameters as any).type, 'object', 'missing schema gets a default');
  assert.match(byName.mcp__fake__echo.spec.function.description, /^\[MCP fake\]/);
  assert.match(byName.mcp__fake__echo.describe({ text: 'a' }), /fake: echo/);
  const ctx = { root: '.', signal: new AbortController().signal, snapshot: async () => {} };
  assert.equal(await byName.mcp__fake__echo.run({ text: 'yo' }, ctx), 'echo:yo');
  await assert.rejects(byName.mcp__fake__fail.run({}, ctx), /it broke/);
  void m;
});

test('manager: one bad server never blocks the others; disabled servers are skipped', async () => {
  const mgr = new McpManager(process.cwd()); track({ stop: () => mgr.stopAll() });
  const status = await mgr.reload({
    good: server(), bad: { command: 'definitely-not-a-real-binary-xyz.exe' }, off: { ...server(), disabled: true },
  }, 20000);
  assert.deepEqual(status.map((s) => [s.name, s.status]), [['good', 'connected'], ['bad', 'error'], ['off', 'disabled']]);
  assert.ok(status[1].error);
  assert.equal(mgr.tools().length, 4);
});

test('manager: reload replaces servers and stops the old ones; crashes update status and drop tools', async () => {
  const mgr = new McpManager(process.cwd()); track({ stop: () => mgr.stopAll() });
  await mgr.reload({ a: server() });
  assert.ok(mgr.tools().every((t) => t.spec.function.name.startsWith('mcp__a__')));
  await mgr.reload({ b: server({ FAKE_CRASH_ON_CALL: '1' }) });
  assert.ok(mgr.tools().every((t) => t.spec.function.name.startsWith('mcp__b__')));
  const echo = mgr.tools().find((t) => t.spec.function.name === 'mcp__b__echo')!;
  await assert.rejects(echo.run({ text: 'x' }, { root: '.', signal: new AbortController().signal, snapshot: async () => {} }), /exited/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mgr.tools().length, 0);
  assert.equal(mgr.status()[0].status, 'error');
});

function agentWith(mgr: McpManager, root: string, llm: ReturnType<typeof fakeLlm>) {
  return new Agent({ root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => [...createFsTools(), ...mgr.tools()] });
}

test('agent + MCP: external tools need approval in ask mode; read-only ones do not; plan mode blocks exec tools', async () => {
  const mgr = new McpManager(process.cwd()); track({ stop: () => mgr.stopAll() });
  await mgr.reload({ fake: server() });
  const root = await tmpDir();

  const ask = recordingUi(true);
  const a1 = agentWith(mgr, root, fakeLlm([call('mcp__fake__echo', { text: 'hello' }, 'e1'), call('mcp__fake__lookup', { key: 'k' }, 'l1'), text('done')]));
  await a1.send('go', { mode: 'ask', effort: 'medium', model: 'm' }, ask);
  assert.deepEqual(ask.approvals.map((x) => x.name), ['mcp__fake__echo']);
  assert.equal(a1.history.find((m) => m.tool_call_id === 'e1')!.content, 'echo:hello');
  assert.match(a1.history.find((m) => m.tool_call_id === 'l1')!.content!, /value-of-k/);

  const denied = recordingUi(false);
  const a2 = agentWith(mgr, root, fakeLlm([call('mcp__fake__echo', { text: 'x' }, 'e2'), text('ok')]));
  await a2.send('go', { mode: 'ask', effort: 'medium', model: 'm' }, denied);
  assert.match(a2.history.find((m) => m.tool_call_id === 'e2')!.content!, /DENIED/);

  const plan = recordingUi(true);
  const seenTools: string[] = [];
  const llm = fakeLlm([call('mcp__fake__echo', { text: 'x' }, 'e3'), text('ok')]);
  const a3 = new Agent({ root, llm: (async (c: any, m: any, tools: any[], t: any, s: any) => { seenTools.push(...tools.map((x) => x.function.name)); return llm.fn(c, m, tools, t, s); }) as any,
    getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => [...createFsTools(), ...mgr.tools()] });
  await a3.send('go', { mode: 'plan', effort: 'medium', model: 'm' }, plan);
  assert.ok(seenTools.includes('mcp__fake__lookup'), 'read-only MCP tool available in plan mode');
  assert.ok(!seenTools.includes('mcp__fake__echo'), 'mutating MCP tool hidden in plan mode');
  assert.match(a3.history.find((m) => m.tool_call_id === 'e3')!.content!, /not allowed in plan mode/);
});
