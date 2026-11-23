import { ChatMessage, LlmFn, TokenUsage } from './llm';
import { estimateTokens } from './compaction';

/** Token/request counters per day, used by the sidebar "LLM" panel. Real numbers from the gateway when it reports them. */
export interface DayUsage { requests: number; prompt: number; completion: number; errors: number; estimated: number }
export type UsageData = Record<string, DayUsage>;

const empty = (): DayUsage => ({ requests: 0, prompt: 0, completion: 0, errors: 0, estimated: 0 });
export const dayKey = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const KEEP_DAYS = 35;

export class UsageTracker {
  private sessions = new Map<string, { prompt: number; completion: number; requests: number }>();

  constructor(private data: UsageData = {}, private persist: (d: UsageData) => void = () => {}, private now: () => Date = () => new Date()) {}

  record(sessionId: string | undefined, u: TokenUsage | undefined, messages: ChatMessage[], content: string, failed = false): void {
    const day = (this.data[dayKey(this.now())] ??= empty());
    day.requests++;
    if (failed) { day.errors++; this.save(); return; }
    const used = u ?? { prompt: estimateTokens(messages), completion: Math.ceil(content.length / 3.5) };
    if (!u) { day.estimated++; }
    day.prompt += used.prompt;
    day.completion += used.completion;
    if (sessionId) {
      const s = this.sessions.get(sessionId) ?? { prompt: 0, completion: 0, requests: 0 };
      s.prompt += used.prompt; s.completion += used.completion; s.requests++;
      this.sessions.set(sessionId, s);
    }
    this.save();
  }

  /** Wraps an LLM function so every call is counted against `sessionId`. */
  wrap(llm: LlmFn, sessionId?: string): LlmFn {
    return async (cfg, messages, tools, onToken, signal, onToolProgress, onEvent) => {
      try {
        const r = await llm(cfg, messages, tools, onToken, signal, onToolProgress, onEvent);
        this.record(sessionId, r.usage, messages, r.content);
        return r;
      } catch (e: any) {
        if (e?.message !== 'Cancelled') { this.record(sessionId, undefined, messages, '', true); }
        throw e;
      }
    };
  }

  summary(): { today: DayUsage; week: DayUsage; days: Array<{ day: string } & DayUsage> } {
    const today = this.data[dayKey(this.now())] ?? empty();
    const week = empty();
    const days: Array<{ day: string } & DayUsage> = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(this.now()); d.setDate(d.getDate() - i);
      const v = this.data[dayKey(d)] ?? empty();
      days.push({ day: dayKey(d), ...v });
      week.requests += v.requests; week.prompt += v.prompt; week.completion += v.completion; week.errors += v.errors; week.estimated += v.estimated;
    }
    return { today, week, days };
  }

  session(sessionId: string): { prompt: number; completion: number; requests: number } {
    return this.sessions.get(sessionId) ?? { prompt: 0, completion: 0, requests: 0 };
  }

  private save(): void {
    const cutoff = new Date(this.now()); cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
    const min = dayKey(cutoff);
    for (const k of Object.keys(this.data)) { if (k < min) { delete this.data[k]; } }
    this.persist(this.data);
  }
}
