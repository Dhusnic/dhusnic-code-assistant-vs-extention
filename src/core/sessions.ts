import * as fs from 'fs/promises';
import * as path from 'path';
import { ChatMessage } from './llm';

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  mode: string;
  effort: string;
  history: ChatMessage[];
  turnStarts: number[];
}
export interface SessionSummary { id: string; title: string; updatedAt: number; turns: number }

const ID_RE = /^[\w-]{1,64}$/;

export function titleFrom(text: string, max = 60): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t || 'New chat';
}

export class SessionStore {
  constructor(private dir: string) {}

  private file(id: string): string {
    if (!ID_RE.test(id)) { throw new Error(`Invalid session id: ${id}`); }
    return path.join(this.dir, `${id}.json`);
  }

  /** Atomic write: a crash mid-save can never leave a half-written session. */
  async save(s: Session): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.file(s.id);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(s));
    await fs.rename(tmp, target);
  }

  async load(id: string): Promise<Session | undefined> {
    try {
      const s = JSON.parse(await fs.readFile(this.file(id), 'utf8'));
      return isSession(s) ? s : undefined;
    } catch { return undefined; }
  }

  async list(): Promise<SessionSummary[]> {
    let names: string[];
    try { names = await fs.readdir(this.dir); } catch { return []; }
    const out: SessionSummary[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) { continue; }
      const s = await this.load(n.slice(0, -5));
      if (s) { out.push({ id: s.id, title: s.title, updatedAt: s.updatedAt, turns: s.turnStarts.length }); }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async delete(id: string): Promise<void> { await fs.rm(this.file(id), { force: true }); }
}

function isSession(s: any): s is Session {
  return !!s && typeof s.id === 'string' && typeof s.title === 'string' && Array.isArray(s.history) && Array.isArray(s.turnStarts)
    && s.history.every((m: any) => m && typeof m.role === 'string');
}

export type UiItem =
  /** A message the user sent: one that started a turn, or (`mid`) one sent while the agent was working. */
  | { type: 'user'; text: string; turn: number; at?: number; mid?: boolean }
  /** A message the agent loop added on its own (checks failed, a cut-off reply, a Stop hook): shown as a note. */
  | { type: 'note'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool'; id: string; name: string; detail: string; args: string; ok: boolean; result: string };

/** Rebuilds what the chat view shows from a saved message history. */
export function historyToUi(
  history: ChatMessage[], turnStarts: number[], describe: (name: string, args: any) => string = (n) => n,
): UiItem[] {
  const results = new Map<string, string>();
  for (const m of history) { if (m.role === 'tool' && m.tool_call_id) { results.set(m.tool_call_id, m.content ?? ''); } }
  const items: UiItem[] = [];
  history.forEach((m, i) => {
    if (m.role === 'user') {
      if (m.content?.startsWith(SUMMARY_PREFIX)) { items.push({ type: 'assistant', text: '_Earlier conversation was summarized to save context._' }); return; }
      const text = m.display ?? m.content ?? '';
      const start = turnStarts.lastIndexOf(i);
      if (start >= 0) { items.push({ type: 'user', text, turn: start, ...(m.at ? { at: m.at } : {}) }); return; }
      // Inside a turn: only messages the user sent mid-turn carry a time; the rest were added by the agent loop.
      const turn = Math.max(0, turnStarts.filter((s) => s < i).length - 1);
      items.push(m.at ? { type: 'user', text, turn, at: m.at, mid: true } : { type: 'note', text });
    } else if (m.role === 'assistant') {
      if (m.content === SUMMARY_ACK_TEXT) { return; }
      if (m.content) { items.push({ type: 'assistant', text: m.content }); }
      for (const tc of m.tool_calls ?? []) {
        let parsed: any = {};
        try { parsed = JSON.parse(tc.function.arguments || '{}'); } catch { /* keep {} */ }
        const result = results.get(tc.id) ?? '';
        items.push({
          type: 'tool', id: tc.id, name: tc.function.name, detail: describe(tc.function.name, parsed),
          args: tc.function.arguments, ok: !/^(ERROR|DENIED|Cancelled)/.test(result), result: result.slice(0, 4000),
        });
      }
    }
  });
  return items;
}

export const SUMMARY_PREFIX = '[Summary of earlier conversation]';
const SUMMARY_ACK_TEXT = 'Understood. I have the summary of our earlier conversation and will continue from it.';
