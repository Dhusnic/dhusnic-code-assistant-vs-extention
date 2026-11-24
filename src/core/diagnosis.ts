/**
 * Diagnose first: on a bug-fix request, code changes stay locked until the model has proven the root cause.
 *
 * Open-weight models tend to patch the first plausible spot (a symptom) and stop as soon as the checks are green. A
 * prompt rule alone does not stop that, so the loop enforces it. Three parts:
 *
 * 1. Activation (looksLikeBugReport). A turn is a bug fix when what the user typed reads as one: a fix/debug verb with a
 *    problem word ("fix the login bug", "investigate why the build fails"), or a symptom on its own (a stack trace,
 *    "X is not working", "TypeError: ..."), or /fix. Only the user's own text is classified (the display text when the
 *    message was expanded), never attached files or agent notifications. Mechanical clean-up ("fix the lint warnings",
 *    "fix typos") and requirements ("make sure it does not run twice") are not bug reports. A bug fix that ended without
 *    an accepted diagnosis, or without the fix shown to work, carries into the next MAX_CARRY_TURNS turns, so "yes, it
 *    is the second endpoint" stays gated (and counts as the user's answer); then it expires, so a stale lock never gets
 *    in the way of unrelated work. A new bug report starts a fresh lock (the previous diagnosis was for another
 *    problem, or was wrong). Setting infraonAssistant.diagnoseFirst: auto (the default) or off. Never for sub-agents.
 *
 * 2. The lock (DiagnosisState.blocks). While locked, every file-changing call (any tool of kind 'edit') is held, not run,
 *    and so is launching a sub-agent type that can write (it would be a way around the lock). Test files and repro*
 *    scripts are exempt (every path the call writes must be one), so the model can write the failing test that
 *    reproduces the bug before the fix; so are tools that only gather evidence (screenshots, downloads). The held
 *    call's result says exactly what is missing; after HOLDS_BEFORE_ASK held rounds it tells the model to ask the user,
 *    and after MAX_HOLDS the turn ends with a message to the user instead of looping.
 *
 * 3. record_diagnosis (evaluateDiagnosis). The model states the root cause, the fix it plans, file:line evidence, how it
 *    reproduced the bug and its confidence. The loop checks the claims it can check instead of trusting them: every
 *    evidence file must exist and have been read by this agent, each line must be in range; a reproduction command must
 *    really have been run (run_command) since the bug was reported, and a failing test must have failed (non-zero exit).
 *    Only confidence "high" unlocks; "medium" unlocks once the user has answered an ask_user_question in this bug fix;
 *    "low" never does. An accepted reproduction that failed becomes a project check (reproCheck): it must pass (exit 0)
 *    before the turn may end, through the same retry loop as the other checks. A script whose bug shows in its output
 *    (exit 0) cannot be judged by its exit code, so the model is asked once to run it again after its last change.
 *
 * What it cannot see: a shell command can still change files (sed -i, a generator); agent.ts adds a note to such a
 * command's result. Pure apart from reading evidence files: no editor access.
 */
import * as fs from 'fs/promises';
import { fnSpec, WorkspaceRoot } from './tool';
import type { ToolSpec } from './llm';
import type { CheckCommand } from './checks';
import { resolveIn } from './fstools';

/** The infraonAssistant.diagnoseFirst setting. */
export type DiagnoseFirstSetting = 'off' | 'auto';

/** Reads the setting's value, falling back to the default (auto) for anything unknown. */
export function parseDiagnoseFirstSetting(v: unknown): DiagnoseFirstSetting {
  return v === 'off' ? 'off' : 'auto';
}

export const DIAGNOSIS_TOOL = 'record_diagnosis';

/** Held rounds after which the hold message tells the model to ask the user instead of trying again. */
export const HOLDS_BEFORE_ASK = 2;
/** Held rounds after which the turn ends: the model keeps trying to edit without a diagnosis. */
export const MAX_HOLDS = 5;
/** Follow-up turns a bug fix stays in force without a new bug report (answering a question, "continue"). */
export const MAX_CARRY_TURNS = 2;
/** A follow-up that only says to go on: it does not answer the agent's question. */
const CONTINUE_ONLY = /^\s*(continue|go on|go ahead|keep going|proceed|ok(ay)?|yes,? continue)\W*$/i;
/** Tools of kind 'edit' that gather evidence (a screenshot, a downloaded log) rather than change the code. */
const EVIDENCE_TOOLS = new Set(['browser_screenshot', 'web_download', 'remote_download']);
/** Arguments through which an edit tool names what it writes (move_path/copy_path write `destination`). */
const WRITE_ARGS = ['path', 'destination'];
/** How long the reproduction may run as a check. */
const REPRO_TIMEOUT_SECONDS = 600;
const MAX_EVIDENCE = 8;
const MIN_ROOT_CAUSE = 30;
const MIN_TEXT = 10;

