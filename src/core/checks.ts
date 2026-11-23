/**
 * The project's own checks (type check, lint, tests) as the agent loop sees them: which ones to run for a set of changed
 * files, how they are described in the system prompt, and how their results are read. Detecting the commands of a
 * project lives in verify.ts; running them, with approvals and rules, stays in the agent loop (agent.ts). A failing
 * check's output is condensed by checkDigest.ts before it goes back to the model; how many fix rounds a turn gets
 * depends on the effort level, and a round that reports the very same failure as the one before ends the loop early.
 */
import * as path from 'path';
import type { Effort } from './policy';

export { digestCheckOutput, sameDigest } from './checkDigest';

/** One project check: a shell command run in the workspace root. */
export interface CheckCommand {
  name: string; command: string; timeoutSeconds: number;
  /** Faster form limited to the changed files: {files} = quoted changed paths, {dirs} = their folders as ./dir. */
  related?: string;
}

/** Documentation, images and similar: changing only these needs no build or test run. */
export const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc|png|jpe?g|gif|svg|ico|webp|pdf)$|(^|\/)(LICENSE|CHANGELOG|AUTHORS|CODEOWNERS|NOTICE)(\.[a-z]+)?$/i;
/** Above this many changed files the related form is no faster than the full run. */
const MAX_RELATED_FILES = 20;

/**
 * The checks to run for these changed files (workspace-relative, forward slashes): none when only documentation
 * changed; the related (faster) form of a check when it has one and few files changed; the full command otherwise.
 */
export function scopeChecks(checks: CheckCommand[], changed: string[]): CheckCommand[] {
  const code = changed.filter((f) => !DOC_FILE.test(f));
  if (changed.length && !code.length) { return []; }
  const local = code.filter((f) => !/^([a-z]:)?\//i.test(f));
  return checks.map((c) => {
    if (!c.related || !local.length || local.length > MAX_RELATED_FILES || local.length !== code.length) { return c; }
    const files = local.map((f) => `"${f}"`).join(' ');
    const goDirs = [...new Set(local.filter((f) => f.endsWith('.go')).map((f) => { const d = path.posix.dirname(f); return d === '.' ? '.' : `./${d}`; }))];
    if (c.related.includes('{dirs}') && !goDirs.length) { return c; }
    return { ...c, command: c.related.replace('{files}', files).replace('{dirs}', goDirs.join(' ')) };
  });
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
