/**
 * Loop detection for one user turn. Open-weight models often get stuck repeating themselves (the same read, the same
 * failing edit, the same failing command) until the iteration budget is gone. The agent loop feeds every tool call
 * and its result to a LoopGuard; when a pattern repeats, the guard returns a short <system-reminder> that the loop
 * appends to that tool result, so the model sees it on its next call, plus a line for the user (ui.info).
 *
 * Patterns, each keyed so it nudges at most twice (a first nudge, then one stronger escalation if it persists):
 *   repeat   the same tool with the same (canonicalised JSON) arguments run REPEAT_LIMIT times. A successful change
 *            (an edit-kind tool) clears these counts: re-reading or re-running after a change is normal work.
 *   edit     edit_file / multi_edit failing EDIT_FAIL_LIMIT times on the same path.
 *   command  run_command failing twice with the same output, or COMMAND_FAIL_LIMIT times in all.
 *   rounds   FAIL_ROUND_LIMIT tool rounds in a row in which every call failed (reported by endRound()).
 * A call is reported under one pattern at most (edit and command failures are not also counted as repeats).
 * Pure: no I/O, no editor access. A new guard is created per turn, which is the per-turn reset.
 */
import { exitCodeOf } from './checks';

/** Identical calls (same tool, same arguments) before the first nudge. */
export const REPEAT_LIMIT = 3;
/** Failed edits on one file before the first nudge. */
export const EDIT_FAIL_LIMIT = 2;
/** Failures of one command (any output) before the first nudge; identical output nudges after 2. */
export const COMMAND_FAIL_LIMIT = 3;
/** Consecutive rounds in which every call failed before the first nudge. */
export const FAIL_ROUND_LIMIT = 4;
/** Further occurrences after a nudge before the one stronger escalation. */
export const ESCALATE_AFTER = 2;

const EDIT_TOOLS = new Set(['edit_file', 'multi_edit']);

/** JSON with object keys sorted at every level, so key order does not hide a repeat. Unparseable input is kept as-is. */
export function canonicalArgs(raw: string): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) { return v.map(sort); }
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  try { return JSON.stringify(sort(JSON.parse(raw || '{}'))); } catch { return String(raw ?? '').trim(); }
}

/** Whether a tool result means the call failed: an error, a refusal, or a command with a non-zero exit code. */
export function isFailure(name: string, result: string): boolean {
  if (/^(ERROR|DENIED|BLOCKED)/.test(result)) { return true; }
  if (name === 'run_command') { const code = exitCodeOf(result); return code !== undefined && code !== 0; }
  return false;
}

/** Command output with timings and durations blurred, so two runs of the same failure compare equal. */
function outputSignature(result: string): string {
  return result.replace(/\d+(\.\d+)?\s?(ms|s|sec|seconds|m)\b/gi, '#').replace(/\s+/g, ' ').trim();
}

const normPath = (p: unknown): string => String(p ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');

/** A nudge: `reminder` goes to the model (appended to a tool result), `info` to the user. */
export interface LoopNudge { key: string; level: 1 | 2; reminder: string; info: string }

interface Counter { count: number; fired: 0 | 1 | 2; at: number; outputs?: Map<string, number> }

export class LoopGuard {
  private repeats = new Map<string, Counter>();
  private edits = new Map<string, Counter>();
  private commands = new Map<string, Counter>();
  private failRounds: Counter = { count: 0, fired: 0, at: 0 };
  private roundCalls = 0;
  private roundFailures = 0;

  /**
   * Records one finished tool call. `kind` is the tool's kind when known ('edit' successes clear the repeat counts).
   * Returns a nudge when this call completes a loop pattern, else undefined.
   */
  observe(name: string, rawArgs: string, result: string, kind?: string): LoopNudge | undefined {
    const failed = isFailure(name, result);
    this.roundCalls++;
    if (failed) { this.roundFailures++; }
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(rawArgs || '{}') ?? {}; } catch { /* keep {} */ }

    if (EDIT_TOOLS.has(name) && failed) {
      const file = normPath(args.path);
      return this.bump(this.edits, file, EDIT_FAIL_LIMIT, 'edit', (level) => editMessage(name, file, level));
    }
    if (!failed && kind === 'edit') {
      // The file changed: earlier reads are stale and a later edit failure starts a new count.
      this.repeats.clear();
      const c = this.edits.get(normPath(args.path));
      if (c) { c.count = 0; c.at = 0; }
    }

    if (name === 'run_command' && failed) {
      const command = String(args.command ?? '').trim();
      const c = this.counter(this.commands, command);
      const sig = outputSignature(result);
      c.outputs = c.outputs ?? new Map();
      const same = (c.outputs.get(sig) ?? 0) + 1;
      c.outputs.set(sig, same);
      c.count++;
      // The same failure twice reaches the first nudge early: the limit counts as met.
      if (c.fired === 0 && same >= 2) { c.count = Math.max(c.count, COMMAND_FAIL_LIMIT); }
      return this.fire(c, 'command', COMMAND_FAIL_LIMIT, (level) => commandMessage(command, level));
    }

    const key = `${name}\u0000${canonicalArgs(rawArgs)}`;
    return this.bump(this.repeats, key, REPEAT_LIMIT, 'repeat', (level) => repeatMessage(name, level));
  }

  /**
   * Ends a tool round (one model response's calls). Returns a nudge when FAIL_ROUND_LIMIT rounds in a row had only
   * failing calls.
   */
  endRound(): LoopNudge | undefined {
    const allFailed = this.roundCalls > 0 && this.roundFailures === this.roundCalls;
    this.roundCalls = 0;
    this.roundFailures = 0;
    if (!allFailed) { this.failRounds.count = 0; return undefined; }
    this.failRounds.count++;
    return this.fire(this.failRounds, 'rounds', FAIL_ROUND_LIMIT, (level) => roundsMessage(this.failRounds.count, level));
  }

  private counter(map: Map<string, Counter>, key: string): Counter {
    let c = map.get(key);
    if (!c) { c = { count: 0, fired: 0, at: 0 }; map.set(key, c); }
    return c;
  }

  private bump(map: Map<string, Counter>, key: string, limit: number, kind: string, msg: (level: 1 | 2) => [string, string]): LoopNudge | undefined {
    const c = this.counter(map, key);
    c.count++;
    return this.fire(c, `${kind}:${key}`, limit, msg);
  }

  /** First nudge at `limit`; the escalation ESCALATE_AFTER occurrences after the first; nothing after that. */
  private fire(c: Counter, key: string, limit: number, msg: (level: 1 | 2) => [string, string]): LoopNudge | undefined {
    let level: 1 | 2 | undefined;
    if (c.fired === 0 && c.count >= limit) { level = 1; } else if (c.fired === 1 && c.count >= c.at + ESCALATE_AFTER) { level = 2; }
    if (!level) { return undefined; }
    c.fired = level;
    c.at = c.count;
    const [reminder, info] = msg(level);
    return { key, level, reminder: `<system-reminder>${reminder}</system-reminder>`, info };
  }
}

