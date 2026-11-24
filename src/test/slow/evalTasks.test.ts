/**
 * Proves that every bundled eval task (eval/tasks/*) is gradable, offline and without an LLM: for each task the
 * check must FAIL on the untouched fixture and PASS once the task's reference solution (solution/) is applied,
 * and the solution must not touch the task's protected files. Tasks whose toolchain (task.json "requires") is
 * missing on this machine are skipped, the same way `npm run eval` skips them.
 *
 * Each grade spawns a shell and Node (or Python), so the tasks run concurrently to keep this file fast, and the file
 * lives in test/slow/ (run alone by `npm run test:slow`) so that load does not starve timing-sensitive unit tests.
 */
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_HISTORY, parseArgs } from '../../eval/run';
import { applySolution, appendHistory, diffTrees, EvalReport, gradeRepo, historyEntry, prepareRepo, protectedChanges } from '../../eval/runner';
import { DIFFICULTIES, EvalTask, findTasksDir, loadTasks, missingToolchains, solutionDir, validateTask } from '../../eval/tasks';
import { tmpDir } from '../helpers';

const TASKS_DIR = findTasksDir(__dirname, process.cwd());
const loaded = TASKS_DIR ? loadTasks(TASKS_DIR) : { tasks: [] as EvalTask[], errors: ['eval/tasks not found'] };

test('eval tasks: every task loads and has a reference solution, a difficulty and a language', () => {
  assert.deepEqual(loaded.errors, []);
  assert.ok(loaded.tasks.length >= 40, `expected at least 40 tasks, found ${loaded.tasks.length}`);
  const names = loaded.tasks.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'task names are unique');
  for (const t of loaded.tasks) {
    assert.equal(t.name, path.basename(t.dir), `${t.name}: the folder is named after the task`);
    assert.ok(solutionDir(t), `${t.name}: has a solution/ folder`);
    assert.ok(t.difficulty && DIFFICULTIES.includes(t.difficulty), `${t.name}: difficulty`);
    assert.ok(t.language, `${t.name}: language`);
    assert.ok(t.hiddenTests, `${t.name}: grades with files the agent does not see`);
  }
});

