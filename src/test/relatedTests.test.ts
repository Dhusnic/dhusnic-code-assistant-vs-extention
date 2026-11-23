import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Agent, CheckCommand, mapToTestFiles, narrowCheck, narrowedLabel, relatedTestsFor, testStem } from '../core/agent';
import { findTestFiles } from '../core/verify';
import { REVIEW_SYSTEM } from '../core/selfReview';
import { Tool, fnSpec } from '../core/tool';
import type { Effort } from '../core/policy';
import { call, recordingUi, text, tmpDir } from './helpers';

/* ------------------------------------------------------------------ recognising the runner */

test('relatedTestsFor: jest, from a package script or typed, keeps its flags; filters are not narrowed', () => {
  assert.equal(relatedTestsFor('npm run test', 'jest')?.template, 'npx jest --findRelatedTests {files} --passWithNoTests');
  assert.equal(relatedTestsFor('yarn test', 'jest --ci --silent', 'yarn')?.template, 'yarn jest --ci --silent --findRelatedTests {files} --passWithNoTests');
  assert.equal(relatedTestsFor('npx jest --ci')?.template, 'npx jest --ci --findRelatedTests {files} --passWithNoTests');
  assert.equal(relatedTestsFor('npm run test', 'jest src/api'), undefined, 'a positional filter');
  assert.equal(relatedTestsFor('npm run test', 'cross-env CI=1 jest'), undefined, 'an environment prefix');
  assert.equal(relatedTestsFor('npm run test', 'jest | tee log.txt'), undefined, 'a pipe');
});

test('relatedTestsFor: vitest (with or without run) becomes vitest related … --run', () => {
  assert.equal(relatedTestsFor('npm run test', 'vitest run --coverage')?.template, 'npx vitest related {files} --run --passWithNoTests --coverage');
  assert.equal(relatedTestsFor('pnpm run test', 'vitest', 'pnpm exec')?.template, 'pnpm exec vitest related {files} --run --passWithNoTests');
  assert.equal(relatedTestsFor('npm run test', 'vitest run src/a'), undefined);
});

test('relatedTestsFor: pytest, go test and node --test', () => {
  const py = relatedTestsFor('python -m pytest -q -x');
  assert.equal(py?.runner, 'pytest');
  assert.equal(py?.template, 'python -m pytest -q -x {tests}');
  assert.equal(relatedTestsFor('pytest tests/unit'), undefined, 'already limited to a folder');
  assert.equal(relatedTestsFor('go test -race ./...')?.template, 'go test -race {dirs}');
  assert.equal(relatedTestsFor('go test ./pkg/...'), undefined);
  const node = relatedTestsFor('npm run test:unit', 'tsc -p . && node --test "out/test/*.test.js"');
  assert.equal(node?.template, 'npx tsc -p . && node --test {tests}', 'the build step runs first, through npx');
  assert.deepEqual(node?.testGlobs, ['out/test/*.test.js']);
  assert.equal(relatedTestsFor('npm test', 'node --test'), undefined, 'no explicit test patterns');
  assert.equal(relatedTestsFor('npm test', 'node --test "a/*.test.js" && node --test "b/*.test.js"'), undefined, 'two test runs');
  assert.equal(relatedTestsFor('npm run lint'), undefined);
  assert.equal(relatedTestsFor('cargo test'), undefined);
});

/* ------------------------------------------------------------------ mapping changed files to tests */

test('testStem: strips folders, extensions and test markers', () => {
  assert.deepEqual(['src/core/checks.ts', 'out/test/checks.test.js', 'tests/test_checks.py', 'pkg/checks_test.py', 'a/checks.spec.tsx'].map(testStem), ['checks', 'checks', 'checks', 'checks', 'checks']);
});

test('narrowCheck pytest: sources map to test_<name>.py and <name>_test.py; changed tests are passed as they are', () => {
  const check: CheckCommand = { name: 'test', command: 'python -m pytest -q', timeoutSeconds: 60, related: relatedTestsFor('python -m pytest -q') };
  const tests = ['tests/test_parser.py', 'tests/lexer_test.py', 'tests/test_other.py'];
  const n = narrowCheck(check, ['app/parser.py', 'app/lexer.py', 'tests/test_other.py'], tests);
  assert.equal(n?.command, 'python -m pytest -q "tests/test_parser.py" "tests/lexer_test.py" "tests/test_other.py"');
  assert.equal(n?.name, 'test (related: 3 files)');
  assert.equal(narrowedLabel(n!), 'python -m pytest -q (related: 3 files)');
  // Uncertain: a source without a test of its name, shared setup, or a non-Python change.
  assert.equal(narrowCheck(check, ['app/parser.py', 'app/nothing.py'], tests), undefined);
  assert.equal(narrowCheck(check, ['tests/conftest.py'], tests), undefined);
  assert.equal(narrowCheck(check, ['app/parser.py', 'pyproject.toml'], tests), undefined);
  assert.equal(narrowCheck(check, ['app/parser.py'], []), undefined, 'no test files found: the full command');
});