/** The tool result with the nudge appended, telling the user through `info`; the result unchanged when there is none. */
export function withNudge(result: string, nudge: LoopNudge | undefined, info: (text: string) => void): string {
  if (!nudge) { return result; }
  info(nudge.info);
  return `${result}\n\n${nudge.reminder}`;
}

const STRONGER = 'You are still repeating it after a reminder. STOP this approach now. ';
const QUIET = ' Do not mention this reminder to the user.';

function repeatMessage(name: string, level: 1 | 2): [string, string] {
  return level === 1
    ? [`You have now called ${name} with exactly the same arguments ${REPEAT_LIMIT} times this turn and got the same kind of result. Repeating it will not give you new information. Use what you already have, or try a different tool, different arguments or a different approach.${QUIET}`,
      `The agent repeated the same ${name} call ${REPEAT_LIMIT} times; reminded it to change approach.`]
    : [`${STRONGER}Do not call ${name} with these arguments again. Either make progress with a different action, or end your turn and explain to the user what is blocking you.${QUIET}`,
      `The agent is still repeating the same ${name} call; told it to stop or explain what is blocking it.`];
}

function editMessage(name: string, file: string, level: 1 | 2): [string, string] {
  const target = file || 'this file';
  return level === 1
    ? [`${name} has failed ${EDIT_FAIL_LIMIT} times on ${target}. Before trying again: read_file ${target} to see its current contents, then copy old_string exactly from that output (without the line-number prefixes, same indentation and whitespace), with enough surrounding lines to match one place. If you are changing most of the file, use write_file to rewrite it instead.${QUIET}`,
      `Edits to ${target} failed ${EDIT_FAIL_LIMIT} times; told the agent to re-read the file or rewrite it.`]
    : [`${STRONGER}Edits to ${target} keep failing. Read the file again with read_file and use write_file to write the complete new content, or make one small edit with a short, unique old_string copied from the read.${QUIET}`,
      `Edits to ${target} are still failing; told the agent to rewrite the file with write_file.`];
}

function commandMessage(command: string, level: 1 | 2): [string, string] {
  const shown = command.length > 80 ? `${command.slice(0, 77)}...` : command;
  return level === 1
    ? [`The command \`${shown}\` keeps failing (the same way each time). Running it again unchanged will not help. Read the error output carefully, find the cause (a missing dependency, a wrong path or working directory, a syntax error, a tool not installed), and fix that, or try a different command.${QUIET}`,
      `The command \`${shown}\` keeps failing; told the agent to read the error and change approach.`]
    : [`${STRONGER}Do not run \`${shown}\` again until you have changed something that addresses its error. If you cannot fix it, end your turn and tell the user the exact error and what you tried.${QUIET}`,
      `The command \`${shown}\` is still failing; told the agent to stop retrying it.`];
}

function roundsMessage(rounds: number, level: 1 | 2): [string, string] {
  return level === 1
    ? [`Every tool call in your last ${rounds} rounds failed. Stop and reconsider: re-read the error messages, check paths and argument names against the tool descriptions, and try a simpler or different approach.${QUIET}`,
      `Every tool call failed for ${rounds} rounds in a row; told the agent to reconsider its approach.`]
    : [`${STRONGER}Your tool calls are still all failing. If you cannot find a working approach, end your turn and explain to the user what is failing and why.${QUIET}`,
      `The agent's tool calls are still all failing; told it to stop and explain.`];
}
