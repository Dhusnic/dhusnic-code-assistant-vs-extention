import { relativizePaths } from './agent';
import { transcript } from './compaction';
import { ChatMessage, LlmConfig, LlmFn } from './llm';
import { SUMMARY_PREFIX } from './sessions';
import { TodoItem } from './todos';

/**
 * Session handoff: a copy-pasteable summary that lets a new session continue the work. Facts (files changed,
 * commands, agents, tasks) are computed exactly from the history; the narrative comes from the LLM.
 */
export interface AgentSnapshot {
  id: string; role: 'main' | 'sub'; name: string; type?: string; description?: string;
  outcome?: string; result?: string; history: ChatMessage[]; todos?: TodoItem[];
}
export interface SessionFacts {
  title: string;
  files: Array<{ path: string; edits: number; writes: number }>;
  commands: Array<{ command: string; ok: boolean }>;
  agents: Array<{ type: string; description: string; outcome: string }>;
  todos: TodoItem[];
  requests: string[];
  turns: number;
  toolCalls: number;
}

const NOTE_PREFIX = '<agent-notification>';
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function collectFacts(title: string, agents: AgentSnapshot[], root = ''): SessionFacts {
  const files = new Map<string, { path: string; edits: number; writes: number }>();
  const commands: Array<{ command: string; ok: boolean }> = [];
  let toolCalls = 0;
  for (const a of agents) {
    const results = new Map<string, string>();
    for (const m of a.history) { if (m.role === 'tool' && m.tool_call_id) { results.set(m.tool_call_id, String(m.content ?? '')); } }
    for (const m of a.history) {
      for (const tc of m.role === 'assistant' ? m.tool_calls ?? [] : []) {
        toolCalls++;
        let args: any = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { continue; }
        const res = results.get(tc.id) ?? '';
        const name = tc.function.name;
        if ((name === 'write_file' && res.startsWith('Wrote')) || (name === 'edit_file' && res.startsWith('Edited'))) {
          const p = relativizePaths(String(args.path ?? ''), root).replace(/\\/g, '/');
          const f = files.get(p) ?? { path: p, edits: 0, writes: 0 };
          if (name === 'edit_file') { f.edits++; } else { f.writes++; }
          files.set(p, f);
        } else if (name === 'run_command' && args.command && !res.startsWith('DENIED')) {
          commands.push({ command: clip(String(args.command), 160), ok: /\[exit 0\]\s*$/.test(res) });
        }
      }
    }
  }
  const main = agents.find((a) => a.role === 'main') ?? agents[0];
  const requests = (main?.history ?? [])
    .filter((m) => m.role === 'user')
    .map((m) => String(m.display ?? m.content ?? ''))
    .filter((t) => t && !t.startsWith(NOTE_PREFIX) && !t.startsWith('🔔') && !t.startsWith(SUMMARY_PREFIX))
    .map((t) => clip(t.replace(/\s+/g, ' ').trim(), 300));
  return {
    title,
    files: [...files.values()].sort((x, y) => x.path.localeCompare(y.path)),
    commands: dedupeCommands(commands),
    agents: agents.filter((a) => a.role === 'sub').map((a) => ({ type: a.type ?? 'agent', description: a.description ?? a.name, outcome: a.outcome ?? 'unknown' })),
    todos: main?.todos ?? [],
    requests,
    turns: requests.length,
    toolCalls,
  };
}

function dedupeCommands(list: Array<{ command: string; ok: boolean }>): Array<{ command: string; ok: boolean }> {
  const last = new Map<string, boolean>();
  for (const c of list) { last.set(c.command, c.ok); }
  return [...last.entries()].map(([command, ok]) => ({ command, ok })).slice(-25);
}

export const HANDOFF_SYSTEM = `You write a handoff summary of a coding session so that a NEW session (another engineer or AI assistant with no memory of this one) can continue the work seamlessly.
Output Markdown with exactly these sections, in this order:
## Goal
## What was done
## Key decisions & findings
## Current state
## Next steps
Be concrete: name files, functions, commands, errors and decisions. Prefer bullet points. Only state what the conversation supports; do not invent. Do not list every file again (a separate exact list is appended). At most about 400 words.`;

