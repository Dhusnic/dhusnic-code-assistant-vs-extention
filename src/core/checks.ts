/**
 * The project's own checks (type check, lint, tests) as the agent loop sees them: which ones to run for a set of changed
 * files, how they are described in the system prompt, and how their results are read. Detecting the commands of a
 * project lives in verify.ts; running them, with approvals and rules, stays in the agent loop (agent.ts). A failing
 * check's output is condensed by checkDigest.ts before it goes back to the model; how many fix rounds a turn gets
 * depends on the effort level, and a round that reports the very same failure as the one before ends the loop early.
 *
 * Related tests first: a test check whose runner is recognised (relatedTestsFor: jest, vitest, pytest, go test,
 * node --test) can be narrowed to the tests the changed files affect (narrowCheck). The agent uses the narrowed form
 * only to verify a fix attempt (fast feedback in fix rounds); a narrowed run that passes is never the verdict, the full
 * command always runs before the turn may finish. Narrowing is conservative: when the command is not a plain
 * invocation of a known runner, or a changed file cannot be mapped to test files, the full command runs.
 */
import * as path from 'path';
import type { Effort } from './policy';

export { digestCheckOutput, sameDigest } from './checkDigest';

/** A test runner whose run can be limited to the tests related to some changed files. */
export type TestRunner = 'jest' | 'vitest' | 'pytest' | 'go' | 'node';

/** How to narrow a test check to the changed files (see relatedTestsFor). */
export interface RelatedTests {
  runner: TestRunner;
  /** The narrowed command: {files} = changed files, {dirs} = their Go packages (./dir), {tests} = mapped test files. */
  template: string;
  /** pytest and node: globs of the project's test files, to map changed files to them by name. */
  testGlobs?: string[];
}

/** One project check: a shell command run in the workspace root. */
export interface CheckCommand {
  name: string; command: string; timeoutSeconds: number;
  /** How to run only the tests related to the changed files; missing = always the full command. */
  related?: RelatedTests;
  /** Set on a narrowed copy (narrowCheck): the full check it stands in for, and how many files it was given. */
  narrowed?: { full: CheckCommand; files: number };
}

/** Documentation, images and similar: changing only these needs no build or test run. */
export const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc|png|jpe?g|gif|svg|ico|webp|pdf)$|(^|\/)(LICENSE|CHANGELOG|AUTHORS|CODEOWNERS|NOTICE)(\.[a-z]+)?$/i;
/** Above this many files the related form is no faster than the full run. */
const MAX_RELATED_FILES = 20;

/** The checks to run for these changed files (workspace-relative, forward slashes): none when only documentation changed. */
export function scopeChecks(checks: CheckCommand[], changed: string[]): CheckCommand[] {
  const code = changed.filter((f) => !DOC_FILE.test(f));
  return changed.length && !code.length ? [] : checks;
}