// ---------------------------------------------------------------------------------------------------------------
// Activation

const FIX_VERB = /\b(fix(es|ed|ing)?|debug(s|ged|ging)?|troubleshoot\w*|diagnos\w*|investigat\w*|resolv\w*|repair\w*|solv(e|es|ed|ing))\b/i;
/** Words that name a malfunction on their own. */
const STRONG_PROBLEM = /\b(bugs?|buggy|crash\w*|exceptions?|failures?|failing|fails?|failed|regressions?|broken|incorrect(ly)?|wrong(ly)?|leak(s|ing)?|hangs?|hanging|freez\w*|deadlock\w*|not working)\b/i;
/** Words that may only mean a tool's complaints ("fix the lint errors"). */
const WEAK_PROBLEM = /\b(errors?|issues?|problems?|defects?|faults?|glitch\w*)\b/i;
/** Mechanical clean-up: with only a weak problem word, not a bug to diagnose ("fix the eslint warnings", "fix typos"). */
const MECHANICAL = /\b(lint(er|ing)?|eslint|tslint|pylint|flake8|ruff|clippy|prettier|black|format(ting|ter)?|style|typos?|spelling|warnings?|deprecat\w*)\b/i;
const NEGATION = "(?:does ?n[o']?t|do ?n[o']?t|did ?n[o']?t|is ?n[o']?t|are ?n[o']?t|was ?n[o']?t|wo ?n[o']?t|can ?n?[o']?t|not|never)";
const NOT_WORKING = new RegExp(`\\b${NEGATION} (work|working|load|loading|start|starting|save|saving|compile|compiling|build|building|render|rendering|run|running|show|showing|open|opening|respond|responding|connect|connecting)\\b`, 'gi');
/** Before a "does not run" phrase, these make it a requirement, not a symptom ("make sure it does not run twice"). */
const INTENT_BEFORE = /\b(make sure|ensure|so that|should|must|need to|needs to|want|to make)\b[^.\n]{0,30}$/i;
const SYMPTOMS: RegExp[] = [
  /\bstack ?trace\b|\btraceback\b|\bsegfault\b|\bsegmentation fault\b|\bcore dumped\b/i,
  /\bstopped (working|responding)\b/i,
  /\b[A-Z]\w*(Error|Exception)\b\s*:/,
  /\bnull ?pointer\b|\bundefined is not\b|\bcannot read propert|\bunhandled (promise )?rejection\b|\bpanic:/i,
  /\bexpected\b[^.\n]{0,80}\bbut (got|was|received|returned)\b/i,
  /\b(returns?|returning|shows?|showing|gives?|giving) (the )?wrong\b/i,
];

/**
 * Whether what the user typed reads as a bug report. Deliberately conservative where a false positive costs a round:
 * "fix the typo" or "add error handling" are not bug reports; "fix the crash on save" and a pasted stack trace are.
 */
export function looksLikeBugReport(raw: string): boolean {
  const text = String(raw ?? '').slice(0, 4000);
  if (!text.trim() || /^\s*<agent-notification>/.test(text)) { return false; }
  if (/^\s*\/fix\b/i.test(text)) { return true; }
  if (SYMPTOMS.some((re) => re.test(text)) || reportsNotWorking(text)) { return true; }
  if (!FIX_VERB.test(text)) { return false; }
  return STRONG_PROBLEM.test(text) || (WEAK_PROBLEM.test(text) && !MECHANICAL.test(text));
}

