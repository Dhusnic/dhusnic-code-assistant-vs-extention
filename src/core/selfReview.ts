/**
 * Self-review before a turn ends: one extra model call that looks at what the turn changed with fresh eyes.
 *
 * When the main agent is about to finish a turn that changed files (after the project checks passed, or when there
 * are none), the user's request(s) for the turn and the turn's diff go to the model in a NEW conversation: a dedicated
 * system prompt, no tools, none of the working history (which would anchor it on its own reasoning). It answers
 * exactly "LGTM" or a short numbered list of concrete issues. Issues go back into the main conversation as a user
 * message, so the agent fixes them (and the checks run again as usual); the loop in agent.ts allows this once per turn.
 *
 * The diff is built in process against each file's state before the turn (the checkpoint backup, through
 * AgentDeps.original), so it works without git. A file with no captured original (changed by a shell command) shows
 * its current content instead. The whole input is capped at REVIEW_INPUT_CHARS: each file keeps its header and as
 * many hunk lines as its share allows, so a large change still lists every file.
 *
 * Never fatal: a failed or empty review call only produces a one-line notice and the turn finishes normally. A user
 * cancel (the turn's signal) propagates like any other cancel. Uses the same LLM gateway and model as the main
 * conversation (getConfig), so no new outbound traffic. Sub-agents and plan mode never review.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ChatMessage, StreamResult } from './llm';
import type { Effort, Mode } from './policy';
import type { AgentDeps, AgentUi, RunOptions } from './agentContracts';
import { diffText } from './diff';
import { estimateTokens } from './compaction';

/** The infraonAssistant.selfReview setting: never, at high and max effort (the default), or at every effort. */
export type SelfReviewSetting = 'off' | 'high' | 'always';

/** Upper bound on the review input (requests + diff), in characters. */
export const REVIEW_INPUT_CHARS = 24_000;
/** The share of the input the user's request(s) may take; the rest is for the diff. */
const REQUEST_CHARS = 6_000;
/** Files larger than this are not diffed line by line (the diff would be slow and mostly noise). */
const MAX_FILE_BYTES = 1_000_000;

export const REVIEW_SYSTEM = `You are a strict senior code reviewer. You get a user's request to a coding assistant and the diff of the changes the assistant made for it. Review ONLY those changes against the request.

Check:
1. Is every part of the request addressed? Name any part that is missing or only half done.
2. Bugs and unhandled edge cases in the changed code (wrong logic, off-by-one, null/undefined, error handling, broken callers).
3. Leftover debug code (console.log, print, debugger), commented-out code, placeholder or TODO code, stubs that do nothing.
4. Changes unrelated to the request.
5. Tests the request asked for or clearly implied that are missing.

Rules:
- Report only concrete, real problems you can point to in the diff. No style preferences, no praise, no summaries, no speculation about code you cannot see.
- If there is nothing to fix, reply with exactly: LGTM
- Otherwise reply with ONLY a short numbered list (at most 8 items), one issue per item, each starting with file:line, e.g. "1. src/app.ts:42 - the empty-list case returns undefined instead of []".`;

/** Whether this end of turn gets a review: the setting allows it at this effort, files changed, and it is a main agent. */
export function shouldSelfReview(setting: SelfReviewSetting | undefined, effort: Effort, mode: Mode, subagent: boolean, changedFiles: number): boolean {
  if (!setting || setting === 'off' || subagent || mode === 'plan' || changedFiles <= 0) { return false; }
  return setting === 'always' || effort === 'high' || effort === 'max';
}

/** Reads the setting's value, falling back to the default for anything unknown. */
export function parseSelfReviewSetting(v: unknown): SelfReviewSetting {
  return v === 'off' || v === 'always' ? v : 'high';
}

/** True when the reply means "nothing to fix". */
export function isLgtm(reply: string): boolean {
  const t = reply.trim().replace(/^[`*_"'\s]+|[`*_"'.!\s]+$/g, '');
  return /^lgtm$/i.test(t) || t === '';
}

/** The user's own words for the turn: its first message plus anything they queued while it ran. */
export function turnRequests(turnHistory: ChatMessage[]): string[] {
  const out: string[] = [];
  turnHistory.forEach((m, i) => {
    if (m.role !== 'user' || typeof m.content !== 'string') { return; }
    if (i === 0 || m.content.startsWith('The user sent ')) { out.push(m.content); }
  });
  return out;
}

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)}\n… (${s.length - max} more characters)`);

const isBinary = (b: Buffer): boolean => b.subarray(0, 8000).includes(0);

/** One file's section: a header and its diff lines (old/new line numbers so the reviewer can cite file:line). */
async function fileSection(abs: string, display: string, original: OriginalFile | undefined): Promise<{ header: string; lines: string[] }> {
  let now: Buffer | undefined;
  try { now = await fs.readFile(abs); } catch { now = undefined; }
  if ((now && now.length > MAX_FILE_BYTES) || (original?.data && original.data.length > MAX_FILE_BYTES)) {
    return { header: `### ${display} (large file, diff omitted)`, lines: [] };
  }
  if ((now && isBinary(now)) || (original?.data && isBinary(original.data))) {
    return { header: `### ${display} (binary file ${now ? 'changed' : 'deleted'})`, lines: [] };
  }
  if (!now) {
    return original?.existed ? { header: `### ${display} (deleted)`, lines: [] } : { header: `### ${display} (no longer exists)`, lines: [] };
  }
  const after = now.toString('utf8');
  if (!original) {
    return { header: `### ${display} (no before-state captured; current content)`, lines: after.split(/\r?\n/).map((l, i) => `${i + 1}: ${l}`) };
  }
  const before = original.existed && original.data ? original.data.toString('utf8') : '';
  // One trailing newline is not a line of its own (it would show as an empty added line in a new file).
  const d = diffText(before.replace(/\r?\n$/, ''), after.replace(/\r?\n$/, ''), 3);
  if (!d.lines.length) { return { header: `### ${display} (unchanged in the end)`, lines: [] }; }
  const header = `### ${display} (${original.existed ? 'modified' : 'new file'}, +${d.added} -${d.removed})`;
  const lines = d.lines.map((l) => (l.t === 'gap' ? `   … ${l.text}` : `${l.t === 'add' ? '+' : l.t === 'del' ? '-' : ' '}${String(l.n).padStart(5)}: ${l.text}`));
  return { header, lines };
}

