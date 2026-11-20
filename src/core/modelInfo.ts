import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { LlmConfig } from './llm';

/**
 * The model's real context window. The default (256k) is far more than many company models have; compacting against
 * the wrong number means requests fail with "maximum context length exceeded" instead of being shortened in time.
 */

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};

/** Context-window fields used by vLLM, OpenRouter, LiteLLM and llama.cpp, best first. */
function windowOf(entry: any): number | undefined {
  if (!entry || typeof entry !== 'object') { return undefined; }
  const best = num(entry.max_model_len) ?? num(entry.context_length) ?? num(entry.context_window) ?? num(entry.max_context_length)
    ?? num(entry.max_input_tokens) ?? num(entry.top_provider?.context_length) ?? num(entry.meta?.n_ctx_train) ?? num(entry.meta?.n_ctx);
  if (best) { return best; }
  const maxTokens = num(entry.max_tokens);
  return maxTokens && maxTokens > 4096 ? maxTokens : undefined;
}

/** Pure: reads the context window of `model` from a parsed /models JSON body. */
export function contextWindowFrom(body: unknown, model: string): number | undefined {
  const b = body as any;
  const list: any[] = Array.isArray(b?.data) ? b.data : Array.isArray(b?.models) ? b.models : Array.isArray(b) ? b : [];
  const entries = list.filter((e) => e && typeof e === 'object');
  const match = entries.find((e) => e.id === model || e.model === model || e.name === model);
  if (match) { return windowOf(match); }
  return entries.length === 1 ? windowOf(entries[0]) : undefined;
}

/** Asks the gateway's GET {baseUrl}/models for the model's context window. undefined when not reported. Never throws. */
export function fetchContextWindow(cfg: LlmConfig, model: string, timeoutMs = 10_000): Promise<number | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: number | undefined) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let req: http.ClientRequest | undefined;
    const timer = setTimeout(() => { req?.destroy(); finish(undefined); }, timeoutMs);
    try {
      const url = new URL(`${cfg.baseUrl.replace(/\/+$/, '')}/models`);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;
      req = lib.request({
        method: 'GET', hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname + url.search,
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        ...(isHttps ? { rejectUnauthorized: !cfg.allowSelfSigned } : {}),
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { data += d; if (data.length > 5_000_000) { req?.destroy(); finish(undefined); } });
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) { finish(undefined); return; }
          try { finish(contextWindowFrom(JSON.parse(data), model)); } catch { finish(undefined); }
        });
        res.on('error', () => finish(undefined));
      });
      req.on('error', () => finish(undefined));
      req.end();
    } catch { finish(undefined); }
  });
}

const CONTEXT_PATTERNS = [
  /maximum context length/i, /context length exceeded/i, /context_length_exceeded/i, /too many tokens/i, /prompt is too long/i,
  /input is too long/i, /exceeds the model'?s context/i, /reduce the length of the messages/i, /maximum input length/i,
  /exceeds the available context size/i,
];

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e ?? ''));

/** True when an LLM error says the request was too long for the model's context (so the caller should compact and retry). */
export function isContextLengthError(e: unknown): boolean {
  const m = messageOf(e);
  const status = /LLM HTTP (\d{3})\b/.exec(m);
  // A 5xx that happens to mention tokens is a server failure, not a request that was too long.
  if (status && status[1] !== '400' && status[1] !== '413') { return false; }
  return CONTEXT_PATTERNS.some((re) => re.test(m));
}

/** Parses the real limit from such an error message when it states one (e.g. "maximum context length is 32768 tokens"). */
export function contextLimitFromError(e: unknown): number | undefined {
  const m = messageOf(e);
  const patterns = [
    /maximum context length is (\d[\d,]*)/i,
    /context (?:size|window|length) (?:of |is )?\(?(\d[\d,]*) tokens?\)?/i,
    /available context size \((\d[\d,]*)/i,
    /maximum input length (?:is |of )?(\d[\d,]*)/i,
    /(?:limit|maximum) (?:is |of )(\d[\d,]*) tokens/i,
  ];
  for (const re of patterns) {
    const hit = re.exec(m);
    const n = hit ? num(hit[1].replace(/,/g, '')) : undefined;
    if (n) { return n; }
  }
  return undefined;
}