/** "saving doesn't work" is a symptom; "make sure the job does not run twice" is a requirement. */
function reportsNotWorking(text: string): boolean {
  for (const m of text.matchAll(NOT_WORKING)) {
    if (!INTENT_BEFORE.test(text.slice(Math.max(0, m.index! - 60), m.index))) { return true; }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Exempt paths: what the model may write before the diagnosis (the reproduction)

const TEST_PATH: RegExp[] = [
  /(^|[\\/])(tests?|__tests__|specs?|testdata|test_?data|fixtures|__fixtures__|e2e)[\\/]/i,
  /\.(test|spec|e2e)\.[cm]?[jt]sx?$/i,
  /(^|[\\/])test_[^\\/]+\.py$/i, /_test\.(py|go|rb|exs?|dart|c|cc|cpp|rs)$/i, /_spec\.rb$/i,
  /(^|[\\/])[^\\/]+Tests?\.(java|kt|kts|cs|swift|php|scala|groovy|m)$/,
  /(^|[\\/])repro[^\\/]*$/i,
];

/** A test file or a repro script: editable while the lock is on, because it reproduces the bug. */
export function isReproductionPath(p: unknown): boolean {
  return typeof p === 'string' && !!p.trim() && TEST_PATH.some((re) => re.test(p.trim()));
}

// ---------------------------------------------------------------------------------------------------------------
// The tool

export const DIAGNOSIS_SPEC: ToolSpec = fnSpec(DIAGNOSIS_TOOL,
  `Record the proven root cause of the bug you are fixing. On a bug-fix request, changes to source files stay locked until a diagnosis is accepted (test files and repro scripts can be written before). The loop checks your claims:
- evidence: the exact places that show the cause, as file + line + what you found there. Every file must be one you read with read_file in this session, and the line must exist.
- reproduction: how you showed the bug happens. "failing_test": a test that fails because of this bug; you must already have run it with run_command and it must have exited non-zero. "script": a small script or command whose output shows the bug; run it first and describe the wrong output in observed. "not_possible": only when the bug cannot be reproduced here (UI-only, needs production data or hardware); explain why in reason.
- confidence: "high" only when the evidence shows the mechanism end to end and the reproduction fails for the reported reason. "medium" unlocks edits only after the user has answered an ask_user_question about what is uncertain. "low" never unlocks: keep investigating.
Copy the reproduction command exactly as you ran it. After your fix, the loop runs that command again and it must pass.`,
  {
    root_cause: { type: 'string', description: 'The mechanism of the bug: what goes wrong, where, and why. Not the symptom.' },
    fix_plan: { type: 'string', description: 'The smallest change that removes the root cause, and the files it touches.' },
    evidence: {
      type: 'array', minItems: 1, maxItems: MAX_EVIDENCE,
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File you read.' },
          line: { type: 'integer', description: '1-based line.' },
          finding: { type: 'string', description: 'What this line shows about the cause.' },
        },
        required: ['path', 'line', 'finding'],
      },
    },
    reproduction: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['failing_test', 'script', 'not_possible'] },
        command: { type: 'string', description: 'The exact run_command command that reproduces the bug (failing_test, script).' },
        observed: { type: 'string', description: 'What the reproduction showed: the failure message or the wrong output.' },
        reason: { type: 'string', description: 'not_possible only: why the bug cannot be reproduced here.' },
      },
      required: ['method'],
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  }, ['root_cause', 'fix_plan', 'evidence', 'reproduction', 'confidence']);

