import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { Agent, CheckCommand } from '../core/agent';
import { ChangeJournal, isArtifactPath } from '../core/changeJournal';
import { createIgnore } from '../core/glob';
import { Tool, fnSpec } from '../core/tool';
import { call, fakeLlm, recordingUi, text } from './helpers';

const ROOT = path.resolve('/w');
const AUTO = { mode: 'auto', effort: 'medium', model: 'm' } as const;
const CHECKS: CheckCommand[] = [{ name: 'test', command: 'test-cmd', timeoutSeconds: 600 }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ artifact filter */

test('isArtifactPath: build output, caches and logs are not code changes', () => {
  for (const p of ['node_modules/x/index.js', 'coverage/lcov.info', 'src/__pycache__/a.pyc', 'build/app.js', 'out/a.js', 'debug.log', 'pkg.egg-info/PKG-INFO', '.pytest_cache/v/x']) {
    assert.ok(isArtifactPath(p), p);
  }
  for (const p of ['src/a.ts', 'package.json', 'package-lock.json', 'README.md', 'src\\win\\path.cs']) {
    assert.ok(!isArtifactPath(p), p);
  }
});

test('isArtifactPath: the root .gitignore is respected', () => {
  const ig = createIgnore(['generated/', '*.snap', '!keep.snap']);
  assert.ok(isArtifactPath('generated/api.ts', ig));
  assert.ok(isArtifactPath('src/x.snap', ig));
  assert.ok(!isArtifactPath('src/keep.snap', ig));
  assert.ok(!isArtifactPath('src/api.ts', ig));
});

/* ------------------------------------------------------------------ journal */

test('journal: changes since a cursor, deduplicated', async () => {
  const j = new ChangeJournal();
  j.record('/w/a.ts');
  const c = j.cursor();
  j.record('/w/b.ts'); j.record('/w/b.ts'); j.record('/w/c.ts');
  const r = await j.changedSince(c);
  assert.deepEqual(r.paths, [path.resolve('/w/b.ts'), path.resolve('/w/c.ts')]);
  assert.equal(r.cursor, j.cursor());
  assert.deepEqual((await j.changedSince(r.cursor)).paths, []);
});

test('journal: settle waits for late watcher events', async () => {
  const j = new ChangeJournal({ quietMs: 80, maxWaitMs: 1000 });
  const c = j.cursor();
  setTimeout(() => j.record('/w/late.ts'), 40);
  const r = await j.changedSince(c, true);
  assert.deepEqual(r.paths, [path.resolve('/w/late.ts')]);
});

test('journal: settle gives up at maxWaitMs under constant changes', async () => {
  const j = new ChangeJournal({ quietMs: 100, maxWaitMs: 250 });
  const t = setInterval(() => j.record('/w/busy.ts'), 20);
  const start = Date.now();
  await j.changedSince(0, true);
  clearInterval(t);
  assert.ok(Date.now() - start < 600);
});

/* ------------------------------------------------------------------ agent integration */

/** Agent with a fake run_command; `effects` maps a command to files it "changes" (recorded in the journal). */
function setup(steps: any[], effects: Record<string, string[]> = {}, opts: { checks?: CheckCommand[] } = {}) {
  const journal = new ChangeJournal({ quietMs: 20, maxWaitMs: 200 });
  const ran: string[] = [];
  const run: Tool = {
    kind: 'exec', spec: fnSpec('run_command', '', {}, []), describe: (a) => `Run: ${a.command}`,
    run: async (a) => { ran.push(a.command); for (const f of effects[a.command] ?? []) { journal.record(path.join(ROOT, f)); } return `ok\n[exit 0]`; },
  };
  const read: Tool = { kind: 'read', spec: fnSpec('read_file', '', {}, []), describe: () => 'Read', run: async () => 'x' };
  const llm = fakeLlm(steps);
  const agent = new Agent({
    root: ROOT, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: false }),
    tools: () => [run, read], checks: () => opts.checks ?? CHECKS, fileChanges: journal,
  });
  return { agent, ran, journal, ui: recordingUi(true) };
}

