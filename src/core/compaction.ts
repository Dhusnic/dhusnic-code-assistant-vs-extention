import { ChatMessage, ToolCall } from './llm';
import { SUMMARY_PREFIX } from './sessions';

export const DEFAULT_CONTEXT = 262144;
export const DEFAULT_RATIO = 0.75;
export const SUMMARY_ACK = 'Understood. I have the summary of our earlier conversation and will continue from it.';

export const SUMMARY_SYSTEM = `You summarize a conversation between a user and a coding assistant so the work can continue seamlessly.
Include: the user's goals and constraints, key decisions, files read or changed (with paths), commands run and their outcomes, errors and how they were fixed, the current state, and any pending TODOs.
Be factual and compact (at most 600 words). Do not invent details.`;

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

/** Clips tool output in everything except the last `keepRecent` messages. Pure: returns a new array. */
export function pruneToolOutputs(messages: ChatMessage[], keepRecent = 8, maxChars = 1500): ChatMessage[] {
  const cutoff = messages.length - keepRecent;
  return messages.map((m, i) => {
    if (i >= cutoff || m.role !== 'tool' || (m.content?.length ?? 0) <= maxChars) { return m; }
    return { ...m, content: `${m.content!.slice(0, maxChars)}\n...[old tool output trimmed to save context]` };
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

export interface CompactResult { history: ChatMessage[]; turnStarts: number[]; summarized: boolean }

/**
 * Replaces everything before the latest user turn with a summary pair. The latest turn is kept verbatim so
 * tool_call/tool pairs stay intact. Earlier turn indexes are kept (pointing at the summary) so checkpoint
 * numbering and /undo keep working.
 * `carry` is a tool call (with its result) that must outlive the summary, such as the latest task list: it is
 * attached to the summary's acknowledgement so the message order stays valid.
 */
export async function compactHistory(
  history: ChatMessage[], turnStarts: number[], summarize: (transcript: string) => Promise<string>,
  carry?: { call: ToolCall; result: string },
): Promise<CompactResult> {
  const tailStart = turnStarts.length ? turnStarts[turnStarts.length - 1] : 0;
  if (tailStart <= 0 || turnStarts.length < 2) { return { history, turnStarts, summarized: false }; }
  const summary = (await summarize(transcript(history.slice(0, tailStart)))).trim();
  if (!summary) { return { history, turnStarts, summarized: false }; }
  const head: ChatMessage[] = [
    { role: 'user', content: `${SUMMARY_PREFIX}\n${summary}` },
    carry ? { role: 'assistant', content: SUMMARY_ACK, tool_calls: [carry.call] } : { role: 'assistant', content: SUMMARY_ACK },
    ...(carry ? [{ role: 'tool' as const, tool_call_id: carry.call.id, content: carry.result }] : []),
  ];
  return {
    history: [...head, ...history.slice(tailStart)],
    turnStarts: turnStarts.map((i) => (i >= tailStart ? i - tailStart + head.length : head.length)),
    summarized: true,
  };
}
