/**
 * Check-failure feedback: digestCheckOutput on realistic output of common test runners, compilers and linters, the
 * head+tail fallback, fix rounds per effort level, and the agent stopping when a fix attempt changed nothing.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Agent, CheckCommand, MAX_CHECK_ROUNDS, checkRoundsFor, digestCheckOutput, sameDigest } from '../core/agent';
import { Effort } from '../core/policy';
import { Tool, fnSpec } from '../core/tool';
import { call, fakeLlm, recordingUi, text } from './helpers';

const digest = (out: string, max = 8000) => digestCheckOutput('test', 'npm test', out, max);

/* ------------------------------------------------------------------ formats */

test('digest: tsc errors as file:line:col with the code, deduplicated, and counted', () => {
  const out = [
    'src/core/a.ts(12,5): error TS2322: Type \'string\' is not assignable to type \'number\'.',
    'src/core/b.ts:3:10 - error TS2304: Cannot find name \'foo\'.',
    '',
    '3   foo();',
    '           ~~~',
    'src/core/a.ts(12,5): error TS2322: Type \'string\' is not assignable to type \'number\'.',
    '',
    'Found 3 errors in 2 files.',
    '[exit 2]',
  ].join('\n');
  const d = digestCheckOutput('typecheck', 'npx tsc --noEmit', out, 8000);
  assert.match(d, /^### typecheck: `npx tsc --noEmit` \(exit 2\)/);
  assert.match(d, /2 errors\./);
  assert.match(d, /- src\/core\/a\.ts:12:5 TS2322: Type 'string' is not assignable to type 'number'\. \(×2\)/);
  assert.match(d, /- src\/core\/b\.ts:3:10 TS2304: Cannot find name 'foo'\./);
  assert.match(d, /Found 3 errors in 2 files\./, 'raw tail kept for context');
});

test('digest: eslint stylish output keeps errors with rules and drops warnings', () => {
  const out = [
    '',
    '/home/dev/proj/src/app.ts',
    '   3:7   error    \'unused\' is assigned a value but never used  @typescript-eslint/no-unused-vars',
    '  10:1   warning  Unexpected console statement                no-console',
    '',
    '/home/dev/proj/src/util.ts',
    '  22:15  error  Missing semicolon  semi',
    '',
    '✖ 3 problems (2 errors, 1 warning)',
    '[exit 1]',
  ].join('\n');
  const d = digest(out);
  assert.match(d, /- \/home\/dev\/proj\/src\/app\.ts:3:7 'unused' is assigned a value but never used \(@typescript-eslint\/no-unused-vars\)/);
  assert.match(d, /- \/home\/dev\/proj\/src\/util\.ts:22:15 Missing semicolon \(semi\)/);
  assert.doesNotMatch(d, /Errors[^\n]*\n(- .*\n)*- .*no-console/);
  assert.doesNotMatch(d, /Failing tests/);
});

test('digest: jest failures with names, expected/received and the project frame (not node_modules)', () => {
  const out = [
    'FAIL src/calc.test.ts',
    '  Calc',
    '    ✓ subtracts (2 ms)',
    '    ✕ adds (5 ms)',
    '',
    '  ● Calc › adds',
    '',
    '    expect(received).toBe(expected) // Object.is equality',
    '',
    '    Expected: 3',
    '    Received: 2',
    '',
    '      3 | test(\'adds\', () => {',
    '    > 4 |   expect(add(1, 1)).toBe(3);',
    '        |                     ^',
    '',
    '      at Object.<anonymous> (src/calc.test.ts:4:21)',
    '      at Promise.then.completed (node_modules/jest-circus/build/utils.js:298:28)',
    '',
    'Tests:       1 failed, 1 passed, 2 total',
  ].join('\n');
  const d = digest(out);
  assert.match(d, /Failing tests \(2\):\n- adds\n- Calc › adds/);
  assert.match(d, /expect\(received\)\.toBe\(expected\).*\| Expected: 3 \| Received: 2/);
  assert.match(d, /Stack frames in project code \(1\):\n- src\/calc\.test\.ts:4:21 \(Object\.<anonymous>\)/);
  assert.doesNotMatch(d.split('\n\nOutput:')[0], /jest-circus/);
});

test('digest: vitest failure with the ❯ location', () => {
  const out = [
    ' ❯ src/calc.test.ts (2 tests | 1 failed) 4ms',
    '   × calc > adds 3ms',
    '',
    ' FAIL  src/calc.test.ts > calc > adds',
    'AssertionError: expected 2 to be 3 // Object.is equality',
    ' ❯ src/calc.test.ts:5:22',
    '',
    ' Test Files  1 failed (1)',
  ].join('\n');
  const d = digest(out);
  assert.match(d, /- calc > adds/);
  assert.match(d, /- src\/calc\.test\.ts > calc > adds/);
  assert.match(d, /AssertionError: expected 2 to be 3/);
  assert.match(d, /- src\/calc\.test\.ts:5:22/);
});

test('digest: node:test TAP with the yaml error, expected/actual and the project stack line', () => {
  const out = [
    'TAP version 13',
    '# Subtest: adds',
    'not ok 1 - adds',
    '  ---',
    '  duration_ms: 0.71',
    '  location: \'/home/dev/proj/test/a.test.js:3:1\'',
    '  failureType: \'testCodeFailure\'',
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    ',
    '    2 !== 3',
    '    ',
    '  code: \'ERR_ASSERTION\'',
    '  name: \'AssertionError\'',
    '  expected: 3',
    '  actual: 2',
    '  operator: \'strictEqual\'',
    '  stack: |-',
    '    TestContext.<anonymous> (file:///home/dev/proj/test/a.test.js:5:10)',
    '    Test.runInAsyncScope (node:async_hooks:203:9)',
    '  ...',
    'ok 2 - subtracts',
    '1..2',
    '# pass 1',
    '# fail 1',
  ].join('\n');
  const d = digest(out);
  assert.match(d, /Failing tests \(1\):\n- adds/);
  assert.match(d, /Expected values to be strictly equal: \| 2 !== 3 \| expected: 3 \| actual: 2/);
  assert.match(d, /file:\/\/\/home\/dev\/proj\/test\/a\.test\.js:5:10/);
  assert.doesNotMatch(d, /- .*async_hooks/);
});

test('digest: node:test spec reporter', () => {
  const out = [
    '✔ subtracts (0.5ms)',
    '✖ adds (1.2ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '',
    '  2 !== 3',
    '',
    '      at TestContext.<anonymous> (file:///home/dev/proj/test/a.test.js:5:10)',
    '      at Test.runInAsyncScope (node:async_hooks:203:9)',
    'ℹ tests 2',
    'ℹ fail 1',
    '✖ failing tests:',
  ].join('\n');
  const d = digest(out);
  assert.match(d, /Failing tests \(1\):\n- adds\n/);
  assert.match(d, /AssertionError \[ERR_ASSERTION\]: Expected values to be strictly equal: \| 2 !== 3/);
  assert.match(d, /a\.test\.js:5:10 \(TestContext\.<anonymous>\)/);
});

test('digest: pytest failures, E lines and project frames (site-packages skipped)', () => {
  const out = [
    '============================= test session starts ==============================',
    'collected 2 items',
    '',
    'tests/test_calc.py .F                                                    [100%]',
    '',
    '=================================== FAILURES ===================================',
    '___________________________________ test_add ___________________________________',
    '',
    '    def test_add():',
    '>       assert add(1, 1) == 3',
    'E       assert 2 == 3',
    'E        +  where 2 = add(1, 1)',
    '',
    'tests/test_calc.py:5: AssertionError',
    '  File "/usr/lib/python3.11/site-packages/_pytest/python.py", line 194, in pytest_pyfunc_call',
    '=========================== short test summary info ============================',
    'FAILED tests/test_calc.py::test_add - assert 2 == 3',
    '========================= 1 failed, 1 passed in 0.03s ==========================',
  ].join('\n');
  const d = digest(out);
  assert.match(d, /Failing tests \(1\):\n- tests\/test_calc\.py::test_add/);
  assert.match(d, /- assert 2 == 3 \| \+ where 2 = add\(1, 1\)/);
  assert.match(d, /- tests\/test_calc\.py:5 AssertionError/);
  assert.doesNotMatch(d, /- .*site-packages/);
});

test('digest: mypy, ruff and flake8 lines', () => {
  const out = [
    'src/app.py:10: error: Incompatible types in assignment (expression has type "str", variable has type "int")  [assignment]',
    'src/app.py:11: note: See https://mypy.readthedocs.io',
    'src/util.py:1:8: F401 [*] `os` imported but unused',
    'src/util.py:20:80: E501 line too long (95 > 79 characters)',
    'F841 Local variable `x` is assigned to but never used',
    ' --> src/other.py:4:5',
    'Found 4 errors.',
  ].join('\n');
  const d = digest(out);
  assert.match(d, /- src\/app\.py:10 Incompatible types in assignment/);
  assert.doesNotMatch(d, /- src\/app\.py:11/);
  assert.match(d, /- src\/util\.py:1:8 F401 \[\*\] `os` imported but unused/);
  assert.match(d, /- src\/util\.py:20:80 E501 line too long/);
  assert.match(d, /- src\/other\.py:4:5 F841: Local variable `x` is assigned to but never used/);
  assert.match(d, /4 errors\./);
});

test('digest: go test and go build', () => {
  const out = [
    '--- FAIL: TestAdd (0.00s)',
    '    calc_test.go:10: Add(1, 1) = 2; want 3',
    '--- FAIL: TestSub (0.00s)',
    '    calc_test.go:18: Sub(3, 1) = 1; want 2',
    'FAIL',
    'FAIL\texample.com/calc\t0.002s',
    './main.go:5:2: undefined: foo',
  ].join('\n');
  const d = digest(out);
  assert.match(d, /Failing tests \(2\):\n- TestAdd\n- TestSub/);
  assert.match(d, /- calc_test\.go:10 Add\(1, 1\) = 2; want 3/);
  assert.match(d, /- \.\/main\.go:5:2 undefined: foo/);
});

test('digest: cargo build errors and test panics', () => {
  const build = [
    '   Compiling calc v0.1.0 (/home/dev/calc)',
    'error[E0308]: mismatched types',
    ' --> src/main.rs:4:18',
    '  |',
    '4 |     let x: i32 = "a";',
    '  |            ---   ^^^ expected `i32`, found `&str`',
    '',
    'error: aborting due to 1 previous error',
    'error: could not compile `calc` (bin "calc") due to 1 previous error',
  ].join('\n');
  const d1 = digest(build);
  assert.match(d1, /Errors \(1\):\n- src\/main\.rs:4:18 E0308: mismatched types/);
  const tests = [
    'running 2 tests',
    'test tests::it_subs ... ok',
    'test tests::it_adds ... FAILED',
    '',
    'failures:',
    '',
    '---- tests::it_adds stdout ----',
    'thread \'tests::it_adds\' panicked at src/lib.rs:10:9:',
    'assertion `left == right` failed',
    '  left: 2',
    ' right: 3',
    'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
    '',
    'test result: FAILED. 1 passed; 1 failed; 0 ignored',
    'error: test failed, to rerun pass `--lib`',
  ].join('\n');
  const d2 = digest(tests);
  assert.match(d2, /Failing tests \(1\):\n- tests::it_adds/);
  assert.match(d2, /panicked at src\/lib\.rs:10:9/);
  assert.match(d2, /assertion `left == right` failed \| left: 2 \| right: 3/);
  assert.doesNotMatch(d2, /Errors/);
});

test('digest: javac, maven and gradle', () => {
  const out = [
    '[INFO] Compiling 3 source files',
    '[ERROR] /home/dev/app/src/main/java/com/x/Calc.java:[12,9] cannot find symbol',
    'src/main/java/com/x/Util.java:7: error: \';\' expected',
    'e: file:///home/dev/app/src/main/kotlin/App.kt:3:5 Unresolved reference \'foo\'.',
    '[ERROR] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.05 s <<< FAILURE! - in com.x.CalcTest',
    '[ERROR] com.x.CalcTest.testAdd -- Time elapsed: 0.01 s <<< FAILURE!',
    'org.opentest4j.AssertionFailedError: expected: <3> but was: <2>',
    '\tat org.junit.jupiter.api.AssertionUtils.fail(AssertionUtils.java:55)',
    '\tat com.x.CalcTest.testAdd(CalcTest.java:14)',
    'CalcTest > testSub() FAILED',
  ].join('\n');
  const d = digest(out);
  assert.match(d, /- \/home\/dev\/app\/src\/main\/java\/com\/x\/Calc\.java:12:9 cannot find symbol/);
  assert.match(d, /- src\/main\/java\/com\/x\/Util\.java:7 ';' expected/);
  assert.match(d, /- \/home\/dev\/app\/src\/main\/kotlin\/App\.kt:3:5 Unresolved reference 'foo'\./);
  assert.match(d, /- com\.x\.CalcTest\.testAdd\n/);
  assert.match(d, /- CalcTest > testSub\(\)/);
  assert.doesNotMatch(d, /- Tests\n/);
  assert.match(d, /AssertionFailedError: expected: <3> but was: <2>/);
  assert.match(d, /Stack frames in project code \(1\):\n- CalcTest\.java:14 \(com\.x\.CalcTest\.testAdd\)/);
});

test('digest: dotnet build and test', () => {
  const out = [
    '/src/Calc/Calc.cs(10,13): error CS0103: The name \'foo\' does not exist in the current context [/src/Calc/Calc.csproj]',
    '  Failed Calc.Tests.CalcTests.Add [12 ms]',
    '  Error Message:',
    '   Assert.Equal() Failure',
    'Expected: 3',
    'Actual:   2',
    '  Stack Trace:',
    '     at Calc.Tests.CalcTests.Add() in /src/Calc.Tests/CalcTests.cs:line 10',
    '     at System.RuntimeMethodHandle.InvokeMethod(Object target, Span`1& arguments, Signature sig, Boolean isConstructor)',
  ].join('\n');
  const d = digest(out);
  assert.match(d, /- \/src\/Calc\/Calc\.cs:10:13 CS0103: The name 'foo' does not exist in the current context\n/);
  assert.match(d, /- Calc\.Tests\.CalcTests\.Add/);
  assert.match(d, /Assert\.Equal\(\) Failure \| Expected: 3 \| Actual: 2/);
  assert.match(d, /- \/src\/Calc\.Tests\/CalcTests\.cs:10 \(Calc\.Tests\.CalcTests\.Add\(\)\)/);
});

/* ------------------------------------------------------------------ budget and fallback */

test('digest: many errors are capped with a count, and the whole digest fits the budget', () => {
  const lines = Array.from({ length: 14 }, (_, i) => `src/f${i}.ts(${i + 1},1): error TS2304: Cannot find name 'x${i}'.`);
  const d = digest([...lines, 'Found 14 errors.'].join('\n'));
  assert.match(d, /Errors \(14, showing 10\):/);
  assert.match(d, /x9'/);
  assert.doesNotMatch(d, /- src\/f10\.ts/);
  const many = Array.from({ length: 500 }, (_, i) => `src/f${i}.ts(${i + 1},1): error TS2304: Cannot find name '${'y'.repeat(200)}${i}'.`).join('\n');
  const small = digest(many, 3000);
  assert.ok(small.length <= 3000, `too long: ${small.length}`);
  assert.match(small, /Errors \(500, showing \d+\)/);
});

test('digest: unrecognised output falls back to its head and tail, not the head only', () => {
  const lines = ['BUILD STARTING'];
  for (let i = 0; i < 3000; i++) { lines.push(`step ${i} working on something quite ordinary`); }
  lines.push('the very last line says what broke');
  const d = digest(lines.join('\n'), 4000);
  assert.ok(d.length < 4800, `too long: ${d.length}`);
  assert.match(d, /BUILD STARTING/);
  assert.match(d, /the very last line says what broke$/);
  assert.match(d, /chars omitted/);
});

test('digest: short output is included whole after the extracted parts', () => {
  const out = 'src/a.ts(1,1): error TS1005: \';\' expected.\n[exit 2]';
  const d = digest(out);
  assert.match(d, /\n\nOutput:\nsrc\/a\.ts\(1,1\)/);
});

test('sameDigest: ignores timings, not content', () => {
  const a = digest('--- FAIL: TestAdd (0.01s)\n    calc_test.go:10: got 2\nFAIL\tx\t0.004s');
  const b = digest('--- FAIL: TestAdd (0.03s)\n    calc_test.go:10: got 2\nFAIL\tx\t0.009s');
  const c = digest('--- FAIL: TestAdd (0.01s)\n    calc_test.go:10: got 4\nFAIL\tx\t0.004s');
  assert.ok(sameDigest(a, b));
  assert.ok(!sameDigest(a, c));
  assert.ok(!sameDigest('', ''));
});

/* ------------------------------------------------------------------ rounds */

test('checkRoundsFor: low 1, medium 2, high 3, max 4', () => {
  const rounds = (['low', 'medium', 'high', 'max'] as Effort[]).map(checkRoundsFor);
  assert.deepEqual(rounds, [1, 2, 3, 4]);
  assert.equal(checkRoundsFor('medium'), MAX_CHECK_ROUNDS);
});

const CHECKS: CheckCommand[] = [{ name: 'test', command: 'test-cmd', timeoutSeconds: 60 }];

/** An agent whose check fails `fails` times; `vary` makes each failure report a different error. */
function setup(steps: any[], fails: number, vary: boolean) {
  let runs = 0;
  const edit: Tool = { kind: 'edit', spec: fnSpec('edit_file', '', {}, []), describe: () => 'Edit', run: async () => 'Edited a.ts' };
  const run: Tool = {
    kind: 'exec', spec: fnSpec('run_command', '', {}, []), describe: (a) => `Run: ${a.command}`,
    run: async () => {
      runs++;
      const failing = runs <= fails;
      return `${failing ? `src/a.ts(${vary ? runs : 1},1): error TS2304: Cannot find name 'x'.\nDone in ${runs}.2s` : 'ok'}\n[exit ${failing ? 2 : 0}]`;
    },
  };
  const llm = fakeLlm(steps);
  const agent = new Agent({
    root: '/w', llm: llm.fn,
    getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: false }),
    tools: () => [edit, run], checks: () => CHECKS,
  });
  return { agent, llm, ui: recordingUi(true), runs: () => runs };
}
const editThenDone = (n: number) => Array.from({ length: n }, (_, i) => [call('edit_file', {}, `e${i}`), text('done')]).flat();

