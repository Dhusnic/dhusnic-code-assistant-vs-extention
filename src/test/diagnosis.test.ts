import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Agent } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { fnSpec, Tool } from '../core/tool';
import { StreamResult } from '../core/llm';
import {
  DIAGNOSIS_TOOL, DiagnoseFirstSetting, DiagnosisState, MAX_CARRY_TURNS, MAX_HOLDS, evaluateDiagnosis, isReproductionPath, looksLikeBugReport, parseDiagnoseFirstSetting,
} from '../core/diagnosis';
import { call, fakeLlm, recordingUi, text, tmpDir } from './helpers';

/* ------------------------------------------------------------------ activation */

test('looksLikeBugReport: fix verbs with a problem, symptoms on their own, /fix', () => {
  for (const s of [
    'fix the login bug', 'Fix this bug test-first: totals are off', 'investigate why the build fails', 'debug the crash on save',
    'the export button is not working', "saving doesn't work anymore", 'it stopped working after the update',
    "TypeError: Cannot read properties of undefined (reading 'id')\n    at render (app.js:10)", 'here is the stack trace',
    'expected 3 but got 4 from sum()', 'the API returns wrong totals', '/fix totals', 'resolve the memory leak in the cache',
    'fix the bug in the date formatting', 'fix the error when saving a draft',
  ]) { assert.equal(looksLikeBugReport(s), true, s); }
  for (const s of [
    'fix the typo in the README', 'add error handling to the parser', 'explain this function', 'write tests for the error handler',
    'rename foo to bar', 'add a dark mode toggle', '', 'fix the eslint errors in src/', 'fix the prettier formatting issues',
    'make sure the migration does not run twice', 'the job should not start without a config', '<agent-notification>\n<status>failed</status>\n</agent-notification> The background agent finished.',
  ]) { assert.equal(looksLikeBugReport(s), false, s); }
});

test('isReproductionPath: test files and repro scripts only', () => {
  for (const p of ['src/test/a.test.ts', 'tests/test_totals.py', 'pkg/sum_test.go', 'src/__tests__/x.js', 'app/FooTest.java', 'repro_bug.js', 'scripts/repro.sh', 'spec/models/user_spec.rb']) {
    assert.equal(isReproductionPath(p), true, p);
  }
  for (const p of ['src/core/agent.ts', 'src/latest.ts', 'contest.py', 'README.md', undefined, '']) { assert.equal(isReproductionPath(p), false, String(p)); }
});

test('parseDiagnoseFirstSetting: auto by default, off only when set', () => {
  assert.equal(parseDiagnoseFirstSetting('off'), 'off');
  assert.equal(parseDiagnoseFirstSetting('auto'), 'auto');
  assert.equal(parseDiagnoseFirstSetting('bogus'), 'auto');
  assert.equal(parseDiagnoseFirstSetting(undefined), 'auto');
});

/* ------------------------------------------------------------------ evaluateDiagnosis */

const ROOT_CAUSE = 'sum() starts its accumulator at 1 instead of 0, so every total is one too high';
const diag = (over: Record<string, unknown> = {}) => ({
  root_cause: ROOT_CAUSE, fix_plan: 'Start the accumulator at 0 in a.js',
  evidence: [{ path: 'a.js', line: 2, finding: 'the accumulator starts at 1' }],
  reproduction: { method: 'failing_test', command: 'node repro.js', observed: 'expected 6, got 7' },
  confidence: 'high', ...over,
});

async function env(over: Partial<Parameters<typeof evaluateDiagnosis>[1]> = {}) {
  const root = await tmpDir('diag-eval-');
  await fs.writeFile(path.join(root, 'a.js'), 'one\ntwo\nthree\n');
  return { root, wasRead: () => true, runs: [{ command: 'node  repro.js', exit: 1 }], userConsulted: false, ...over };
}

test('evaluateDiagnosis: a checked, high-confidence diagnosis with a failing test is accepted; the test becomes a check', async () => {
  const v = await evaluateDiagnosis(diag(), await env());
  assert.equal(v.status, 'accepted');
  assert.deepEqual(v.status === 'accepted' && v.repro, { command: 'node repro.js', failedBefore: true });
});