export interface OriginalFile { existed: boolean; data?: Buffer }

/**
 * The turn's changes as text, at most `budget` characters. Every file gets its header; the hunk lines are shared out
 * so that small files show completely and large ones are cut, with a note saying how much was left out.
 */
export async function buildReviewDiff(root: string, files: string[], original: ((abs: string) => Promise<OriginalFile | undefined>) | undefined, budget: number): Promise<string> {
  const sections = await Promise.all([...new Set(files)].sort().map(async (abs) => {
    const rel = path.relative(root, abs);
    const display = (rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs).replace(/\\/g, '/');
    let orig: OriginalFile | undefined;
    try { orig = await original?.(abs); } catch { orig = undefined; }
    return fileSection(abs, display, orig);
  }));
  const headerChars = sections.reduce((n, s) => n + s.header.length + 1, 0);
  let left = Math.max(0, budget - headerChars);
  // Smallest first, so one huge file cannot crowd out the rest.
  const order = sections.map((s, i) => ({ i, size: s.lines.reduce((n, l) => n + l.length + 1, 0) })).sort((a, b) => a.size - b.size);
  const shown = new Map<number, string>();
  order.forEach(({ i, size }, k) => {
    const share = Math.floor(left / (order.length - k));
    const s = sections[i];
    if (size <= share) { shown.set(i, s.lines.join('\n')); left -= size; return; }
    const kept: string[] = [];
    let used = 0;
    for (const l of s.lines) { if (used + l.length + 1 > share - 60) { break; } kept.push(l); used += l.length + 1; }
    shown.set(i, `${kept.join('\n')}${kept.length ? '\n' : ''}   … (${s.lines.length - kept.length} more diff lines not shown)`);
    left -= used + 60;
  });
  return sections.map((s, i) => [s.header, shown.get(i)].filter(Boolean).join('\n')).join('\n\n');
}

/** The single user message of the review conversation. */
export function reviewPrompt(requests: string[], diff: string): string {
  const req = requests.length ? requests.map((r) => clip(r, Math.floor(REQUEST_CHARS / requests.length))).join('\n\n---\n\n') : '(not available)';
  return `## The user's request\n${req}\n\n## The changes made for it (diff against the state before the request)\n${diff}\n\nReview the changes as instructed. Reply with exactly LGTM, or a short numbered list of concrete issues with file:line.`;
}

export interface SelfReviewArgs {
  deps: AgentDeps;
  run: RunOptions;
  turn: number;
  /** The conversation from the start of this turn. */
  turnHistory: ChatMessage[];
  /** Absolute paths the turn changed. */
  files: string[];
  ui: AgentUi;
  signal: AbortSignal;
}

/**
 * Runs the review. Returns the message to add to the main conversation when it found issues; undefined when it said
 * LGTM or could not run. Rethrows only a cancel of the turn itself.
 */
export async function selfReview(a: SelfReviewArgs): Promise<ChatMessage | undefined> {
  try {
    const requests = turnRequests(a.turnHistory);
    const budget = REVIEW_INPUT_CHARS - Math.min(REQUEST_CHARS, requests.reduce((n, r) => n + r.length, 0)) - 400;
    const original = a.deps.original ? (abs: string) => a.deps.original!(a.turn, abs) : undefined;
    const diff = await buildReviewDiff(a.deps.root, a.files, original, budget);
    const sent: ChatMessage[] = [{ role: 'system', content: REVIEW_SYSTEM }, { role: 'user', content: reviewPrompt(requests, diff) }];
    const cfg = { ...(await a.deps.getConfig(a.run)), temperature: 0.1, maxTokens: 1500 };
    const res: StreamResult = await a.deps.llm(cfg, sent, [], () => {}, a.signal);
    a.ui.spent?.(Math.max(0, res.usage ? (res.usage.prompt || 0) + (res.usage.completion || 0) : estimateTokens([...sent, { role: 'assistant', content: res.content }])));
    const reply = (res.content || '').trim();
    if (isLgtm(reply)) { a.ui.info('Self-review: no issues found.'); return undefined; }
    a.ui.info('Self-review found issues; asking the agent to address them.');
    return {
      role: 'user',
      content: `An independent review of your changes for this request found these possible issues:\n\n${clip(reply, 4000)}\n\nFix the ones that are real problems. If an item is wrong or does not apply, say so briefly instead of changing code for it. Then finish.`,
      display: 'Self-review found issues',
    };
  } catch (e: any) {
    if (a.signal.aborted) { throw e; }
    a.ui.info(`Self-review skipped: ${e?.message ?? e}`);
    return undefined;
  }
}