export type Confidence = 'high' | 'medium' | 'low';
export interface Evidence { path: string; line: number; finding: string }
export interface Reproduction { method: 'failing_test' | 'script' | 'not_possible'; command?: string; observed?: string; reason?: string }
export interface Diagnosis { rootCause: string; fixPlan: string; evidence: Evidence[]; reproduction: Reproduction; confidence: Confidence }

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Checks the shape of record_diagnosis arguments; every problem is listed at once, so one retry can fix them all. */
export function parseDiagnosis(args: any): { diagnosis?: Diagnosis; problems: string[] } {
  const problems: string[] = [];
  const a = args && typeof args === 'object' ? args : {};
  const rootCause = str(a.root_cause);
  if (rootCause.length < MIN_ROOT_CAUSE) { problems.push(`root_cause must explain the mechanism of the bug (what goes wrong, where and why), in at least ${MIN_ROOT_CAUSE} characters.`); }
  const fixPlan = str(a.fix_plan);
  if (fixPlan.length < MIN_TEXT) { problems.push('fix_plan must say what you will change and in which files.'); }
  const evidence: Evidence[] = [];
  if (!Array.isArray(a.evidence) || !a.evidence.length) {
    problems.push('evidence must list at least one file:line you read that shows the cause.');
  } else {
    a.evidence.slice(0, MAX_EVIDENCE).forEach((e: any, i: number) => {
      const p = str(e?.path), finding = str(e?.finding);
      const line = typeof e?.line === 'number' ? e.line : Number(e?.line);
      if (!p || !Number.isInteger(line) || line < 1 || !finding) {
        problems.push(`evidence[${i}] needs path, a 1-based integer line, and finding.`);
        return;
      }
      evidence.push({ path: p, line, finding });
    });
  }
  const r = a.reproduction && typeof a.reproduction === 'object' ? a.reproduction : {};
  const method = r.method;
  const reproduction: Reproduction = { method, command: str(r.command) || undefined, observed: str(r.observed) || undefined, reason: str(r.reason) || undefined };
  if (method !== 'failing_test' && method !== 'script' && method !== 'not_possible') {
    problems.push('reproduction.method must be "failing_test", "script" or "not_possible".');
  } else if (method === 'not_possible') {
    if ((reproduction.reason ?? '').length < MIN_TEXT * 2) { problems.push('reproduction.reason must explain why the bug cannot be reproduced here (at least 20 characters). Prefer a failing test or a script whenever the project can run code.'); }
  } else if (!reproduction.command) {
    problems.push(`reproduction.command is required for ${method}: the exact command you ran with run_command.`);
  }
  const confidence = a.confidence;
  if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') { problems.push('confidence must be "high", "medium" or "low".'); }
  if (problems.length) { return { problems }; }
  return { diagnosis: { rootCause, fixPlan, evidence, reproduction, confidence }, problems };
}

/** One run_command the agent ran during the bug fix. */
export interface CommandRun { command: string; exit: number | undefined }

/** Commands compare with whitespace collapsed, so a re-typed command with an extra space still matches. */
export const normalizeCommand = (c: string): string => String(c ?? '').trim().replace(/\s+/g, ' ');

/** What evaluateDiagnosis needs from the agent. */
export interface DiagnosisEnv {
  root: string; roots?: WorkspaceRoot[];
  /** Whether this agent read the file (read_file) in this session. */
  wasRead: (abs: string) => boolean;
  /** Commands run since the bug was reported, oldest first. */
  runs: CommandRun[];
  /** The user answered an ask_user_question during this bug fix. */
  userConsulted: boolean;
}

export type Verdict =
  | { status: 'rejected'; problems: string[] }
  | { status: 'locked'; diagnosis: Diagnosis; why: string }
  | { status: 'accepted'; diagnosis: Diagnosis; repro?: { command: string; failedBefore: boolean } };

async function lineCount(abs: string): Promise<number | undefined> {
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) { return undefined; }
    const text = await fs.readFile(abs, 'utf8');
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch { return undefined; }
}