test('evaluateDiagnosis: rejects what it can disprove, listing every problem', async () => {
  const bad = await evaluateDiagnosis(diag({ root_cause: 'bug', evidence: [], reproduction: { method: 'guess' }, confidence: 'sure' }), await env());
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.status === 'rejected' && bad.problems.length, 4);

  const unread = await evaluateDiagnosis(diag(), await env({ wasRead: () => false }));
  assert.match(unread.status === 'rejected' ? unread.problems[0] : '', /have not read this file/);

  const range = await evaluateDiagnosis(diag({ evidence: [{ path: 'a.js', line: 40, finding: 'x' }] }), await env());
  assert.match(range.status === 'rejected' ? range.problems[0] : '', /only 3 lines/);

  const missing = await evaluateDiagnosis(diag({ evidence: [{ path: 'nope.ts', line: 1, finding: 'x' }] }), await env());
  assert.match(missing.status === 'rejected' ? missing.problems[0] : '', /no such file/);

  const notRun = await evaluateDiagnosis(diag(), await env({ runs: [] }));
  assert.match(notRun.status === 'rejected' ? notRun.problems[0] : '', /was not run since the bug was reported/);

  const passing = await evaluateDiagnosis(diag(), await env({ runs: [{ command: 'node repro.js', exit: 1 }, { command: 'node repro.js', exit: 0 }] }));
  assert.match(passing.status === 'rejected' ? passing.problems[0] : '', /passed \(exit 0\)/, 'the latest run counts');

  const noObserved = await evaluateDiagnosis(diag({ reproduction: { method: 'script', command: 'node repro.js' } }), await env({ runs: [{ command: 'node repro.js', exit: 0 }] }));
  assert.match(noObserved.status === 'rejected' ? noObserved.problems[0] : '', /observed is required/);

  const noReason = await evaluateDiagnosis(diag({ reproduction: { method: 'not_possible' } }), await env());
  assert.match(noReason.status === 'rejected' ? noReason.problems[0] : '', /reason must explain/);
});

test('evaluateDiagnosis: low confidence never unlocks; medium only after the user answered', async () => {
  assert.equal((await evaluateDiagnosis(diag({ confidence: 'low' }), await env({ userConsulted: true }))).status, 'locked');
  assert.equal((await evaluateDiagnosis(diag({ confidence: 'medium' }), await env())).status, 'locked');
  assert.equal((await evaluateDiagnosis(diag({ confidence: 'medium' }), await env({ userConsulted: true }))).status, 'accepted');
});

test('evaluateDiagnosis: a script that shows the bug in its output (exit 0) is accepted but is not an exit-code check', async () => {
  const v = await evaluateDiagnosis(diag({ reproduction: { method: 'script', command: 'node repro.js', observed: 'prints 7, expected 6' } }), await env({ runs: [{ command: 'node repro.js', exit: 0 }] }));
  assert.equal(v.status, 'accepted');
  assert.equal(v.status === 'accepted' && v.repro?.failedBefore, false);
});