test('a shell command that changes files triggers the checks and the summary', async () => {
  const { agent, ran, ui } = setup([call('run_command', { command: 'npx prettier --write src' }), text('formatted')], { 'npx prettier --write src': ['src/a.ts', 'src/b.ts'] });
  await agent.send('format', AUTO, ui);
  assert.deepEqual(ran, ['npx prettier --write src', 'test-cmd']);
  assert.ok(ui.events.some((e) => /^info:Changed 2 files\. Checked after the last change: ✓ test-cmd$/.test(e)), ui.events.join('\n'));
  assert.deepEqual(agent.lastChanged.map((p) => path.basename(p)).sort(), ['a.ts', 'b.ts']);
});

test('a command that changes nothing does not trigger the checks', async () => {
  const { agent, ran, ui } = setup([call('run_command', { command: 'npm run build-docs' }), text('done')]);
  await agent.send('x', AUTO, ui);
  assert.deepEqual(ran, ['npm run build-docs']);
  assert.ok(!ui.events.some((e) => /Changed/.test(e)));
});

test('changes made before a tool runs (the user typing) are not counted as the agent\'s', async () => {
  const { agent, ran, journal, ui } = setup([
    () => { journal.record(path.join(ROOT, 'user-edit.ts')); return call('read_file', {}); },
    text('answer'),
  ]);
  await agent.send('explain', AUTO, ui);
  assert.deepEqual(ran, []);
  assert.ok(!ui.events.some((e) => /Changed/.test(e)));
});

test('when the model already ran every check after its last change, they do not run twice', async () => {
  const { agent, ran, ui } = setup([
    call('run_command', { command: 'codegen' }, 'c1'), call('run_command', { command: 'test-cmd' }, 'c2'), text('all good'),
  ], { codegen: ['src/gen.ts'] });
  await agent.send('x', AUTO, ui);
  assert.deepEqual(ran, ['codegen', 'test-cmd']);
  assert.ok(ui.events.some((e) => /Changed 1 file\. Checked after the last change: ✓ test-cmd/.test(e)));
});

test('a foreground sub-agent\'s changes are checked before the parent finishes', async () => {
  const llm = fakeLlm([call('agent', { description: 'd', prompt: 'p' }), text('delegated')]);
  const ran: string[] = [];
  const run: Tool = { kind: 'exec', spec: fnSpec('run_command', '', {}, []), describe: () => 'Run', run: async (a) => { ran.push(a.command); return 'ok\n[exit 0]'; } };
  const agent = new Agent({
    root: ROOT, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: false }),
    tools: () => [run], checks: () => CHECKS,
    spawn: async () => ({ ok: true, text: 'sub done', agentId: 'a2', changed: [path.join(ROOT, 'src/sub.ts')] }),
  });
  const ui = recordingUi(true);
  await agent.send('delegate', AUTO, ui);
  assert.deepEqual(ran, ['test-cmd']);
  assert.ok(ui.events.some((e) => /Changed 1 file\. Checked after the last change: ✓ test-cmd/.test(e)));
});

test('a background sub-agent\'s changes are checked in the parent\'s next turn', async () => {
  const { agent, ran, ui } = setup([text('The agent finished.')]);
  agent.markExternalChanges([path.join(ROOT, 'src/bg.ts')]);
  await agent.send('<agent-notification>…</agent-notification>', AUTO, ui);
  assert.deepEqual(ran, ['test-cmd']);
  assert.ok(ui.events.some((e) => /Changed 1 file/.test(e)));
  // Consumed: the turn after that has nothing to check.
  const again = recordingUi(true);
  await agent.send('thanks', AUTO, again);
  assert.deepEqual(ran, ['test-cmd']);
});

test('read-only commands do not wait for file events', async () => {
  const { agent, ui } = setup([call('run_command', { command: 'git status' }), text('clean')]);
  const start = Date.now();
  await agent.send('x', AUTO, ui);
  assert.ok(Date.now() - start < 150, `took ${Date.now() - start} ms`);
  await sleep(1);
});
