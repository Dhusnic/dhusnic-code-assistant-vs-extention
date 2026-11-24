import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { LlmFn, StreamResult } from '../../core/llm';
import { parseArgs } from '../../eval/run';
import { diffTrees, formatReport, gradeRepo, prepareRepo, protectedChanges, runEval } from '../../eval/runner';
import { EvalTask, findTasksDir, loadTasks, validateTask } from '../../eval/tasks';
import { call, text, tmpDir } from '../helpers';

const TASKS_DIR = findTasksDir(__dirname, process.cwd());
const loaded = TASKS_DIR ? loadTasks(TASKS_DIR) : { tasks: [], errors: ['eval/tasks not found'] };
const task = (name: string): EvalTask => {
  const t = loaded.tasks.find((x) => x.name === name);
  assert.ok(t, `task ${name} exists`);
  return t;
};
const write = (root: string, rel: string, content: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); };
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

/* ------------------------------------------------------------------ a correct fix, as the scripted LLM writes it */
/* (every task's own reference solution lives in eval/tasks/<task>/solution/ and is checked by evalTasks.test.ts) */

const PAGINATE_FIXED = `'use strict';

/** Returns the items shown on one page. Pages are numbered from 1. */
function paginate(items, page, pageSize) {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

/** Number of pages needed to show every item. */
function pageCount(total, pageSize) {
  return Math.ceil(total / pageSize);
}

module.exports = { paginate, pageCount };
`;

/* ------------------------------------------------------------------ task definitions */

test('eval: all bundled tasks load without errors', () => {
  assert.deepEqual(loaded.errors, []);
  for (const name of ['add-feature', 'bug-no-test', 'crlf-edit', 'fix-off-by-one', 'refactor-rename']) { task(name); }
});