test('DiagnosisState: blocks source edits and writing sub-agents until accepted; a later rejection keeps the accepted one', async () => {
  const s = new DiagnosisState();
  assert.equal(s.blocks({ kind: 'edit', args: { path: 'src/a.ts' } }), true);
  assert.equal(s.blocks({ kind: 'edit', args: { path: 'src/a.test.ts' } }), false);
  assert.equal(s.blocks({ kind: 'edit', args: {} }), true, 'an edit without a path is held');
  assert.equal(s.blocks({ kind: 'read', args: { path: 'src/a.ts' } }), false);
  assert.equal(s.blocks({ kind: 'exec', args: { command: 'npm test' } }), false);
  assert.equal(s.blocks({ args: {}, isAgentLaunch: true, readOnlyAgent: true }), false);
  assert.equal(s.blocks({ args: {}, isAgentLaunch: true, readOnlyAgent: false }), true);
  // Every written path counts: moving a test into the source tree is a source change.
  assert.equal(s.blocks({ name: 'move_path', kind: 'edit', args: { path: 'tests/a.js', destination: 'src/a.js' } }), true);
  assert.equal(s.blocks({ name: 'copy_path', kind: 'edit', args: { path: 'tests/a.js', destination: 'tests/b.js' } }), false);
  // Gathering evidence is not a change to the code.
  assert.equal(s.blocks({ name: 'browser_screenshot', kind: 'edit', args: {} }), false);
  assert.equal(s.blocks({ name: 'remote_download', kind: 'edit', args: { local_path: 'logs/app.log' } }), false);
  assert.equal(s.carryOver('continue'), true);
  assert.equal(s.userConsulted, false, 'a bare "continue" is not an answer');
  s.apply(await evaluateDiagnosis(diag(), await env()));
  assert.equal(s.unlocked, true);
  assert.equal(s.blocks({ kind: 'edit', args: { path: 'src/a.ts' } }), false);
  s.apply({ status: 'rejected', problems: ['x'] });
  assert.equal(s.unlocked, true);
  assert.equal(s.carryOver('yes, the second endpoint'), true, 'not yet shown fixed');
  assert.equal(s.userConsulted, true, 'the user answered in a message of their own');
  s.verified = true;
  assert.equal(s.carryOver('thanks'), false);
});

test('DiagnosisState: an unproven lock expires after a few follow-up turns', () => {
  const s = new DiagnosisState();
  for (let i = 0; i < MAX_CARRY_TURNS; i++) { assert.equal(s.carryOver('more detail'), true); }
  assert.equal(s.carryOver('now add a dark mode toggle'), false);
});

/* ------------------------------------------------------------------ the loop */

/** run_command stand-in: the reproduction fails (exit 1) until a.js says TWO; any other command exits 0. */
function fakeRun(root: string, log: string[]): Tool {
  return {
    kind: 'exec', spec: fnSpec('run_command', '', { command: { type: 'string' } }, ['command']), describe: (a) => `Run: ${a.command}`,
    run: async (a) => {
      log.push(a.command);
      if (a.command !== 'node repro.js') { return 'ok\n[exit 0]'; }
      const fixed = (await fs.readFile(path.join(root, 'a.js'), 'utf8')).includes('TWO');
      return `${fixed ? 'pass' : 'AssertionError: expected TWO'}\n[exit ${fixed ? 0 : 1}]`;
    },
  };
}

async function build(main: StreamResult[], setting: DiagnoseFirstSetting | 'none' = 'auto', extra: { answer?: boolean } = {}) {
  const root = await tmpDir('diagnosis-');
  await fs.writeFile(path.join(root, 'a.js'), 'one\ntwo\nthree\n');
  const commands: string[] = [];
  let m = 0;
  const llm = fakeLlm([() => main[Math.min(m++, main.length - 1)]]);
  const agent = new Agent({
    root, llm: llm.fn, tools: () => [...createFsTools().filter((t) => t.spec.function.name !== 'run_command'), fakeRun(root, commands)],
    getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }),
    diagnoseFirst: setting === 'none' ? undefined : () => setting,
  });
  const ui = recordingUi();
  if (extra.answer) { ui.askUser = async () => [{ selected: ['Yes'] }]; }
  return { agent, root, llm, ui, commands, read: () => fs.readFile(path.join(root, 'a.js'), 'utf8'), mainCalls: () => m };
}

const readA = call('read_file', { path: 'a.js' }, 'R1');
const edit = (id: string) => call('edit_file', { path: 'a.js', old_string: 'two', new_string: 'TWO' }, id);
const runRepro = (id = 'X1') => call('run_command', { command: 'node repro.js' }, id);
const record = (id = 'D1', over: Record<string, unknown> = {}) => call(DIAGNOSIS_TOOL, { ...diag(), ...over }, id);
const toolResult = (agent: Agent, id: string) => String(agent.history.find((x) => x.role === 'tool' && x.tool_call_id === id)?.content ?? '');
const held = (agent: Agent, id: string) => /^NOT RUN \(diagnose first\)/.test(toolResult(agent, id));
const offered = (llm: { calls: any[][] }, i: number) => JSON.stringify(llm.calls[i]).includes(DIAGNOSIS_TOOL);