test('narrowCheck node --test: changed tests and same-named tests among the compiled test files', () => {
  const check: CheckCommand = { name: 'test', command: 'npm run test:unit', timeoutSeconds: 60, related: relatedTestsFor('npm run test:unit', 'tsc -p . && node --test "out/test/*.test.js"') };
  const tests = ['out/test/checks.test.js', 'out/test/checkFeedback.test.js', 'out/test/agent.test.js'];
  const n = narrowCheck(check, ['src/core/checks.ts', 'src/test/checkFeedback.test.ts'], tests);
  assert.equal(n?.command, 'npx tsc -p . && node --test "out/test/checks.test.js" "out/test/checkFeedback.test.js"');
  assert.equal(n?.narrowed?.full, check);
  assert.equal(narrowCheck(check, ['src/test/helpers.ts'], [...tests, 'out/test/helpers.test.js']), undefined, 'shared helpers: everything');
  assert.equal(narrowCheck(check, ['src/core/brandNew.ts'], tests), undefined, 'no test of that name');
  assert.equal(narrowCheck(check, ['media/session.css'], tests), undefined, 'not JavaScript or TypeScript');
  assert.deepEqual(mapToTestFiles('node', ['src/a.ts'], ['test/a.test.js', 'test/a.spec.js']), ['test/a.test.js', 'test/a.spec.js']);
});

test('findTestFiles: walks only the fixed folders of each glob, and includes build output', async () => {
  const root = await tmpDir('reltests-');
  for (const f of ['out/test/a.test.js', 'out/test/b.js', 'out/other/c.test.js', 'tests/test_x.py', 'pkg/sub/y_test.py', 'node_modules/m/test_z.py']) {
    await fs.mkdir(path.join(root, path.dirname(f)), { recursive: true });
    await fs.writeFile(path.join(root, f), '');
  }
  assert.deepEqual(await findTestFiles(root, ['out/test/*.test.js']), ['out/test/a.test.js']);
  assert.deepEqual((await findTestFiles(root, ['**/test_*.py', '**/*_test.py'])).sort(), ['pkg/sub/y_test.py', 'tests/test_x.py']);
  assert.deepEqual(await findTestFiles(root, ['missing/*.js']), []);
});

/* ------------------------------------------------------------------ the agent: related first, full verdict */

const JEST: CheckCommand = { name: 'test', command: 'npm run test', timeoutSeconds: 600, related: relatedTestsFor('npm run test', 'jest') };
const NARROW = 'npx jest --findRelatedTests "src/a.ts" --passWithNoTests';

/**
 * An agent that edits src/a.ts and finishes, as often as asked. `result(command, n)` decides each check: true passes.
 * Records the commands run, and whether a self-review was requested.
 */
function setup(result: (command: string, n: number) => boolean, checks: CheckCommand[] = [JEST], root = path.resolve('/w')) {
  const ran: string[] = [];
  let reviews = 0;
  let step = 0;
  const edit: Tool = { kind: 'edit', spec: fnSpec('edit_file', '', {}, []), describe: () => 'Edit', run: async () => 'Edited' };
  const run: Tool = {
    kind: 'exec', spec: fnSpec('run_command', '', {}, []), describe: (a) => `Run: ${a.command}`,
    run: async (a) => {
      ran.push(a.command);
      const ok = result(a.command, ran.length);
      return ok ? 'ok\n[exit 0]' : `FAIL src/a.test.ts\n  ✕ adds (${ran.length} ms)\nsrc/a.ts(${ran.length},1): error TS2304: Cannot find name 'x${ran.length}'.\n[exit 1]`;
    },
  };
  const agent = new Agent({
    root, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: false }),
    tools: () => [edit, run], checks: () => checks, selfReview: () => 'always',
    llm: async (_cfg, msgs) => {
      if (msgs[0].content === REVIEW_SYSTEM) { reviews++; return text('LGTM'); }
      return step++ % 2 === 0 ? call('edit_file', { path: 'src/a.ts' }, `e${step}`) : text('done');
    },
  });
  return { agent, ran, ui: recordingUi(true), reviews: () => reviews };
}
const opts = (effort: Effort) => ({ mode: 'auto', effort, model: 'm' } as const);

test('agent: a fix round runs the related tests, then the full suite before finishing', async () => {
  const { agent, ran, ui, reviews } = setup((_c, n) => n > 1);
  await agent.send('fix', opts('medium'), ui);
  assert.deepEqual(ran, ['npm run test', NARROW, 'npm run test'], 'full (fails), related (passes), full (passes)');
  assert.ok(ui.events.includes('info:Running the related tests first: npm run test (related: 1 file).'));
  assert.ok(ui.events.some((e) => /Related tests passed; running the full suite before finishing: npm run test\./.test(e)));
  assert.ok(ui.events.includes('info:Project checks passed: test.'));
  assert.equal(reviews(), 1, 'checks resolved: the self-review runs');
  // The summary counts the full run only.
  assert.ok(ui.events.some((e) => /Checked after the last change: ✓ npm run test$/.test(e)));
});

