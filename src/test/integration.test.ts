import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import Module = require('module');
import { Agent, AgentGuard } from '../core/agent';
import { buildSessionHtml } from '../core/html';
import { SessionRuntime } from '../core/runtime';
import { Tool, fnSpec } from '../core/tool';
import { call, fakeLlm, recordingUi, text } from './helpers';

const ROOT = path.join(__dirname, '..', '..');
const OPTS = { mode: 'ask', effort: 'medium', model: 'm' } as const;

function setup(guard: AgentGuard, steps = [call('act', { path: 'a.txt' }), text('done')]) {
  const runs: any[] = [];
  const tool: Tool = { kind: 'edit', spec: fnSpec('act', 'test tool', { path: { type: 'string' } }, []), describe: () => 'Act', run: async (a) => { runs.push(a); return 'ran'; } };
  const llm = fakeLlm(steps);
  const agent = new Agent({ root: ROOT, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: false }), tools: () => [tool], guard });
  return { agent, runs, llm, ui: recordingUi(true) };
}
const toolReply = (agent: Agent) => agent.history.find((m) => m.role === 'tool')?.content ?? '';

test('guard: a deny rule stops the tool without asking, even in auto mode', async () => {
  const { agent, runs, ui } = setup({ decide: () => ({ effect: 'deny', reason: 'edit(.env*)' }) });
  await agent.send('go', { ...OPTS, mode: 'auto' }, ui);
  assert.equal(runs.length, 0);
  assert.equal(ui.approvals.length, 0);
  assert.match(toolReply(agent), /DENIED by permission rule: edit\(\.env\*\)/);
});

test('guard: an ask rule asks even in auto mode', async () => {
  const { agent, runs, ui } = setup({ decide: () => ({ effect: 'ask' }) });
  await agent.send('go', { ...OPTS, mode: 'auto' }, ui);
  assert.equal(ui.approvals.length, 1);
  assert.equal(runs.length, 1);
});

test('guard: an allow rule skips the approval in ask mode', async () => {
  const { agent, runs, ui } = setup({ decide: () => ({ effect: 'allow' }) });
  await agent.send('go', OPTS, ui);
  assert.equal(ui.approvals.length, 0);
  assert.equal(runs.length, 1);
});

test('guard: plan mode still blocks editing tools when an allow rule matches', async () => {
  const { agent, runs, ui } = setup({ decide: () => ({ effect: 'allow' }) });
  await agent.send('go', { ...OPTS, mode: 'plan' }, ui);
  assert.equal(runs.length, 0);
});

test('guard: a PreToolUse hook blocks the tool before any approval is shown', async () => {
  const { agent, runs, ui } = setup({ beforeTool: async () => ({ blocked: true, reason: 'lint failed' }) });
  await agent.send('go', OPTS, ui);
  assert.equal(runs.length, 0);
  assert.equal(ui.approvals.length, 0);
  assert.match(toolReply(agent), /BLOCKED by hook: lint failed/);
});

test('guard: masked secrets are restored for the tool, and unknown ones are refused', async () => {
  const ok = setup({ restoreArgs: () => ({ path: 'real.txt' }), decide: () => ({ effect: 'allow' }) });
  await ok.agent.send('go', OPTS, ok.ui);
  assert.deepEqual(ok.runs, [{ path: 'real.txt' }]);
  const bad = setup({ restoreArgs: () => { throw new Error('masked secret'); } });
  await bad.agent.send('go', OPTS, bad.ui);
  assert.equal(bad.runs.length, 0);
  assert.match(toolReply(bad.agent), /ERROR: masked secret/);
});

test('guard: a blocked prompt never reaches the LLM and the conversation stays valid', async () => {
  const { agent, llm, ui } = setup({ onPrompt: async () => ({ blocked: true, reason: 'contains a ticket number' }) });
  await agent.send('go', OPTS, ui);
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(agent.history.map((m) => m.role), ['user', 'assistant']);
});