test('bug fix: the edit is held until the diagnosis is proven; then it runs and the reproduction must pass', async () => {
  const { agent, ui, commands, read, llm } = await build([edit('E1'), readA, runRepro(), record(), edit('E2'), text('Fixed: the accumulator.')]);
  await agent.send('fix the bug: a.js shows two in lower case', { mode: 'auto', effort: 'medium', model: 'm' }, ui);
  assert.ok(held(agent, 'E1'), toolResult(agent, 'E1'));
  assert.match(toolResult(agent, 'E1'), /Call record_diagnosis/);
  assert.match(toolResult(agent, 'D1'), /^DIAGNOSIS ACCEPTED/);
  assert.ok(!held(agent, 'E2'));
  assert.equal(await read(), 'one\nTWO\nthree\n');
  assert.deepEqual(commands, ['node repro.js', 'node repro.js'], 'the reproduction ran again as a check after the fix');
  assert.ok(ui.events.some((e) => /^info:Project checks passed: reproduction/.test(e)), ui.events.join('\n'));
  assert.ok(String(agent.history[0].content).includes('<system-reminder>This is a bug fix.'));
  assert.ok(offered(llm, 0), 'record_diagnosis is offered during a bug fix');
});

test('a diagnosis the loop can disprove is rejected and the lock stays', async () => {
  // Evidence from a file it never read, and a reproduction it never ran.
  const { agent, read } = await build([record('D1'), edit('E1'), text('Gave up.')]);
  await agent.send('fix the bug in a.js', { mode: 'auto', effort: 'medium', model: 'm' }, recordingUi());
  assert.match(toolResult(agent, 'D1'), /^ERROR: diagnosis not accepted/);
  assert.match(toolResult(agent, 'D1'), /have not read this file/);
  assert.match(toolResult(agent, 'D1'), /was not run since the bug was reported/);
  assert.ok(held(agent, 'E1'));
  assert.match(toolResult(agent, 'E1'), /Your last record_diagnosis call was not accepted/);
  assert.equal(await read(), 'one\ntwo\nthree\n');
});

test('the fix must make the reproduction pass: a failing reproduction goes back to the model', async () => {
  const wrongFix = call('edit_file', { path: 'a.js', old_string: 'three', new_string: 'THREE' }, 'E1');
  const { agent, ui, read } = await build([readA, runRepro(), record(), wrongFix, text('Done.'), edit('E2'), text('Done now.')]);
  await agent.send('fix the bug in a.js', { mode: 'auto', effort: 'medium', model: 'm' }, ui);
  assert.ok(agent.history.some((x) => x.role === 'user' && /The project checks failed/.test(String(x.content)) && /expected TWO/.test(String(x.content))));
  assert.equal(await read(), 'one\nTWO\nTHREE\n');
  assert.ok(ui.events.some((e) => /^info:Project checks passed: reproduction/.test(e)));
});

test('test files and repro scripts can be written while source files are locked', async () => {
  const writeTest = call('write_file', { path: 'repro.js', content: 'process.exit(1)\n' }, 'W1');
  const { agent, root } = await build([writeTest, text('Wrote the reproduction.')]);
  await agent.send('fix the crash on save', { mode: 'auto', effort: 'medium', model: 'm' }, recordingUi());
  assert.ok(!held(agent, 'W1'), toolResult(agent, 'W1'));
  assert.equal(await fs.readFile(path.join(root, 'repro.js'), 'utf8'), 'process.exit(1)\n');
});

test('not a bug fix, or the setting off: no lock, no extra tool', async () => {
  for (const [msg, setting] of [['capitalize two in a.js', 'auto'], ['fix the bug in a.js', 'off'], ['fix the bug in a.js', 'none']] as const) {
    const { agent, read, llm } = await build([readA, edit('E1'), text('Done.')], setting);
    await agent.send(msg, { mode: 'auto', effort: 'medium', model: 'm' }, recordingUi());
    assert.ok(!held(agent, 'E1'), `${msg} / ${setting}`);
    assert.equal(await read(), 'one\nTWO\nthree\n');
    assert.ok(!offered(llm, 0));
  }
});