/** Splits a command line into words, keeping quoted parts together (quotes removed). */
function words(s: string): string[] {
  return [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** Build steps that may come before the test runner in a script: they run unchanged before the narrowed tests. */
const BUILD_STEP = /^(?:(?:npx|bunx|pnpm exec|yarn)\s+)?tsc(?:\s[^&|;<>`$]*)?$|^(?:npm|pnpm|bun) run [\w:.-]+$|^yarn [\w:.-]+$/;
/** How a local binary is called from the command line. */
const LAUNCHER = /^(npx|bunx|pnpm exec|yarn)\s+/;
const quote = (f: string): string => `"${f}"`;

/**
 * Recognises a test command (or, for `npm run test` and the like, the package.json `script` it runs, with `exec` as
 * the way to call a local binary: npx, pnpm exec, yarn, bunx) and says how to narrow it to the changed files.
 * Undefined when it is not a plain invocation of jest, vitest, pytest, go test or node --test: chains other than
 * build steps, pipes, redirections, environment prefixes, or positional arguments (filters) of the runner's own.
 */
export function relatedTestsFor(command: string, script?: string, exec = 'npx'): RelatedTests | undefined {
  const text = (script ?? command).trim();
  if (!text || /\|\||[;|<>`]|\$\(/.test(text)) { return undefined; }
  const segments = text.split(/\s*&&\s*/);
  const last = segments.pop() ?? '';
  if (!segments.every((seg) => BUILD_STEP.test(seg))) { return undefined; }
  // A build step from a package script ran with the package's binaries on the PATH: call a bare tsc through exec.
  const prefix = segments.map((seg) => `${script !== undefined && /^tsc\b/.test(seg) ? `${exec} ${seg}` : seg} && `).join('');
  const launcher = LAUNCHER.exec(last)?.[1];
  const w = words(launcher ? last.slice(launcher.length).trim() : last);
  const via = launcher ?? (script !== undefined ? exec : 'npx');
  const flagsOnly = (xs: string[]) => xs.every((x) => x.startsWith('-'));
  if (w[0] === 'jest') {
    return flagsOnly(w.slice(1)) ? { runner: 'jest', template: `${prefix}${[via, ...w].join(' ')} --findRelatedTests {files} --passWithNoTests` } : undefined;
  }
  if (w[0] === 'vitest') {
    const rest = w[1] === 'run' ? w.slice(2) : w.slice(1);
    return flagsOnly(rest) ? { runner: 'vitest', template: `${prefix}${[via, 'vitest', 'related', '{files}', '--run', '--passWithNoTests', ...rest].join(' ')}` } : undefined;
  }
  if (launcher) { return undefined; }
  const py = /^(?:python3?|py)\s+-m\s+pytest\b|^(?:(?:uv|poetry|pipenv) run\s+)?(?:pytest|py\.test)\b/.exec(last);
  if (py) {
    return flagsOnly(words(last.slice(py[0].length))) ? { runner: 'pytest', template: `${prefix}${last} {tests}`, testGlobs: ['**/test_*.py', '**/*_test.py'] } : undefined;
  }
  if (w[0] === 'go' && w[1] === 'test') {
    const rest = w.slice(2);
    const ok = rest.filter((x) => x === './...').length === 1 && flagsOnly(rest.filter((x) => x !== './...'));
    return ok ? { runner: 'go', template: `${prefix}${last.replace('./...', '{dirs}')}` } : undefined;
  }
  if (w[0] === 'node' && w.includes('--test')) {
    const flags = w.slice(1).filter((x) => x.startsWith('-'));
    const patterns = w.slice(1).filter((x) => !x.startsWith('-'));
    // Only explicit test file patterns: without them node finds the tests itself, and a flag's value would look like one.
    if (!patterns.length || !patterns.every((x) => /\*|\.[cm]?[jt]sx?$/.test(x))) { return undefined; }
    return { runner: 'node', template: `${prefix}${['node', ...flags].join(' ')} {tests}`, testGlobs: patterns };
  }
  return undefined;
}

/** A file's name without folders, extension and test marker: a/b/foo.test.ts, out/foo.test.js and test_foo.py are "foo". */
export function testStem(file: string): string {
  const base = path.posix.basename(file.replace(/\\/g, '/')).replace(/(\.d)?\.[cm]?[jt]sx?$|\.py$|\.go$/i, '');
  return base.replace(/[._-](test|spec)$/i, '').replace(/^test[_-]/i, '');
}

/** Workspace-relative paths (no drive, no leading slash): files outside the workspace cannot be narrowed to. */
const isLocal = (f: string): boolean => !/^([a-z]:)?\//i.test(f);
/** Stems of shared code that many tests use: a change there is not covered by the tests of the same name. */
const SHARED_STEM = /^(helpers?|utils?|index|setup|fixtures?|conftest|__init__|types?)$/i;

/**
 * The test files related to the changed code files, for runners that are given test files (pytest, node): a changed
 * test file itself, and the test files with the same stem (testStem) as a changed source file. Undefined (run
 * everything) when any changed file maps to none, is not of the runner's language, or is shared code (SHARED_STEM).
 */
export function mapToTestFiles(runner: 'pytest' | 'node', code: string[], testFiles: string[]): string[] | undefined {
  const out = new Set<string>();
  const byStem = new Map<string, string[]>();
  for (const t of testFiles) { const k = testStem(t); byStem.set(k, [...(byStem.get(k) ?? []), t]); }
  for (const f of code) {
    if (runner === 'pytest' ? !f.endsWith('.py') : !/\.[cm]?[jt]sx?$/.test(f)) { return undefined; }
    if (testFiles.includes(f)) { out.add(f); continue; }
    const stem = testStem(f);
    const hits = byStem.get(stem);
    if (!hits?.length || SHARED_STEM.test(stem)) { return undefined; }
    hits.forEach((h) => out.add(h));
  }
  return out.size ? [...out] : undefined;
}

/**
 * The narrowed form of a test check for these changed files (workspace-relative, forward slashes), or undefined when
 * it has none or the mapping is uncertain: then the full command runs. `testFiles` are the project's files matching
 * the check's testGlobs (needed for pytest and node). The copy's name says it was narrowed: "test (related: 3 files)".
 */
export function narrowCheck(check: CheckCommand, changed: string[], testFiles: string[] = []): CheckCommand | undefined {
  const r = check.related;
  const code = changed.filter((f) => !DOC_FILE.test(f));
  if (!r || !code.length || code.length > MAX_RELATED_FILES || !code.every(isLocal)) { return undefined; }
  let files: string[];
  let command: string;
  if (r.runner === 'jest' || r.runner === 'vitest') {
    files = code;
    command = r.template.replace('{files}', () => code.map(quote).join(' '));
  } else if (r.runner === 'go') {
    if (!code.every((f) => f.endsWith('.go'))) { return undefined; }
    files = code;
    const dirs = [...new Set(code.map((f) => { const d = path.posix.dirname(f); return d === '.' ? '.' : `./${d}`; }))];
    command = r.template.replace('{dirs}', () => dirs.join(' '));
  } else {
    const tests = mapToTestFiles(r.runner, code, testFiles);
    if (!tests || tests.length > MAX_RELATED_FILES) { return undefined; }
    files = tests;
    command = r.template.replace('{tests}', () => tests.map(quote).join(' '));
  }
  const n = `${files.length} file${files.length === 1 ? '' : 's'}`;
  return { name: `${check.name} (related: ${n})`, command, timeoutSeconds: check.timeoutSeconds, narrowed: { full: check, files: files.length } };
}

/** How a narrowed run appears to the user: the full command it stands in for and how many files it covered. */
export function narrowedLabel(c: CheckCommand): string {
  if (!c.narrowed) { return checkLabel(c.command); }
  return `${checkLabel(c.narrowed.full.command)} (related: ${c.narrowed.files} file${c.narrowed.files === 1 ? '' : 's'})`;
}

/** How many times failing checks may send the agent back to fix them in one turn, at the default (medium) effort. */
export const MAX_CHECK_ROUNDS = 2;
/** Fix rounds per effort level: more effort, more attempts to get the checks passing. */
export function checkRoundsFor(effort: Effort): number {
  return effort === 'low' ? 1 : effort === 'high' ? 3 : effort === 'max' ? 4 : MAX_CHECK_ROUNDS;
}
/** How much of a failing check's output goes back to the model. */
export const CHECK_OUTPUT_CHARS = 8000;

/** The message that sends a failing check (its digest) back to the model. */
export function checkFailureMessage(digest: string, round: number, rounds: number): string {
  return `The project checks failed after your changes (automatic check ${round} of ${rounds}). Read the output, fix the root cause, and do not finish until the checks pass. If the failure is unrelated to your change (it was already failing before), say so instead of changing unrelated code.

${digest}`;
}

export function checksPromptSection(checks: CheckCommand[]): string {
  if (!checks.length) { return ''; }
  return `# Project checks
These commands check this project. Run the relevant ones with run_command (pass timeout_seconds) after changing code. They also run automatically when you finish a turn in which you changed files; if one fails you will get its output and must fix the cause.
${checks.map((c) => `- ${c.name}: \`${c.command}\``).join('\n')}`;
}

/** Exit code from run_command output ("[exit 0]" on the last line), or undefined when it did not finish normally. */
export function exitCodeOf(result: string): number | undefined {
  const m = /\[exit (-?\d+)\]\s*$/.exec(result);
  return m ? Number(m[1]) : undefined;
}

/** A tool result that means the command never ran (refused by a rule or the user, or blocked by a hook). */
export const NOT_RUN = /^(DENIED|BLOCKED)/;

/** How a command appears in the verification summary. */
export const checkLabel = (command: string): string => (command.length > 60 ? `${command.slice(0, 57)}...` : command);
