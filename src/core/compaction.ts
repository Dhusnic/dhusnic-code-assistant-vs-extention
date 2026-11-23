/**
 * Keeps a conversation inside the model's context window. First old tool output is clipped (keeping its head and
 * tail, since a command's result is usually at the end); when that is not enough, everything before the latest user
 * turn is replaced by a summary written by the model. A summary loses detail the model needs to carry on, so a
 * deterministic "Working state" block is appended to it: the files changed in this session (with approximate +/- line
 * counts taken from the edit tool calls), the current task list, the last check results and the latest user request
 * verbatim. The block is built here from inputs the agent loop supplies (workingStateFor), so it is unit-tested
 * without a model; a later compaction reads the earlier block back from the summary, so changes are not forgotten.
 * When summarizing fails, the same block is attached to the latest message instead (attachWorkingState).
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

/** Plain-text transcript for the summarizer; keeps the most recent MAX chars. */
export function transcript(messages: ChatMessage[], max = 60000): string {
  const lines: string[] = [];
  const results = new Map<string, string>();
  for (const m of messages) { if (m.role === 'tool' && m.tool_call_id) { results.set(m.tool_call_id, m.content ?? ''); } }
  for (const m of messages) {
    if (m.role === 'user') { lines.push(`USER: ${clip(m.content ?? '', 4000)}`); }
    else if (m.role === 'assistant') {
      if (m.content) { lines.push(`ASSISTANT: ${clip(m.content, 3000)}`); }
      for (const tc of m.tool_calls ?? []) {
        lines.push(`TOOL ${tc.function.name}(${clip(tc.function.arguments, 300)}) -> ${clip(results.get(tc.id) ?? '', 400)}`);
      }
    }
  }
  const text = lines.join('\n');
  return text.length > max ? `...[earlier part omitted]\n${text.slice(-max)}` : text;
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

/** The files listed in earlier Working state blocks of summary messages (changes from before those summaries). */
function earlierChanges(history: ChatMessage[]): ChangedFileState[] {
  const out: ChangedFileState[] = [];
  for (const m of history) {
    if (m.role !== 'user' || !m.content?.startsWith(SUMMARY_PREFIX)) { continue; }
    const at = m.content.lastIndexOf(WORKING_STATE_TITLE);
    if (at < 0) { continue; }
    const section = /Files changed in this session \(\d+\):\n((?:- .*\n?)*)/.exec(m.content.slice(at));
    for (const line of section?.[1].split('\n') ?? []) {
      const f = /^- (.+?)(?: \(\+(\d+) -(\d+)(, rewritten)?\))?$/.exec(line);
      if (!f || f[1] === 'none' || f[1].startsWith('…and ')) { continue; }
      out.push(f[2] !== undefined ? { path: f[1], added: Number(f[2]), removed: Number(f[3]), rewritten: !!f[4] } : { path: f[1] });
    }
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
 * still listed through `current.changed`.
 */
export function workingStateFor(
  history: ChatMessage[], turnStarts: number[], isEdit: (tool: string) => boolean,
  current: { changed: Iterable<string>; todos?: TodoInput[]; checks: Array<{ label: string; ok: boolean }> },
  forSummary = false,
): string {
  const upTo = forSummary && turnStarts.length ? turnStarts[turnStarts.length - 1] : history.length;
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
