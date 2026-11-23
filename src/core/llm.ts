import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { SamplingExtras, samplingBody, withSamplingFallback } from './sampling';

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** UI-only text (e.g. the user's message before @mention expansion). Never sent to the LLM. */
  display?: string;
}
export interface ToolSpec { type: 'function'; function: { name: string; description: string; parameters: object } }

export interface LlmConfig {
  baseUrl: string; apiKey: string; model: string; temperature: number; maxTokens?: number; allowSelfSigned: boolean;
  /** End the request when the gateway sends nothing for this long (waiting for the first token included). Default 180 s. */
  idleTimeoutMs?: number;
  /** Sampling besides temperature (top_p, top_k, ...), chosen per model family in sampling.ts. Sent only when defined. */
  sampling?: SamplingExtras;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 180_000;
export interface TokenUsage { prompt: number; completion: number }
export interface StreamResult {
  content: string; toolCalls: ToolCall[]; usage?: TokenUsage;
  /** Why the model stopped: "stop", "tool_calls", or "length" when it hit the output-token limit. */
  finishReason?: string;
}
/**
 * A tool call the model is still writing. A large write_file streams for minutes with no visible text, so the
 * agent's status line shows this instead of "Thinking…". `path` is read from the partial arguments once it is complete.
 */
export interface ToolCallProgress { index: number; name: string; chars: number; path?: string }
/** Wrappers must pass `onToolProgress` through unchanged; it is optional, so callers that ignore it still work. */
export type LlmFn = (
  cfg: LlmConfig, messages: ChatMessage[], tools: ToolSpec[], onToken: (t: string) => void, signal: AbortSignal,
  onToolProgress?: (p: ToolCallProgress) => void,
) => Promise<StreamResult>;

/** Minimum time between two progress reports for one stream, so the UI is not flooded with updates. */
export const TOOL_PROGRESS_INTERVAL_MS = 250;
const PATH_ARG = /"(?:path|file_path|filePath|filename)"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/** Progress for a partly streamed tool call. The path is taken only once its JSON string has closed. */
export function toolCallProgress(index: number, call: ToolCall): ToolCallProgress {
  const m = PATH_ARG.exec(call.function.arguments);
  let path: string | undefined;
  if (m) { try { path = JSON.parse(`"${m[1]}"`); } catch { path = m[1]; } }
  return { index, name: call.function.name, chars: call.function.arguments.length, ...(path ? { path } : {}) };
}

export function endpoint(cfg: LlmConfig, suffix: string): URL {
  return new URL(`${cfg.baseUrl.replace(/\/+$/, '')}${suffix}`);
}

export function requestOptions(cfg: LlmConfig, url: URL, method: string, bodyLen: number): https.RequestOptions {
  const isHttps = url.protocol === 'https:';
  return {
    method, hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname + url.search,
    headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`,
      ...(bodyLen ? { 'Content-Length': bodyLen } : {}),
    },
    ...(isHttps ? { rejectUnauthorized: !cfg.allowSelfSigned } : {}),
  };
}

export const stripUiFields = (messages: ChatMessage[]): Omit<ChatMessage, 'display'>[] =>
  messages.map(({ display: _display, ...m }) => m);

export const streamChatOnce: LlmFn = (cfg, messages, tools, onToken, signal, onToolProgress) => {
  const url = endpoint(cfg, '/chat/completions');
  const payload: Record<string, unknown> = {
    model: cfg.model, messages: stripUiFields(messages), temperature: cfg.temperature, stream: true,
    stream_options: { include_usage: true },
  };
  if (tools.length) { payload.tools = tools; payload.tool_choice = 'auto'; }
  if (cfg.maxTokens) { payload.max_tokens = cfg.maxTokens; }
  Object.assign(payload, samplingBody(cfg.sampling));
  const body = JSON.stringify(payload);
  const lib = url.protocol === 'https:' ? https : http;

  return new Promise<StreamResult>((outerResolve, outerReject) => {
    if (signal.aborted) { outerReject(new Error('Cancelled')); return; }
    // A gateway that stops sending (overloaded GPU, dropped proxy connection) would otherwise leave the session
    // spinning until the user presses Stop. The timer restarts on every byte received.
    const idleMs = cfg.idleTimeoutMs && cfg.idleTimeoutMs > 0 ? cfg.idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS;
    let idle: NodeJS.Timeout | undefined;
    let settled = false;
    const done = () => { settled = true; clearTimeout(idle); signal.removeEventListener('abort', onAbort); };
    const resolve = (r: StreamResult) => { if (!settled) { done(); outerResolve(r); } };
    const reject = (e: Error) => { if (!settled) { done(); outerReject(e); } };
    const onAbort = () => { req.destroy(); reject(new Error('Cancelled')); };
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        const err = new Error(`LLM stream stalled: the gateway sent nothing for ${Math.round(idleMs / 1000)} s (ETIMEDOUT).`);
        reject(err);
        req.destroy(err);
      }, idleMs);
    };
    const req = lib.request(requestOptions(cfg, url, 'POST', Buffer.byteLength(body)), (res) => {
      touch();
      res.on('data', touch);
      if ((res.statusCode ?? 500) >= 400) {
        let err = '';
        res.on('data', (d) => (err += d));
        res.on('end', () => reject(new Error(`LLM HTTP ${res.statusCode}: ${err.slice(0, 500)}`)));
        return;
      }
      let content = '';
      let usage: TokenUsage | undefined;
      let finishReason: string | undefined;
      const calls: Record<number, ToolCall> = {};
      let lastProgress = 0;
      let lastProgressKey = '';
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) { continue; }
          const data = line.slice(5).trim();
          if (data === '[DONE]') { continue; }
          try {
            const obj = JSON.parse(data);
            if (obj.usage) { usage = { prompt: obj.usage.prompt_tokens ?? 0, completion: obj.usage.completion_tokens ?? 0 }; }
            if (obj.choices?.[0]?.finish_reason) { finishReason = String(obj.choices[0].finish_reason); }
            const delta = obj.choices?.[0]?.delta;
            if (!delta) { continue; }
            if (delta.content) { content += delta.content; onToken(delta.content); }
            for (const tc of delta.tool_calls ?? []) {
              const i = tc.index ?? 0;
              const cur = (calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
              if (tc.id) { cur.id = tc.id; }
              if (tc.function?.name) { cur.function.name += tc.function.name; }
              if (tc.function?.arguments) { cur.function.arguments += tc.function.arguments; }
              if (onToolProgress && cur.function.name) {
                // Report at once when the call or its path changes, otherwise at most every TOOL_PROGRESS_INTERVAL_MS.
                const p = toolCallProgress(i, cur);
                const key = `${i}|${p.name}|${p.path ?? ''}`;
                const now = Date.now();
                if (key !== lastProgressKey || now - lastProgress >= TOOL_PROGRESS_INTERVAL_MS) {
                  lastProgressKey = key; lastProgress = now;
                  try { onToolProgress(p); } catch { /* a UI error must not break the stream */ }
                }
              }
            }
          } catch { /* partial or keep-alive line */ }
        }
      });
      res.on('end', () => {
        const toolCalls = Object.keys(calls).map(Number).sort((a, b) => a - b).map((k, n) => {
          const c = calls[k]; if (!c.id) { c.id = `call_${Date.now()}_${n}`; } return c;
        });
        resolve({ content, toolCalls, ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}) });
      });
      res.on('error', reject);
      // The server closed the connection mid-reply: report it instead of returning a silently truncated answer.
      res.on('aborted', () => reject(new Error('LLM stream ended early (ECONNRESET).')));
    });
    req.on('error', reject);
    signal.addEventListener('abort', onAbort, { once: true });
    touch();
    req.write(body);
    req.end();
  });
};

export function listModels(cfg: LlmConfig): Promise<string[]> {
  const url = endpoint(cfg, '/models');
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(requestOptions(cfg, url, 'GET', 0), (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 400) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        try { resolve((JSON.parse(data).data ?? []).map((m: { id: string }) => m.id)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

export const isTransientError = (e: unknown): boolean => {
  const m = e instanceof Error ? e.message : String(e);
  return /LLM HTTP (429|502|503|504)\b/.test(m) || /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|ECONNREFUSED/.test(m);
};

/**
 * Retries transient gateway failures (502/503/504/429, resets) with exponential backoff. It only retries
 * while nothing has been streamed to the user yet, so output is never duplicated.
 */
export function withRetry(fn: LlmFn, opts: { retries?: number; baseDelayMs?: number } = {}): LlmFn {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 800;
  return async (cfg, messages, tools, onToken, signal, onToolProgress) => {
    for (let attempt = 0; ; attempt++) {
      let emitted = false;
      try {
        return await fn(cfg, messages, tools, (t) => { emitted = true; onToken(t); }, signal, onToolProgress);
      } catch (e) {
        if (signal.aborted || emitted || attempt >= retries || !isTransientError(e)) { throw e; }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, base * 2 ** attempt);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Cancelled')); }, { once: true });
        });
      }
    }
  };
}

/** Retries transient failures, and once without the non-standard sampling fields when the gateway rejects them. */
export const streamChat: LlmFn = withRetry(withSamplingFallback(streamChatOnce));