test('medium confidence unlocks only after the user answered a question', async () => {
  const ask = call('ask_user_question', { questions: [{ question: 'Should two be upper case?', options: [{ label: 'Yes' }, { label: 'No' }] }] }, 'Q1');
  const { agent, ui, read } = await build([readA, runRepro(), record('D1', { confidence: 'medium' }), ask, record('D2', { confidence: 'medium' }), edit('E1'), text('Done.')], 'auto', { answer: true });
  await agent.send('fix the bug in a.js', { mode: 'auto', effort: 'medium', model: 'm' }, ui);
  assert.match(toolResult(agent, 'D1'), /^DIAGNOSIS RECORDED, source files still locked: confidence is medium/);
  assert.match(toolResult(agent, 'D2'), /^DIAGNOSIS ACCEPTED/);
  assert.equal(await read(), 'one\nTWO\nthree\n');
});

test('a writing sub-agent is held while locked; a read-only one runs', async () => {
  const general = call('agent', { description: 'Fix it', prompt: 'Fix a.js', subagent_type: 'general-purpose' }, 'A1');
  const { agent } = await build([general, text('Stopped.')]);
  await agent.send('fix the bug in a.js', { mode: 'auto', effort: 'medium', model: 'm' }, recordingUi());
  assert.ok(held(agent, 'A1'), toolResult(agent, 'A1'));

  const explore = call('agent', { description: 'Look', prompt: 'Find the bug', subagent_type: 'explore' }, 'A2');
  const b = await build([explore, text('Stopped.')]);
  await b.agent.send('fix the bug in a.js', { mode: 'auto', effort: 'medium', model: 'm' }, recordingUi());
  assert.ok(!held(b.agent, 'A2'));
});

test('the turn stops after repeated held edits instead of looping', async () => {
  const edits = Array.from({ length: MAX_HOLDS + 2 }, (_, i) => edit(`E${i}`));
  const { agent, ui, mainCalls, read } = await build([...edits, text('never reached')]);
  await agent.send('fix the bug in a.js', { mode: 'auto', effort: 'medium', model: 'm' }, ui);
  assert.equal(mainCalls(), MAX_HOLDS);
  assert.ok(ui.events.some((e) => /^info:Stopped: the agent tried to change code/.test(e)));
  assert.match(toolResult(agent, `E${MAX_HOLDS - 1}`), /call ask_user_question/);
  assert.equal(await read(), 'one\ntwo\nthree\n');
});

test('the lock carries into the next turn until the bug is proven fixed, then ends', async () => {
  const { agent, read } = await build([
    readA, text('Is upper case expected?'), // turn 1: asks in plain text and stops
    edit('E1'), readA, runRepro(), record(), edit('E2'), text('Fixed.'), // turn 2: "yes"
    readA, edit('E3'), text('Done.'), // turn 3: an unrelated change, no lock
  ]);
  const opts = { mode: 'auto', effort: 'medium', model: 'm' } as const;
  await agent.send('fix the bug in a.js', opts, recordingUi());
  await agent.send('yes', opts, recordingUi());
  assert.ok(held(agent, 'E1'), 'still locked in the follow-up turn');
  assert.ok(!held(agent, 'E2'));
  assert.equal(await read(), 'one\nTWO\nthree\n');
  await fs.writeFile(path.join(agent['deps'].root, 'a.js'), 'one\ntwo\nthree\n');
  await agent.send('capitalize two again', opts, recordingUi());
  assert.ok(!held(agent, 'E3'), 'the proven fix ended the lock');
});

test('a new bug report starts a fresh lock even after an accepted diagnosis', async () => {
  const { agent } = await build([readA, runRepro(), record(), edit('E1'), text('Fixed.'), edit('E2'), text('Held.')]);
  const opts = { mode: 'auto', effort: 'medium', model: 'm' } as const;
  await agent.send('fix the bug in a.js', opts, recordingUi());
  assert.ok(!held(agent, 'E1'));
  await agent.send('still broken: the export is not working', opts, recordingUi());
  assert.ok(held(agent, 'E2'));
});