export function handoffMessages(facts: SessionFacts, agents: AgentSnapshot[]): ChatMessage[] {
  const main = agents.find((a) => a.role === 'main') ?? agents[0];
  const reports = agents.filter((a) => a.role === 'sub' && a.result).map((a) => `- ${a.type} agent "${a.description}" (${a.outcome}): ${clip(a.result!.replace(/\s+/g, ' '), 600)}`);
  const body = [
    `Session title: ${facts.title}`,
    `Files changed: ${facts.files.map((f) => f.path).join(', ') || 'none'}`,
    `Commands run: ${facts.commands.map((c) => `${c.command} (${c.ok ? 'ok' : 'failed'})`).join('; ') || 'none'}`,
    facts.todos.length ? `Task list: ${facts.todos.map((t) => `[${t.status}] ${t.content}`).join('; ')}` : '',
    reports.length ? `Sub-agent reports:\n${reports.join('\n')}` : '',
    `\nConversation:\n${transcript(main?.history ?? [], 50000)}`,
  ].filter(Boolean).join('\n');
  return [{ role: 'system', content: HANDOFF_SYSTEM }, { role: 'user', content: body }];
}

function fallbackNarrative(facts: SessionFacts, reason: string): string {
  const first = facts.requests[0] ?? '(no request recorded)';
  const recent = facts.requests.slice(1).slice(-5);
  return [
    `_Automatic summary unavailable (${reason}); this is the factual outline._`,
    '## Goal', `- ${first}`,
    recent.length ? `## Later requests\n${recent.map((r) => `- ${r}`).join('\n')}` : '',
    '## Next steps', '- Review the files and commands below, verify the current state (e.g. run the tests), then continue with the last request.',
  ].filter(Boolean).join('\n\n');
}

export function renderHandoff(facts: SessionFacts, narrative: string, when = new Date()): string {
  const files = facts.files.length
    ? facts.files.map((f) => `- \`${f.path}\` — ${[f.edits ? `edited ${f.edits}×` : '', f.writes ? `written ${f.writes}×` : ''].filter(Boolean).join(', ')}`).join('\n')
    : '- (no files were changed)';
  const cmds = facts.commands.length ? facts.commands.map((c) => `- ${c.ok ? '✓' : '✕'} \`${c.command}\``).join('\n') : '- (none)';
  const agents = facts.agents.length ? facts.agents.map((a) => `- ${a.type}: ${a.description} (${a.outcome})`).join('\n') : '';
  const todos = facts.todos.length ? facts.todos.map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}${t.status === 'in_progress' ? ' _(in progress)_' : ''}`).join('\n') : '';
  return [
    `# Session handoff: ${facts.title}`,
    `> Paste this into a new session to continue the work from "${facts.title}" (${when.toISOString().slice(0, 16).replace('T', ' ')}, ${facts.turns} request${facts.turns === 1 ? '' : 's'}, ${facts.toolCalls} tool call${facts.toolCalls === 1 ? '' : 's'}).`,
    narrative.trim(),
    `## Files changed\n${files}`,
    `## Commands run\n${cmds}`,
    agents ? `## Agents used\n${agents}` : '',
    todos ? `## Task list\n${todos}` : '',
    '## How to continue\n- Treat the above as context, not instructions to repeat. Re-read the listed files before editing them, check the current state, then carry on with the next steps.',
  ].filter(Boolean).join('\n\n');
}

export async function summarizeSession(
  title: string, agents: AgentSnapshot[], llm: LlmFn, cfg: LlmConfig, signal: AbortSignal, root = '',
): Promise<{ text: string; facts: SessionFacts; usedLlm: boolean; error?: string }> {
  const facts = collectFacts(title || 'Untitled session', agents, root);
  if (!facts.turns) { return { text: renderHandoff(facts, fallbackNarrative(facts, 'the session has no messages yet')), facts, usedLlm: false }; }
  try {
    const r = await llm({ ...cfg, temperature: 0.2, maxTokens: 1500 }, handoffMessages(facts, agents), [], () => {}, signal);
    const narrative = r.content.trim();
    if (!narrative) { throw new Error('empty response'); }
    return { text: renderHandoff(facts, narrative), facts, usedLlm: true };
  } catch (e: any) {
    if (e?.message === 'Cancelled') { throw e; }
    const reason = e?.message ?? String(e);
    return { text: renderHandoff(facts, fallbackNarrative(facts, reason)), facts, usedLlm: false, error: reason };
  }
}
