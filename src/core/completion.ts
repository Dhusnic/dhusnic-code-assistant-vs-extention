/**
 * Inline (ghost-text) completions: the prompts, the post-processing and the engine the host's provider calls.
 *
 * Design:
 * - Two ways to ask the model. FIM (fim.ts): the model's fill-in-the-middle tokens sent to the raw `/completions`
 *   endpoint, for model families known to support it. Chat: a system prompt plus the code with a <CURSOR> marker
 *   sent to `/chat/completions`, which works with any model.
 * - The mode comes from `infraonAssistant.inlineCompletions.mode`: "fim", "chat", or "auto" (FIM when fimFormatFor()
 *   knows the model's family, otherwise chat). In auto mode, when the gateway rejects `/completions` (404, 400,
 *   501, "not supported"...), the same request is answered through chat and the gateway+model pair is remembered for
 *   the engine's lifetime (the VS Code session), so a failing call is never repeated. Explicit "fim" never falls back.
 * - The current file is trimmed to PREFIX_CHARS before and SUFFIX_CHARS after the cursor on line boundaries. Extra
 *   context (completionContext.ts: open tabs, imported signatures) is collected by the host within its own budget and
 *   passed in the request; it goes into either prompt.
 * - complete() never throws and returns '' on any failure: completions must never disturb typing. Results are cached
 *   per file and cursor neighbourhood (LRU), and an aborted request is not cached. One request per call, except the
 *   single chat request right after FIM is found unsupported.
 *
 * No vscode import: the host supplies the LLM functions, the config and the mode.
 */
import { ChatMessage, LlmConfig, LlmFn, TextCompleteFn } from './llm';
import type { ContextSnippet } from './completionContext';
import { FIM_FORMATS, FimFormat, buildFimPrompt, cleanFim, fimFormatFor } from './fim';

export const PREFIX_CHARS = 4000;
export const SUFFIX_CHARS = 1500;
export const MAX_COMPLETION_LINES = 12;
export const CURSOR = '<CURSOR>';
export const FIM_TEMPERATURE = 0.1;

export const COMPLETION_SYSTEM = `You are a code completion engine embedded in an editor.
Reply with ONLY the code that should be inserted at ${CURSOR}. No explanations, no markdown fences, and do not repeat any text that already appears before or after the cursor.
Match the surrounding style and indentation. Prefer short completions (a line or a small block). If nothing sensible can be inserted, reply with nothing.`;

export interface CompletionRequest {
  prefix: string; suffix: string; language: string; file: string;
  /** Workspace folder name, for the repo-level FIM prompt. */
  repo?: string;
  /** Snippets from other files, already fitted to the context budget (completionContext.gatherContext). */
  context?: ContextSnippet[];
}
export type CompletionMode = 'auto' | 'fim' | 'chat';
export const COMPLETION_MODES: CompletionMode[] = ['auto', 'fim', 'chat'];

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
  const related = (req.context ?? []).filter((s) => s.text.trim())
    .map((s) => `--- ${s.path}${s.kind === 'import' ? ' (signatures)' : ''}\n${s.text.replace(/\s+$/, '')}`).join('\n\n');
  const ctx = related ? `Related code from other files (for reference only, do not repeat it):\n${related}\n\n` : '';
  return [
    { role: 'system', content: COMPLETION_SYSTEM },
    { role: 'user', content: `${ctx}File: ${req.file} (${req.language})\n\n${prefix}${CURSOR}${suffix}` },
  ];
}

/** Gateway errors meaning "this endpoint or prompt style is not available", as opposed to a transient failure. */
export function isFimUnsupportedError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /LLM HTTP (400|404|405|415|422|501)\b/.test(m) || /not supported|does not support|unsupported/i.test(m);
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

export interface CompletionEngineOptions {
  /** Raw `/completions` call (llm.completeText). Without it the engine always uses chat. */
  completeText?: TextCompleteFn;
  /** Read on every request, so a settings change applies at once. Default "auto". */
  mode?: () => CompletionMode;
}

export class CompletionEngine {
  private cache = new LruCache<string>(50);
  /** `${baseUrl}\n${model}` pairs whose gateway rejected FIM in auto mode; they use chat for the rest of the session. */
  private noFim = new Set<string>();

  constructor(
    private llm: LlmFn, private getConfig: () => Promise<LlmConfig | undefined> | LlmConfig | undefined,
    private opts: CompletionEngineOptions = {},
  ) {}

  /** The FIM format for this config and mode, or undefined when the request should use chat. */
  fimFormat(cfg: LlmConfig, mode: CompletionMode = this.opts.mode?.() ?? 'auto'): FimFormat | undefined {
    if (mode === 'chat' || !this.opts.completeText) { return undefined; }
    const fmt = fimFormatFor(cfg.model);
    if (mode === 'fim') { return fmt ?? FIM_FORMATS.qwen; }
    return fmt && !this.noFim.has(`${cfg.baseUrl}\n${cfg.model}`) ? fmt : undefined;
  }

  /** Returns the text to insert, or '' (never throws: completions must never disturb typing). */
  async complete(req: CompletionRequest, signal: AbortSignal): Promise<string> {
    const { prefix, suffix } = trimContext(req.prefix, req.suffix);
    const key = `${req.file}\u0000${prefix.slice(-400)}\u0000${suffix.slice(0, 200)}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) { return hit; }
    try {
      const cfg = await this.getConfig();
      if (!cfg || signal.aborted) { return ''; }
      const mode = this.opts.mode?.() ?? 'auto';
      const fmt = this.fimFormat(cfg, mode);
      let out: string | undefined;
      if (fmt && this.opts.completeText) {
        try {
          const prompt = buildFimPrompt(fmt, { prefix, suffix, file: req.file, language: req.language, repo: req.repo, context: req.context });
          const raw = await this.opts.completeText(cfg, { prompt, stop: fmt.stop, maxTokens: cfg.maxTokens, temperature: FIM_TEMPERATURE }, signal);
          out = cleanFim(raw, req.prefix, req.suffix, fmt);
        } catch (e) {
          if (mode !== 'auto' || signal.aborted || !isFimUnsupportedError(e)) { return ''; }
          this.noFim.add(`${cfg.baseUrl}\n${cfg.model}`);
        }
      }
      if (out === undefined) {
        const res = await this.llm({ ...cfg, temperature: 0.1 }, buildCompletionMessages(req), [], () => {}, signal);
        out = cleanCompletion(res.content, req.prefix, req.suffix);
      }
      if (!signal.aborted) { this.cache.set(key, out); }
      return out;
    } catch { return ''; }
  }
}