test('guard: a Stop hook can send the agent back to work, but only a limited number of times', async () => {
  const { agent, llm, ui } = setup({ onStop: async () => ({ blocked: true, reason: 'tests are failing' }) }, [text('done')]);
  await agent.send('go', OPTS, ui);
  assert.equal(llm.calls.length, 4);
});

test('runtime: agents prepared at the same time never receive the same id', () => {
  const s = new SessionRuntime('s1', '');
  const a = s.reserveAgentId(), b = s.reserveAgentId();
  assert.notEqual(a, b);
  s.releaseAgentId(a);
  assert.equal(s.nextAgentId(), a);
});

test('activation loads only the small shell: no hub, agents, LLM client or search', () => {
  const file = path.join(ROOT, 'out', 'host', 'extension.js');
  const disposable = { dispose() { /* nothing */ } };
  const vscode: any = new Proxy({
    window: { createStatusBarItem: () => ({ show() { /* */ }, dispose() { /* */ } }), registerWebviewViewProvider: () => disposable, registerWebviewPanelSerializer: () => disposable },
    workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }), onDidChangeConfiguration: () => disposable, registerTextDocumentContentProvider: () => disposable },
    languages: { registerInlineCompletionItemProvider: () => disposable, registerCodeActionsProvider: () => disposable },
    commands: { registerCommand: () => disposable, executeCommand: async () => undefined },
    Disposable: class { static from() { return disposable; } dispose() { /* nothing */ } },
    StatusBarAlignment: { Right: 2 }, ExtensionMode: { Test: 3 }, CodeActionKind: { QuickFix: 'q', RefactorRewrite: 'r' },
  }, { get: (t: any, k) => t[k] });
  const m = Module as any;
  const original = m._load;
  const loaded: string[] = [];
  m._load = function (request: string, parent: any, isMain: boolean) {
    if (request === 'vscode') { return vscode; }
    const out = original.call(this, request, parent, isMain);
    if (request.startsWith('.')) { loaded.push(path.relative(path.join(ROOT, 'out'), path.resolve(path.dirname(parent.filename), request)).split(path.sep).join('/')); }
    return out;
  };
  try {
    delete require.cache[file];
    const started = process.hrtime.bigint();
    require(file).activate({ subscriptions: [], extensionMode: 1, secrets: {} });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    for (const heavy of ['host/hub', 'host/sessionPanel', 'core/agent', 'core/runtime', 'core/llm', 'core/search', 'host/completions', 'host/features/workbench', 'host/features/guard']) {
      assert.ok(!loaded.includes(heavy), `${heavy} must not load during activation (loaded: ${loaded.join(', ')})`);
    }
    // The module list above is the real guarantee; this bound catches gross regressions without failing on a busy machine.
    assert.ok(ms < 250, `activation took ${ms.toFixed(1)} ms`);
  } finally { m._load = original; }
});

test('the 3.5 MB diagram library is not loaded until a diagram appears', () => {
  const html = buildSessionHtml({ nonce: 'N', cspSource: 'c', cssUri: 'a.css', jsUri: 'a.js', mdUri: 'm.js', mermaidUri: 'mermaid.js', logoSvg: '<svg viewBox="0 0 1 1"></svg>' });
  assert.doesNotMatch(html, /<script[^>]*mermaid\.js/);
  assert.match(html, /data-mermaid="mermaid\.js"/);
});

test('manifest: every new setting read by the code is declared', () => {
  // Settings are split into categories (an array); a plain object is accepted too.
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).contributes.configuration;
  const props = Object.assign({}, ...[config].flat().map((c: any) => c.properties));
  for (const k of ['redactSecrets', 'auditLog', 'agentWorktrees', 'visibleTerminal', 'modelRouting', 'teamSkills', 'policyUrl', 'notifications.enabled']) { assert.ok(props[`infraonAssistant.${k}`], k); }
});