/** Checks a diagnosis against what really happened in this session, and decides whether it unlocks code changes. */
export async function evaluateDiagnosis(args: any, env: DiagnosisEnv): Promise<Verdict> {
  const { diagnosis, problems } = parseDiagnosis(args);
  if (!diagnosis) { return { status: 'rejected', problems }; }
  for (const e of diagnosis.evidence) {
    let abs: string;
    try { abs = resolveIn({ root: env.root, roots: env.roots }, e.path); } catch (err: any) { problems.push(`evidence ${e.path}: ${err.message ?? err}`); continue; }
    const lines = await lineCount(abs);
    if (lines === undefined) { problems.push(`evidence ${e.path}: no such file.`); continue; }
    if (!env.wasRead(abs)) { problems.push(`evidence ${e.path}: you have not read this file in this session. Read it with read_file and confirm line ${e.line} shows what you claim.`); continue; }
    if (e.line > Math.max(lines, 1)) { problems.push(`evidence ${e.path}:${e.line}: the file has only ${lines} lines.`); }
  }
  let repro: { command: string; failedBefore: boolean } | undefined;
  const r = diagnosis.reproduction;
  if (r.method !== 'not_possible' && r.command) {
    const want = normalizeCommand(r.command);
    const runs = env.runs.filter((x) => normalizeCommand(x.command) === want);
    const last = runs[runs.length - 1];
    if (!last) {
      const recent = env.runs.slice(-3).map((x) => `\`${x.command}\``).join(', ');
      problems.push(`reproduction.command \`${r.command}\` was not run since the bug was reported. Run it with run_command first, then pass it here exactly as you ran it.${recent ? ` Recent commands: ${recent}.` : ''}`);
    } else if (last.exit === undefined) {
      problems.push(`reproduction.command \`${r.command}\` did not finish with an exit code (timed out or was stopped). Run a quicker, focused reproduction.`);
    } else if (r.method === 'failing_test' && last.exit === 0) {
      problems.push(`reproduction.command \`${r.command}\` passed (exit 0) the last time you ran it, so it does not reproduce the bug. Make the test fail for the reported reason, run it, then record again.`);
    } else if (r.method === 'script' && last.exit === 0 && !r.observed) {
      problems.push('reproduction.observed is required when the script exits 0: quote the wrong output that shows the bug.');
    } else {
      repro = { command: r.command, failedBefore: last.exit !== 0 };
    }
  }
  if (problems.length) { return { status: 'rejected', problems }; }
  if (diagnosis.confidence === 'low') {
    return { status: 'locked', diagnosis, why: 'confidence is low. Keep investigating: trace the failing path end to end and reproduce the bug, or ask the user with ask_user_question for the facts you are missing. Then record again.' };
  }
  if (diagnosis.confidence === 'medium' && !env.userConsulted) {
    return { status: 'locked', diagnosis, why: 'confidence is medium. Either close the gap yourself (more evidence, a sharper reproduction) and record again with confidence high, or call ask_user_question to confirm what is uncertain; after the user answers, a medium-confidence diagnosis unlocks.' };
  }
  return { status: 'accepted', diagnosis, repro };
}

/** The record_diagnosis tool result for a verdict. The first words are what agent.ts and the tests look for. */
export function verdictMessage(v: Verdict): string {
  if (v.status === 'rejected') {
    return `ERROR: diagnosis not accepted; source files stay locked.\n${v.problems.map((p) => `- ${p}`).join('\n')}\nFix these and call ${DIAGNOSIS_TOOL} again.`;
  }
  if (v.status === 'locked') { return `DIAGNOSIS RECORDED, source files still locked: ${v.why}`; }
  const r = v.diagnosis.reproduction;
  const after = v.repro?.failedBefore
    ? `After your change the loop runs \`${v.repro.command}\` again: it must pass (exit 0), together with the project checks, before you can finish.`
    : v.repro
      ? `After your change, run \`${v.repro.command}\` again and confirm its output is now correct.`
      : `The bug could not be reproduced here (${r.reason}); after your change, verify it as directly as you can and say plainly what remains unverified.`;
  return `DIAGNOSIS ACCEPTED. Root cause: ${v.diagnosis.rootCause}
You may now change source files. Make the smallest change that removes this root cause (${v.diagnosis.fixPlan}); do not patch the symptom elsewhere and do not weaken the reproduction to make it pass. ${after}
If the fix does not work, the diagnosis was wrong: investigate again and call ${DIAGNOSIS_TOOL} with the corrected cause.
In your final message report: the root cause (file:line), the change, and the reproduction before and after.`;
}

/** The reproduction as a project check: it failed before the fix, so it must pass before the turn ends. */
export function reproCheck(command: string): CheckCommand {
  return { name: 'reproduction', command, timeoutSeconds: REPRO_TIMEOUT_SECONDS };
}

// ---------------------------------------------------------------------------------------------------------------
// The lock

/** The tool result of a held call. Not "ERROR…": nothing went wrong, the call was only deferred. */
export function holdMessage(tool: string, holds: number, lastProblem?: string): string {
  const ask = holds > HOLDS_BEFORE_ASK
    ? `\nYou have been held ${holds} times. If you cannot prove the cause, stop trying to edit: call ask_user_question with what you found and what is unclear (steps to reproduce, expected behaviour, logs), or report your findings and stop.`
    : '';
  const last = lastProblem ? `\nYour last ${DIAGNOSIS_TOOL} call was not accepted: ${lastProblem}` : '';
  return `NOT RUN (diagnose first): ${tool} was held. This is a bug fix, and source files stay locked until you have proven the root cause.
1. Investigate: read_file the code on the failing path and the code that calls it; find where the behaviour actually goes wrong, not just where the symptom shows.
2. Reproduce: write a focused failing test (test files and repro* scripts can be written now) or a small script, run it with run_command and confirm it fails for the reported reason.
3. Call ${DIAGNOSIS_TOOL} with the root cause, file:line evidence, the reproduction command and your confidence.
4. Unsure about the expected behaviour or how to trigger the bug? Call ask_user_question.
Then make this change again.${last}${ask}`;
}