describe('eval tasks: the check fails untouched and passes with the reference solution', { concurrency: Math.max(2, Math.min(8, os.cpus().length)) }, () => {
  for (const t of loaded.tasks) {
    const missing = missingToolchains(t);
    test(t.name, { skip: missing.length ? `needs ${missing.join(', ')}` : false }, async () => {
      const base = await tmpDir('ica-evaltask-');
      try {
        const before = path.join(base, 'before');
        prepareRepo(t, before);
        const original = await gradeRepo(t, before);
        assert.equal(original.passed, false, `the untouched repo must fail:\n${original.output}`);

        const pristine = path.join(base, 'pristine');
        const after = path.join(base, 'after');
        prepareRepo(t, pristine);
        prepareRepo(t, after);
        applySolution(t, after);
        assert.deepEqual(protectedChanges(t, diffTrees(pristine, after)), [], 'the solution must not change protected files');
        const fixed = await gradeRepo(t, after);
        assert.equal(fixed.passed, true, `the reference solution must pass:\n${fixed.output}`);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });
  }
});

test('eval tasks: applySolution copies files, deletes listed paths and keeps CRLF files CRLF', async () => {
  const dir = await tmpDir();
  const taskDir = path.join(dir, 'task');
  fs.mkdirSync(path.join(taskDir, 'repo', 'src', 'old'), { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'repo', 'src', 'old', 'a.js'), 'old\n');
  fs.writeFileSync(path.join(taskDir, 'repo', 'src', 'b.js'), 'b1\r\nb2\r\n');
  fs.mkdirSync(path.join(taskDir, 'solution', 'src'), { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'solution', 'src', 'b.js'), 'b1\nb2\nb3\n');
  fs.writeFileSync(path.join(taskDir, 'solution', 'src', 'new.js'), 'new\n');
  fs.writeFileSync(path.join(taskDir, 'solution', '__delete__.txt'), '# moved\nsrc/old\n\n');
  const task: EvalTask = { name: 't', prompt: 'p', check: 'c', crlf: ['src/b.js'], dir: taskDir };
  const repo = path.join(dir, 'repo');
  prepareRepo(task, repo);
  applySolution(task, repo);
  assert.equal(fs.existsSync(path.join(repo, 'src', 'old')), false);
  assert.equal(fs.existsSync(path.join(repo, '__delete__.txt')), false);
  assert.equal(fs.readFileSync(path.join(repo, 'src', 'new.js'), 'utf8'), 'new\n');
  assert.equal(fs.readFileSync(path.join(repo, 'src', 'b.js'), 'utf8'), 'b1\r\nb2\r\nb3\r\n');
  assert.throws(() => applySolution({ ...task, dir: path.join(dir, 'nope') }, repo), /no reference solution/);
});

test('eval tasks: task.json metadata is validated', async () => {
  const dir = await tmpDir();
  fs.mkdirSync(path.join(dir, 'repo'));
  const errs = validateTask({ name: 'n', prompt: 'p', check: 'c', difficulty: 'trivial', language: '', requires: ['cobol'], solution: 'nope' }, dir);
  for (const m of [/"difficulty" must be one of easy, medium, hard/, /"language"/, /unknown toolchain "cobol"/, /solution folder "nope"/]) {
    assert.ok(errs.some((e) => m.test(e)), `${m} in ${errs.join(' | ')}`);
  }
  assert.deepEqual(validateTask({ name: 'n', prompt: 'p', check: 'c', difficulty: 'hard', language: 'python', requires: ['python'] }, dir), []);
  assert.deepEqual(missingToolchains({}), []);
  assert.deepEqual(missingToolchains({ requires: ['no-such-toolchain'] }), ['no-such-toolchain']);
});

test('eval history: one JSON line per suite run, with per-task and per-difficulty results', async () => {
  const rep: EvalReport = {
    startedAt: '2026-11-23T10:00:00.000Z', model: 'qwen3-coder', effort: 'medium', repeat: 2, runs: [],
    summary: { tasks: 2, runs: 4, passed: 3, passRate: 0.75, perTask: { a: { passed: 2, runs: 2 }, b: { passed: 1, runs: 2 } } },
  };
  const tasks = [{ name: 'a', difficulty: 'easy' }, { name: 'b' }] as EvalTask[];
  const entry = historyEntry(rep, tasks, '0.28.0', ['py-task']);
  assert.deepEqual(entry, {
    date: '2026-11-23T10:00:00.000Z', version: '0.28.0', model: 'qwen3-coder', effort: 'medium', repeat: 2,
    tasks: 2, runs: 4, passed: 3, passRate: 0.75,
    byDifficulty: { easy: { passed: 2, runs: 2 }, unrated: { passed: 1, runs: 2 } },
    perTask: { a: { passed: 2, runs: 2 }, b: { passed: 1, runs: 2 } }, skipped: ['py-task'],
  });
  const file = path.join(await tmpDir(), 'results', 'history.jsonl');
  appendHistory(file, entry);
  appendHistory(file, { ...entry, version: '0.29.0' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.deepEqual(lines.map((l) => JSON.parse(l).version), ['0.28.0', '0.29.0']);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), '.gitignore'), 'utf8'), '*\n');
});

test('eval CLI: --history and --history-file', () => {
  assert.deepEqual(parseArgs(['--history', '--repeat', '3']), { effort: 'medium', repeat: 3, keep: false, agents: ['infraon'], nativeSampling: false, history: DEFAULT_HISTORY });
  assert.deepEqual(parseArgs(['--history-file', 'h.jsonl']), { effort: 'medium', repeat: 1, keep: false, agents: ['infraon'], nativeSampling: false, history: 'h.jsonl' });
  assert.match(String(parseArgs(['--history-file'])), /needs a value/);
});