test('eval: task.json validation reports every problem', async () => {
  const dir = await tmpDir();
  assert.deepEqual(validateTask(null, dir), ['task.json must contain a JSON object']);
  const errs = validateTask({ name: '', prompt: 3, timeoutSeconds: -1, mustNotChange: [''], hiddenTests: 'nope' }, dir);
  for (const m of [/"name"/, /"prompt"/, /"check"/, /timeoutSeconds/, /mustNotChange/, /hiddenTests folder "nope"/, /no repo\//]) {
    assert.ok(errs.some((e) => m.test(e)), `${m} in ${errs.join(' | ')}`);
  }
  fs.mkdirSync(path.join(dir, 'ok', 'repo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ok', 'task.json'), JSON.stringify({ name: 'ok', prompt: 'p', check: 'c' }));
  fs.mkdirSync(path.join(dir, 'broken'));
  fs.writeFileSync(path.join(dir, 'broken', 'task.json'), '{ nope');
  fs.mkdirSync(path.join(dir, 'empty'));
  const r = loadTasks(dir);
  assert.deepEqual(r.tasks.map((t) => t.name), ['ok']);
  assert.equal(r.errors.length, 2);
  assert.ok(r.errors.some((e) => /^broken: task.json is not valid JSON/.test(e)));
  assert.ok(r.errors.some((e) => /^empty: no task.json/.test(e)));
});

test('eval task crlf-edit: the repo starts with CRLF, and a fix that switches to LF fails', async () => {
  const t = task('crlf-edit');
  const dir = path.join(await tmpDir(), 'repo');
  prepareRepo(t, dir);
  assert.match(read(dir, 'src/config.js'), /timeoutMs: 1000,\r\n/);
  write(dir, 'src/config.js', read(dir, 'src/config.js').replace(/\r\n/g, '\n').replace('timeoutMs: 1000,', 'timeoutMs: 5000,\n  verbose: false,'));
  const r = await gradeRepo(t, dir);
  assert.equal(r.passed, false);
  assert.match(r.output, /no longer uses CRLF/);
});

test('eval task refactor-rename: a leftover use of the old name fails', async () => {
  const t = task('refactor-rename');
  const dir = path.join(await tmpDir(), 'repo');
  prepareRepo(t, dir);
  for (const f of ['src/total.js', 'src/order.js', 'test/total.test.js']) { write(dir, f, read(dir, f).replace(/\bcalcTotal\b/g, 'calculateOrderTotal')); }
  const r = await gradeRepo(t, dir);
  assert.equal(r.passed, false);
  assert.match(r.output, /src[\\/]report\.js:\d+/);
});

test('eval: diffTrees and protected files', async () => {
  const a = await tmpDir(), b = await tmpDir();
  write(a, 'src/x.js', '1'); write(b, 'src/x.js', '2');
  write(a, 'test/t.js', 't'); write(b, 'test/t.js', 't');
  write(a, 'gone.js', 'g'); write(b, 'new.js', 'n');
  const changed = diffTrees(a, b);
  assert.deepEqual(changed, ['gone.js', 'new.js', 'src/x.js']);
  const t = { ...task('fix-off-by-one') };
  assert.deepEqual(protectedChanges(t, ['src/a.js', 'test/paginate.test.js']), ['test/paginate.test.js']);
});

/* ------------------------------------------------------------------ the runner, with a scripted LLM */

const CFG = { baseUrl: 'http://unused', apiKey: 'k', model: 'fake-model', temperature: 0, allowSelfSigned: false };

function scripted(steps: StreamResult[]): { llm: LlmFn; calls: () => number } {
  let i = 0;
  return {
    llm: async (_cfg, _m, _t, onToken) => {
      const r = steps[Math.min(i++, steps.length - 1)];
      if (r.content) { onToken(r.content); }
      return { ...r, usage: { prompt: 100, completion: 10 } };
    },
    calls: () => i,
  };
}

test('eval runner: a run that fixes the bug passes, with stats and a log', async () => {
  const logDir = await tmpDir();
  const fake = scripted([
    call('read_file', { path: 'src/paginate.js' }, 'r1'),
    call('write_file', { path: 'src/paginate.js', content: PAGINATE_FIXED }, 'w1'),
    text('Fixed both off-by-one bugs.'),
  ]);
  const lines: string[] = [];
  const rep = await runEval({ tasks: [task('fix-off-by-one')], llmConfig: CFG, effort: 'medium', logDir, print: (l) => lines.push(l) }, { llm: fake.llm });
  const r = rep.runs[0];
  assert.equal(r.passed, true, `${r.reason}\n${fs.readFileSync(r.logFile, 'utf8')}`);
  assert.equal(r.reason, 'passed');
  assert.deepEqual(r.filesChanged, ['src/paginate.js']);
  assert.equal(r.llmCalls, 3);
  assert.equal(r.promptTokens, 300);
  assert.equal(r.toolCalls.read_file, 1);
  assert.equal(r.toolCalls.write_file, 1);
  assert.ok((r.toolCalls.run_command ?? 0) >= 1, 'the automatic project checks ran');
  assert.deepEqual(rep.summary, { tasks: 1, runs: 1, passed: 1, passRate: 1, perTask: { 'fix-off-by-one': { passed: 1, runs: 1 } } });
  assert.match(fs.readFileSync(r.logFile, 'utf8'), /RESULT: PASS/);
  assert.ok(lines.some((l) => /PASS/.test(l)));
  assert.match(formatReport(rep), /Overall: 1\/1 runs passed \(100%\)/);
});

test('eval runner: editing the protected tests to make them pass is a failure', async () => {
  const fake = scripted([
    call('read_file', { path: 'test/paginate.test.js' }, 'r1'),
    call('write_file', { path: 'test/paginate.test.js', content: "require('node:test')('nothing', () => {});\n" }, 'w1'),
    text('Tests pass now.'),
  ]);
  const rep = await runEval({ tasks: [task('fix-off-by-one')], llmConfig: CFG, effort: 'low', logDir: await tmpDir() }, { llm: fake.llm });
  assert.equal(rep.runs[0].passed, false);
  assert.match(rep.runs[0].reason, /changed protected files: test\/paginate\.test\.js/);
});

test('eval runner: an agent that does nothing fails, repeat counts every run', async () => {
  const fake = scripted([text('I looked at it.')]);
  const rep = await runEval({ tasks: [task('bug-no-test')], llmConfig: CFG, effort: 'low', repeat: 2, logDir: await tmpDir() }, { llm: fake.llm });
  assert.equal(rep.runs.length, 2);
  assert.deepEqual(rep.runs.map((r) => r.reason), ['check failed', 'check failed']);
  assert.equal(rep.summary.passRate, 0);
  assert.match(formatReport(rep), /bug-no-test\s+0\/2/);
});

test('eval runner: the time limit cancels a stuck agent', async () => {
  const stuck: LlmFn = (_c, _m, _t, _o, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
  const start = Date.now();
  const rep = await runEval({ tasks: [task('fix-off-by-one')], llmConfig: CFG, effort: 'low', timeoutSeconds: 1, logDir: await tmpDir() }, { llm: stuck });
  assert.ok(Date.now() - start < 60_000);
  assert.equal(rep.runs[0].timedOut, true);
  assert.equal(rep.runs[0].reason, 'timed out and the check fails');
});

test('eval runner: an LLM error is recorded, and the repo is still graded', async () => {
  const broken: LlmFn = async () => { throw new Error('LLM HTTP 401: bad key'); };
  const rep = await runEval({ tasks: [task('fix-off-by-one')], llmConfig: CFG, effort: 'low', logDir: await tmpDir() }, { llm: broken });
  assert.equal(rep.runs[0].passed, false);
  assert.match(rep.runs[0].reason, /agent error: LLM HTTP 401/);
});

/* ------------------------------------------------------------------ CLI arguments */

test('eval CLI: arguments', () => {
  assert.deepEqual(parseArgs([]), { effort: 'medium', repeat: 1, keep: false, agents: ['infraon'], nativeSampling: false });
  assert.deepEqual(parseArgs(['--filter', 'rename', '--effort', 'high', '--repeat', '3', '--keep', '--model', 'qwen']),
    { effort: 'high', repeat: 3, keep: true, filter: 'rename', model: 'qwen', agents: ['infraon'], nativeSampling: false });
  assert.match(String(parseArgs(['--effort', 'huge'])), /--effort must be/);
  assert.match(String(parseArgs(['--repeat', '0'])), /--repeat must be/);
  assert.match(String(parseArgs(['--filter'])), /needs a value/);
  assert.match(String(parseArgs(['--filter', '('])), /Invalid regular expression/);
  assert.match(String(parseArgs(['--bogus'])), /unknown option --bogus/);
  assert.equal(parseArgs(['--help']), 'help');
});