for (const [effort, rounds] of [['low', 1], ['high', 3], ['max', 4]] as const) {
  test(`checks: ${effort} effort allows ${rounds} fix round${rounds === 1 ? '' : 's'}`, async () => {
    const { agent, ui, runs, llm } = setup(editThenDone(rounds + 2), 99, true);
    await agent.send('fix it', { mode: 'auto', effort, model: 'm' }, ui);
    assert.equal(runs(), rounds + 1);
    assert.ok(ui.events.some((e) => new RegExp(`still failing .*after ${rounds} fix attempts`).test(e)));
    const fb = llm.calls.flat().find((m: any) => m.role === 'user' && /automatic check 1 of/.test(m.content));
    assert.match(fb.content, new RegExp(`automatic check 1 of ${rounds}\\b`));
    assert.match(fb.content, /### test: `test-cmd` \(exit 2\)/);
    assert.match(fb.content, /- src\/a\.ts:1:1 TS2304: Cannot find name 'x'\./);
  });
}

test('checks: stop early when a fix attempt leaves the very same failure (timings aside)', async () => {
  const { agent, ui, runs } = setup(editThenDone(5), 99, false);
  await agent.send('fix it', { mode: 'auto', effort: 'max', model: 'm' }, ui);
  assert.equal(runs(), 2, 'one fix round, then the identical failure ends it');
  assert.ok(ui.events.some((e) => /same errors after the last fix attempt/.test(e)));
});

test('checks: a fix that makes progress keeps the rounds going until the checks pass', async () => {
  const { agent, ui, runs } = setup(editThenDone(4), 2, true);
  await agent.send('fix it', { mode: 'auto', effort: 'high', model: 'm' }, ui);
  assert.equal(runs(), 3);
  assert.ok(ui.events.includes('info:Project checks passed: test.'));
});