test('agent: a related failure goes back to the model with the narrowed label and uses a fix round', async () => {
  const { agent, ran, ui } = setup((_c, n) => n >= 4);
  await agent.send('fix', opts('medium'), ui);
  const sent = agent.history.filter((m) => m.role === 'user' && /automatic check/.test(String(m.content))).map((m) => String(m.content));
  assert.deepEqual(ran, ['npm run test', NARROW, NARROW, 'npm run test']);
  assert.equal(sent.length, 2, 'two fix rounds at medium effort');
  assert.match(sent[1], /automatic check 2 of 2/);
  assert.match(sent[1], /### test \(related: 1 file\): `npx jest --findRelatedTests "src\/a\.ts" --passWithNoTests`/);
  assert.ok(agent.history.some((m) => m.display === 'Checks failed: test (related: 1 file)'));
  assert.ok(ui.events.includes('info:Project checks passed: test.'));
});

test('agent: a related pass followed by a full failure is reported and fixed within the round limit', async () => {
  // The related run always passes, the full run always fails: medium effort allows two fix rounds.
  const { agent, ran, ui, reviews } = setup((c) => c === NARROW);
  await agent.send('fix', opts('medium'), ui);
  assert.deepEqual(ran, ['npm run test', NARROW, 'npm run test', NARROW, 'npm run test']);
  assert.ok(ui.events.some((e) => /still failing \(test: npm run test\) after 2 fix attempts/.test(e)), 'the verdict is the full suite');
  assert.equal(reviews(), 0, 'checks unresolved: no self-review');
  assert.ok(ui.events.some((e) => /Checked after the last change: ✗ npm run test$/.test(e)));
});

test('agent: a related failure with no fix round left is confirmed by the full suite', async () => {
  // Low effort: one fix round. Full fails, related fails, then the full suite gives the verdict.
  const failing = setup(() => false);
  await failing.agent.send('fix', opts('low'), failing.ui);
  assert.deepEqual(failing.ran, ['npm run test', NARROW, 'npm run test']);
  assert.ok(failing.ui.events.some((e) => /still failing \(test: npm run test\) after 1 fix attempts/.test(e)));
  assert.equal(failing.reviews(), 0);
  // The related run fails but the full suite passes: the turn ends with the checks passed.
  const flaky = setup((_c, n) => n === 3);
  await flaky.agent.send('fix', opts('low'), flaky.ui);
  assert.deepEqual(flaky.ran, ['npm run test', NARROW, 'npm run test']);
  assert.ok(flaky.ui.events.includes('info:Project checks passed: test.'));
  assert.equal(flaky.reviews(), 1);
});

test('agent: lint is never narrowed, and a check without a related form runs in full every round', async () => {
  const LINT: CheckCommand = { name: 'lint', command: 'npm run lint', timeoutSeconds: 300 };
  const { agent, ran, ui } = setup((c, n) => c === 'npm run lint' || n > 2, [LINT, JEST]);
  await agent.send('fix', opts('medium'), ui);
  // lint passes, test fails; then lint and the related tests, then the full test.
  assert.deepEqual(ran, ['npm run lint', 'npm run test', 'npm run lint', NARROW, 'npm run test']);
  assert.ok(ui.events.includes('info:Project checks passed: lint, test.'));
  const plain = setup((_c, n) => n > 1, [{ name: 'test', command: 'npm run test', timeoutSeconds: 60 }]);
  await plain.agent.send('fix', opts('medium'), plain.ui);
  assert.deepEqual(plain.ran, ['npm run test', 'npm run test']);
});

test('agent: pytest maps the changed source to its test file on disk; unmapped changes run in full', async () => {
  const root = await tmpDir('reltests-py-');
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests', 'test_a.py'), '');
  const PY: CheckCommand = { name: 'test', command: 'python -m pytest -q -x', timeoutSeconds: 600, related: relatedTestsFor('python -m pytest -q -x') };
  const unmapped = setup((_c, n) => n > 1, [PY], root);
  // setup edits src/a.ts: not Python, so the mapping is uncertain and the fix round runs the full suite.
  await unmapped.agent.send('fix', opts('medium'), unmapped.ui);
  assert.deepEqual(unmapped.ran, ['python -m pytest -q -x', 'python -m pytest -q -x']);
  assert.ok(!unmapped.ui.events.some((e) => /related tests first/.test(e)));
  assert.equal(narrowCheck(PY, ['src/a.py'], await findTestFiles(root, PY.related!.testGlobs!))?.command, 'python -m pytest -q -x "tests/test_a.py"');
});
