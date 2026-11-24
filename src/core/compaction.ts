/**
 * Keeps a conversation inside the model's context window. First old tool output is clipped (keeping its head and
 * tail, since a command's result is usually at the end); when that is not enough, everything before the latest user
 * turn is replaced by a summary written by the model. A summary loses detail the model needs to carry on, so a
 * deterministic "Working state" block is appended to it: the files changed in this session (with approximate +/- line
 * counts taken from the edit tool calls), the current task list, the last check results and the latest user request
 * verbatim. The block is built here from inputs the agent loop supplies (workingStateFor), so it is unit-tested
 * without a model; a later compaction reads the earlier block back from the summary, so changes are not forgotten.
 * When summarizing fails, the same block is attached to the latest message instead (attachWorkingState).
 * One long turn (a single request that runs many tool rounds) cannot be helped by summarizing earlier turns, so its own
 * earlier steps are summarized too (compactLatestTurn): the request and the latest steps stay verbatim, and the summary
 * with its Working state block goes into the request as a reminder. Every Working state block is cumulative, so a later
 * compaction reads back only the latest one.
 * Re-summarizing must not wear the earlier summary away: the summarizer gets it whole, ahead of the (clipped, tail-kept)
 * transcript, and is told to carry it forward. A summary cut off by the token cap is not accepted (see Agent.compact).
 */
import { ChatMessage, ToolCall } from './llm';
import { SUMMARY_PREFIX } from './sessions';
import type { TodoInput } from './todos';

export const DEFAULT_CONTEXT = 262144;
export const DEFAULT_RATIO = 0.75;
export const SUMMARY_ACK = 'Understood. I have the summary of our earlier conversation and will continue from it.';

export const SUMMARY_SYSTEM = `You summarize a conversation between a user and a coding assistant so the work can continue seamlessly.
Include: the user's goals and constraints, key decisions, files read or changed (with paths), commands run and their outcomes, errors and how they were fixed, the current state, and any pending TODOs.
Copy verbatim, never paraphrase: exact identifiers (function, class, variable and setting names), file paths, commands, error messages, and every constraint or preference the user stated.
When an earlier summary is given, carry its goals, constraints and decisions forward unless the later conversation replaced them; never drop them.
Be factual and compact (at most 900 words). Do not invent details.`;

/** Rough token estimate (≈3.5 chars/token) — deliberately conservative for code. */
export function estimateTokens(messages: ChatMessage[], extraChars = 0): number {
  let chars = extraChars;
  for (const m of messages) {
    chars += (m.content?.length ?? 0) + 16;
    for (const tc of m.tool_calls ?? []) { chars += tc.function.name.length + tc.function.arguments.length + 16; }
  }
  return Math.ceil(chars / 3.5);
}

export const shouldCompact = (tokens: number, limit: number, ratio = DEFAULT_RATIO): boolean => tokens > limit * ratio;

const TRIM_MARK = 'chars of old tool output trimmed to save context]';

/**
 * Clips tool output in everything except the last `keepRecent` messages, keeping the head (two thirds of `maxChars`)
 * and the tail (the rest), where a command's result and summary usually are. Pure: returns a new array.
 */
