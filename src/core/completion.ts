import { ChatMessage, LlmConfig, LlmFn } from './llm';

export const PREFIX_CHARS = 4000;
export const SUFFIX_CHARS = 1500;
export const MAX_COMPLETION_LINES = 12;
export const CURSOR = '<CURSOR>';

export const COMPLETION_SYSTEM = `You are a code completion engine embedded in an editor.
Reply with ONLY the code that should be inserted at ${CURSOR}. No explanations, no markdown fences, and do not repeat any text that already appears before or after the cursor.
Match the surrounding style and indentation. Prefer short completions (a line or a small block). If nothing sensible can be inserted, reply with nothing.`;

export interface CompletionRequest { prefix: string; suffix: string; language: string; file: string }

/** Keeps the context window small: the tail of the prefix and the head of the suffix, cut on line boundaries. */
export function trimContext(prefix: string, suffix: string): { prefix: string; suffix: string } {
  let p = prefix;
  if (p.length > PREFIX_CHARS) {
    p = p.slice(-PREFIX_CHARS);
    const nl = p.indexOf('\n');
    if (nl >= 0 && nl < 200) { p = p.slice(nl + 1); }
  }
  let s = suffix;
  if (s.length > SUFFIX_CHARS) {
    s = s.slice(0, SUFFIX_CHARS);
    const nl = s.lastIndexOf('\n');
    if (nl > SUFFIX_CHARS - 200) { s = s.slice(0, nl); }
  }
  return { prefix: p, suffix: s };
}

export function buildCompletionMessages(req: CompletionRequest): ChatMessage[] {
  const { prefix, suffix } = trimContext(req.prefix, req.suffix);
  return [
    { role: 'system', content: COMPLETION_SYSTEM },
    { role: 'user', content: `File: ${req.file} (${req.language})\n\n${prefix}${CURSOR}${suffix}` },
  ];
}

/** Whether a completion is worth requesting: skip empty documents and cursors in the middle of code. */
export function shouldTrigger(prefix: string, lineSuffix: string): boolean {
  if (!prefix.trim()) { return false; }
  return /^[\s)\]}"'`;,>]*$/.test(lineSuffix);
}

const lastLine = (s: string): string => s.slice(s.lastIndexOf('\n') + 1);

/** Strips fences/markers and any text the model echoed from before or after the cursor. */
export function cleanCompletion(raw: string, prefix: string, suffix: string): string {
  let t = raw.replace(/\r\n/g, '\n');
  const fence = /^\s*```[\w+-]*\n([\s\S]*?)(?:\n```\s*)?$/.exec(t);
  if (fence) { t = fence[1]; }
  t = t.split(CURSOR).join('');
  if (!t.trim()) { return ''; }

  const cur = lastLine(prefix);
  if (cur.trim() && t.startsWith(cur)) { t = t.slice(cur.length); }
  else if (cur.trim()) {
    const trimmed = cur.trimStart();
    if (trimmed && t.trimStart().startsWith(trimmed) && t.startsWith(cur.slice(0, cur.length - trimmed.length))) { t = t.slice(cur.length); }
  }

  const next = suffix.split('\n')[0];
  if (next.trim()) {
    for (let n = Math.min(t.length, next.length); n > 0; n--) {
      if (t.endsWith(next.slice(0, n))) { t = t.slice(0, t.length - n); break; }
    }
  }
  const lines = t.split('\n');
  if (lines.length > MAX_COMPLETION_LINES) { t = lines.slice(0, MAX_COMPLETION_LINES).join('\n'); }
  t = t.replace(/\s+$/, '');
  return t.trim() ? t : '';
}

/** Tiny LRU for completions, so retyping/backspacing does not re-hit the model. */
export class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private max = 50) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(k: string, v: V): void {
    this.map.delete(k); this.map.set(k, v);
    if (this.map.size > this.max) { this.map.delete(this.map.keys().next().value as string); }
  }
  get size(): number { return this.map.size; }
}

export class CompletionEngine {
  private cache = new LruCache<string>(50);

  constructor(private llm: LlmFn, private getConfig: () => Promise<LlmConfig | undefined> | LlmConfig | undefined) {}

  /** Returns the text to insert, or '' (never throws: completions must never disturb typing). */
  async complete(req: CompletionRequest, signal: AbortSignal): Promise<string> {
    const { prefix, suffix } = trimContext(req.prefix, req.suffix);
    const key = `${req.file}\u0000${prefix.slice(-400)}\u0000${suffix.slice(0, 200)}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) { return hit; }
    try {
      const cfg = await this.getConfig();
      if (!cfg || signal.aborted) { return ''; }
      const res = await this.llm({ ...cfg, temperature: 0.1 }, buildCompletionMessages(req), [], () => {}, signal);
      const out = cleanCompletion(res.content, req.prefix, req.suffix);
      if (!signal.aborted) { this.cache.set(key, out); }
      return out;
    } catch { return ''; }
  }
}