/** Added to the user's message on a turn where the lock is on, so the model plans for it from the start. */
export const DIAGNOSE_FIRST_REMINDER = `<system-reminder>This is a bug fix. Find and prove the root cause before changing source files: investigate the failing path, reproduce the bug (a failing test, or a small script), then call ${DIAGNOSIS_TOOL}. Source-file edits are held until a diagnosis is accepted; test files and repro scripts can be written before. If something essential is unclear, ask the user with ask_user_question.</system-reminder>`;

/**
 * The lock for one bug fix. Lives on the agent across turns (a fix that needs the user's answer spans two turns) and is
 * replaced by the next bug report. Commands, answers and the accepted diagnosis are recorded as they happen, not read
 * back from the history, so compaction cannot erase them.
 */
export class DiagnosisState {
  accepted?: Diagnosis;
  /** The accepted reproduction, and whether it failed before the fix (then it is a check that must pass). */
  repro?: { command: string; failedBefore: boolean };
  /** Commands run since the bug was reported. */
  readonly runs: CommandRun[] = [];
  userConsulted = false;
  /** The reproduction passed after the fix (as a check or run by the model after its last change). */
  verified = false;
  /** Held rounds in the current turn. */
  holds = 0;
  /** Why the last record_diagnosis was not accepted, for the next hold message. */
  lastProblem?: string;
  /** Turns this lock has been carried into after the one that reported the bug. */
  carried = 0;

  get unlocked(): boolean { return !!this.accepted; }

  noteRun(command: string, exit: number | undefined): void {
    this.runs.push({ command, exit });
    if (this.runs.length > 200) { this.runs.splice(0, this.runs.length - 200); }
  }

  /** Applies a verdict of record_diagnosis. A rejected or locked re-diagnosis keeps an earlier accepted one. */
  apply(v: Verdict): void {
    if (v.status === 'accepted') {
      this.accepted = v.diagnosis;
      this.repro = v.repro;
      // Nothing to re-run (not reproducible here): only the project checks can verify the fix.
      this.verified = !v.repro;
      this.lastProblem = undefined;
      return;
    }
    if (!this.accepted) { this.lastProblem = v.status === 'rejected' ? v.problems[0] : v.why.split('.')[0]; }
  }

  /**
   * Whether a call must be held. `kind`: the tool's kind; `readOnlyAgent`: for the agent tool, whether the type is
   * read-only. Every path the call writes must be a reproduction path (a move out of tests/ into src/ is a source change).
   */
  blocks(call: { name?: string; kind?: string; args: any; isAgentLaunch?: boolean; readOnlyAgent?: boolean }): boolean {
    if (this.unlocked) { return false; }
    if (call.isAgentLaunch) { return !call.readOnlyAgent; }
    if (call.kind !== 'edit' || (call.name && EVIDENCE_TOOLS.has(call.name))) { return false; }
    const paths = WRITE_ARGS.map((k) => call.args?.[k]).filter((p) => p !== undefined);
    return !paths.length || !paths.every(isReproductionPath);
  }

  /**
   * Called at the start of each later turn. The lock still matters there while there is no accepted diagnosis, or the
   * fix was not shown to work, but only for MAX_CARRY_TURNS follow-ups: after that the user has moved on, and a stale
   * lock (or a stale reproduction check) would get in the way of unrelated work. Returns false when it has expired.
   */
  carryOver(typed: string): boolean {
    if ((this.accepted && this.verified) || ++this.carried > MAX_CARRY_TURNS) { return false; }
    this.holds = 0;
    // The user answered in a message of their own: that settles a medium-confidence question as well as ask_user_question.
    if (!CONTINUE_ONLY.test(typed)) { this.userConsulted = true; }
    return true;
  }
}