export function pruneToolOutputs(messages: ChatMessage[], keepRecent = 8, maxChars = 1500): ChatMessage[] {
  const cutoff = messages.length - keepRecent;
  const headChars = Math.ceil((maxChars * 2) / 3);
  const tailChars = maxChars - headChars;
  return messages.map((m, i) => {
    const c = m.content ?? '';
    if (i >= cutoff || m.role !== 'tool' || c.length <= maxChars) { return m; }
    // Already clipped to this size by an earlier pass: clipping again would only shorten the head.
    if (c.includes(TRIM_MARK) && c.length <= maxChars + 80) { return m; }
    const omitted = c.length - headChars - tailChars;
    return { ...m, content: `${c.slice(0, headChars)}\n...[${omitted} ${TRIM_MARK}\n${tailChars ? c.slice(-tailChars) : ''}` };
  });
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The narrative of a summary, without its Working state block (that is rebuilt by code, not by the summarizer). */
const withoutState = (s: string): string => {
  const at = s.indexOf(WORKING_STATE_TITLE);
  return (at < 0 ? s : s.slice(0, at)).trim();
};

/**
 * Plain-text transcript for the summarizer; keeps the most recent MAX chars. An earlier summary goes first and whole,
 * outside that budget: it holds the session's goals and constraints, and clipping it (or dropping it as the oldest
 * part) would lose a little more of them at every compaction. A request's summary of its own turn's earlier steps
 * is kept whole for the same reason.
 */
export function transcript(messages: ChatMessage[], max = 60000): string {
  const lines: string[] = [];
  const earlier: string[] = [];
  const results = new Map<string, string>();
  for (const m of messages) { if (m.role === 'tool' && m.tool_call_id) { results.set(m.tool_call_id, m.content ?? ''); } }
  for (const m of messages) {
    if (m.role === 'user') {
      const c = m.content ?? '';
      if (c.startsWith(SUMMARY_PREFIX)) { earlier.push(withoutState(c.slice(SUMMARY_PREFIX.length))); continue; }
      const { base, earlier: steps } = splitTurnSummary(c);
      lines.push(`USER: ${clip(base, 4000)}`);
      if (steps) { lines.push(`EARLIER STEPS OF THIS REQUEST (summarized): ${steps}`); }
    } else if (m.role === 'assistant') {
      if (m.content && m.content !== SUMMARY_ACK) { lines.push(`ASSISTANT: ${clip(m.content, 3000)}`); }
      for (const tc of m.tool_calls ?? []) {
        lines.push(`TOOL ${tc.function.name}(${clip(tc.function.arguments, 300)}) -> ${clip(results.get(tc.id) ?? '', 400)}`);
      }
    }
  }
  let text = lines.join('\n');
  if (text.length > max) { text = `...[earlier part omitted]\n${text.slice(-max)}`; }
  return earlier.length ? `${EARLIER_SUMMARY_HEADING}\n${earlier.join('\n\n')}\n\n${LATER_HEADING}\n${text}` : text;
}

export const EARLIER_SUMMARY_HEADING = 'EARLIER SUMMARY (carry forward everything that still matters):';
const LATER_HEADING = 'CONVERSATION SINCE THAT SUMMARY:';

/**
 * Cleans the summarizer's answer: drops thinking blocks (a reasoning model may put them in the content), and an
 * unclosed one means the answer is all thinking, so nothing usable.
 */
export function cleanSummary(raw: string): string {
  const out = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  return /<think>/i.test(out) ? '' : out.trim();
}

/* ------------------------------------------------------------------ working state */

export const WORKING_STATE_TITLE = '## Working state (recorded by the assistant runtime; exact)';
/** One changed file; counts are approximate (from the edit tool calls) and absent for changes made by commands. */
export interface ChangedFileState { path: string; added?: number; removed?: number; rewritten?: boolean }
export interface WorkingStateInput {
  changed: ChangedFileState[];
  todos?: TodoInput[];
  /** Checks that ran after the last change, in order. */
  checks: Array<{ label: string; ok: boolean }>;
  request?: string;
}

const MAX_STATE_FILES = 60;
const REQUEST_CHARS = 1500;
const lineCount = (s: unknown): number => (typeof s === 'string' && s.length ? s.replace(/\r?\n$/, '').split('\n').length : 0);
const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** The block appended after a summary: deterministic, so the model can rely on it. */
export function workingState(input: WorkingStateInput): string {
  const out = [WORKING_STATE_TITLE];
  const files = input.changed.slice(0, MAX_STATE_FILES).map((f) => {
    const counts = f.added !== undefined || f.removed !== undefined ? ` (+${f.added ?? 0} -${f.removed ?? 0}${f.rewritten ? ', rewritten' : ''})` : '';
    return `- ${f.path}${counts}`;
  });
  const more = input.changed.length > MAX_STATE_FILES ? [`- …and ${input.changed.length - MAX_STATE_FILES} more`] : [];
  out.push(`Files changed in this session (${input.changed.length}):`, ...(files.length ? [...files, ...more] : ['- none']));
  if (input.todos?.length) {
    const mark = { completed: '[x]', in_progress: '[>]', pending: '[ ]' } as const;
    out.push('Task list:', ...input.todos.map((t) => `- ${mark[t.status]} ${t.content}`));
  }
  out.push(input.checks.length
    ? `Checks after the last change: ${input.checks.map((c) => `${c.ok ? 'pass' : 'FAIL'} ${c.label}`).join('; ')}`
    : 'Checks after the last change: none ran yet.');
  if (input.request?.trim()) { out.push('Latest user request (verbatim):', clip(input.request.trim(), REQUEST_CHARS)); }
  return out.join('\n');
}

export const TURN_SUMMARY_TITLE = '## Earlier steps of this turn (summarized by the assistant runtime)';
const TURN_OPEN = `\n\n<system-reminder>\n${TURN_SUMMARY_TITLE}\n`;

/** A summary message, or a request carrying a summary of its own turn's earlier steps. */
const holdsSummary = (m: ChatMessage): boolean =>
  m.role === 'user' && !!m.content && (m.content.startsWith(SUMMARY_PREFIX) || m.content.includes(TURN_OPEN));

/**
 * The files listed in the latest Working state block of a summary (changes from before it). Each block already
 * includes the ones before it, so only the latest is read: reading them all would count lines twice.
 */
function earlierChanges(history: ChatMessage[]): ChangedFileState[] {
  const m = [...history].reverse().find(holdsSummary);
  const at = m?.content?.lastIndexOf(WORKING_STATE_TITLE) ?? -1;
  if (!m?.content || at < 0) { return []; }
  const out: ChangedFileState[] = [];
  const section = /Files changed in this session \(\d+\):\n((?:- .*\n?)*)/.exec(m.content.slice(at));
  for (const line of section?.[1].split('\n') ?? []) {
    const f = /^- (.+?)(?: \(\+(\d+) -(\d+)(, rewritten)?\))?$/.exec(line);
    if (!f || f[1] === 'none' || f[1].startsWith('…and ')) { continue; }
    out.push(f[2] !== undefined ? { path: f[1], added: Number(f[2]), removed: Number(f[3]), rewritten: !!f[4] } : { path: f[1] });
  }
  return out;
}

/**
 * Files changed according to the conversation: earlier Working state blocks, then every successful call of an edit
 * tool (`isEdit`) with a path, with approximate line counts for write_file, edit_file and multi_edit, then `extra`
 * (paths changed by commands or sub-agents, without counts). Merged by path, in first-seen order.
 */
export function changedFilesFrom(history: ChatMessage[], isEdit: (tool: string) => boolean, extra: string[] = []): ChangedFileState[] {
  const files = new Map<string, ChangedFileState>();
  const add = (f: ChangedFileState) => {
    const key = normPath(f.path);
    const cur = files.get(key) ?? { path: key };
    if (f.added !== undefined || f.removed !== undefined) {
      cur.added = (cur.added ?? 0) + (f.added ?? 0);
      cur.removed = (cur.removed ?? 0) + (f.removed ?? 0);
    }
    if (f.rewritten) { cur.rewritten = true; }
    files.set(key, cur);
  };
  earlierChanges(history).forEach(add);
  const results = new Map<string, string>();
  for (const m of history) { if (m.role === 'tool' && m.tool_call_id) { results.set(m.tool_call_id, m.content ?? ''); } }
  for (const m of history) {
    for (const tc of m.role === 'assistant' ? m.tool_calls ?? [] : []) {
      const name = tc.function.name;
      if (!isEdit(name) || /^(ERROR|DENIED|BLOCKED)/.test(results.get(tc.id) ?? 'ERROR')) { continue; }
      let a: any;
      try { a = JSON.parse(tc.function.arguments || '{}'); } catch { continue; }
      if (typeof a?.path !== 'string' || !a.path) { continue; }
      if (name === 'write_file') { add({ path: a.path, added: lineCount(a.content), removed: 0, rewritten: true }); }
      else if (name === 'edit_file') { add({ path: a.path, added: lineCount(a.new_string), removed: lineCount(a.old_string) }); }
      else if (name === 'multi_edit' && Array.isArray(a.edits)) {
        add({ path: a.path, added: a.edits.reduce((n: number, e: any) => n + lineCount(e?.new_string), 0), removed: a.edits.reduce((n: number, e: any) => n + lineCount(e?.old_string), 0) });
      } else { add({ path: a.path }); }
    }
  }
  for (const p of extra) { add({ path: p }); }
  return [...files.values()];
}

/** The latest user request: the message that opened the latest turn, as the user typed it. */
export function latestRequest(history: ChatMessage[], turnStarts: number[]): string | undefined {
  const m = turnStarts.length ? history[turnStarts[turnStarts.length - 1]] : undefined;
  if (m?.role !== 'user' || m.content?.startsWith(SUMMARY_PREFIX)) { return undefined; }
  return m.display ?? m.content ?? undefined;
}

/**
 * Everything the Working state block needs, from the agent's history and what it tracks for the current turn.
 * For a summary (`forSummary`), line counts come only from the part being summarized: the latest turn stays in the
 * history verbatim and is counted by the next compaction, so counting it now would count it twice. Its files are
 * still listed through `current.changed`. A number instead of `true` counts up to that index (a summary of steps
 * inside the latest turn).
 */
export function workingStateFor(
  history: ChatMessage[], turnStarts: number[], isEdit: (tool: string) => boolean,
  current: { changed: Iterable<string>; todos?: TodoInput[]; checks: Array<{ label: string; ok: boolean }> },
  forSummary: boolean | number = false,
): string {
  const upTo = typeof forSummary === 'number' ? forSummary
    : forSummary && turnStarts.length ? turnStarts[turnStarts.length - 1] : history.length;
  return workingState({
    changed: changedFilesFrom(history.slice(0, upTo), isEdit, [...current.changed]),
    todos: current.todos,
    checks: current.checks,
    request: latestRequest(history, turnStarts),
  });
}

const STATE_OPEN = '\n\n<system-reminder>\n## Working state ';
const STATE_REMINDER = /\n\n<system-reminder>\n## Working state [\s\S]*?\n<\/system-reminder>/g;

/**
 * Without a summary (it failed), the Working state block goes into the latest user or tool message as a reminder,
 * replacing an earlier one. Pure: returns a new array; unchanged when the last message is the model's own.
 */
export function attachWorkingState(history: ChatMessage[], state: string): ChatMessage[] {
  const out = history.map((m) => (m.content?.includes(STATE_OPEN) ? { ...m, content: m.content.replace(STATE_REMINDER, '') } : m));
  const last = out[out.length - 1];
  if (!last || (last.role !== 'user' && last.role !== 'tool')) { return out; }
  out[out.length - 1] = { ...last, content: `${last.content ?? ''}\n\n<system-reminder>\n${state}\n</system-reminder>` };
  return out;
}

export interface CompactResult { history: ChatMessage[]; turnStarts: number[]; summarized: boolean }

/**
 * Replaces everything before the latest user turn with a summary pair. The latest turn is kept verbatim so
 * tool_call/tool pairs stay intact. Earlier turn indexes are kept (pointing at the summary) so checkpoint
 * numbering and /undo keep working.
 * `carry` is a tool call (with its result) that must outlive the summary, such as the latest task list: it is
 * attached to the summary's acknowledgement so the message order stays valid.
 * `state` (a Working state block) is appended to the summary.
 */
export async function compactHistory(
  history: ChatMessage[], turnStarts: number[], summarize: (transcript: string) => Promise<string>,
  carry?: { call: ToolCall; result: string }, state?: string,
): Promise<CompactResult> {
  const tailStart = turnStarts.length ? turnStarts[turnStarts.length - 1] : 0;
  if (tailStart <= 0 || turnStarts.length < 2) { return { history, turnStarts, summarized: false }; }
  const summary = (await summarize(transcript(history.slice(0, tailStart)))).trim();
  if (!summary) { return { history, turnStarts, summarized: false }; }
  const head: ChatMessage[] = [
    { role: 'user', content: `${SUMMARY_PREFIX}\n${summary}${state ? `\n\n${state}` : ''}` },
    carry ? { role: 'assistant', content: SUMMARY_ACK, tool_calls: [carry.call] } : { role: 'assistant', content: SUMMARY_ACK },
    ...(carry ? [{ role: 'tool' as const, tool_call_id: carry.call.id, content: carry.result }] : []),
  ];
  return {
    history: [...head, ...history.slice(tailStart)],
    turnStarts: turnStarts.map((i) => (i >= tailStart ? i - tailStart + head.length : head.length)),
    summarized: true,
  };
}

/** Splits a request into what the user sent and the summary of its turn's earlier steps (if one was added). */
function splitTurnSummary(content: string): { base: string; earlier?: string } {
  const at = content.indexOf(TURN_OPEN);
  if (at < 0) { return { base: content }; }
  const rest = content.slice(at + TURN_OPEN.length);
  const end = [rest.indexOf(`\n\n${WORKING_STATE_TITLE}`), rest.indexOf('\n</system-reminder>')].filter((i) => i >= 0);
  return { base: content.slice(0, at), earlier: rest.slice(0, end.length ? Math.min(...end) : undefined).trim() };
}

/**
 * Summarizes the earlier steps of the latest turn, for a turn too long on its own. The request and the last
 * `keepRecent` messages stay verbatim; the cut is moved back to the start of a model step (an assistant message) so
 * every tool result kept still follows its call. The summary (folding in an earlier one) and the Working state block,
 * built by `state` with the cut index, go into the request as a reminder; its `display` keeps what the user typed.
 * `carry` (the latest task list) follows the request, since its original call may be among the summarized steps.
 * Turn indexes do not change.
 */
export async function compactLatestTurn(
  history: ChatMessage[], turnStarts: number[], summarize: (transcript: string) => Promise<string>, keepRecent = 6,
  carry?: { call: ToolCall; result: string }, state?: (cut: number) => string,
): Promise<CompactResult> {
  const unchanged = { history, turnStarts, summarized: false };
  const start = turnStarts.length ? turnStarts[turnStarts.length - 1] : 0;
  const req = history[start];
  if (req?.role !== 'user' || req.content?.startsWith(SUMMARY_PREFIX)) { return unchanged; }
  let cut = history.length - keepRecent;
  while (cut > start + 1 && history[cut]?.role !== 'assistant') { cut--; }
  if (cut < start + 2) { return unchanged; }
  const { base, earlier } = splitTurnSummary(req.content ?? '');
  const steps = transcript(history.slice(start + 1, cut));
  const summary = (await summarize(`USER REQUEST: ${clip(base, 4000)}\n${earlier ? `EARLIER STEPS (already summarized):\n${earlier}\nLATER STEPS:\n` : ''}${steps}`)).trim();
  if (!summary) { return unchanged; }
  const block = `${TURN_OPEN}${summary}${state ? `\n\n${state(cut)}` : ''}\n</system-reminder>`;
  const head: ChatMessage[] = [
    { ...req, content: `${base}${block}`, display: req.display ?? base },
    ...(carry ? [{ role: 'assistant' as const, content: null, tool_calls: [carry.call] }, { role: 'tool' as const, tool_call_id: carry.call.id, content: carry.result }] : []),
  ];
  return { history: [...history.slice(0, start), ...head, ...history.slice(cut)], turnStarts, summarized: true };
}
