/**
 * A local metering proxy for comparison evals: every agent under test (this extension, Cline, ...) talks to
 * http://127.0.0.1:<port>/v1 and the proxy forwards each request unchanged to the real gateway, so all agents are
 * measured the same way, whatever their own logging reports.
 *
 * Per request it records wall time, time to first byte and the token usage the gateway returns (from the JSON body
 * or from the usage chunk of an SSE stream). Streamed chat requests without stream_options.include_usage get it
 * added, or the gateway would not report usage for them. Optional `force` values (temperature, top_p, ...) are
 * written into every chat request body, so agents with different sampling defaults run with the same sampling.
 * When the gateway rejects a request with 400/422 and forced `droppable` fields (top_k, repetition_penalty) were
 * in it, the proxy retries once without them and leaves them out from then on, like the extension's own client.
 *
 * The proxy listens on loopback only and forwards only to the configured upstream base URL, adding the real API key
 * itself: the agents get a placeholder key and never see the real one. Nothing is logged or written to disk here.
 */
import * as http from 'http';
import * as https from 'https';
import { AddressInfo } from 'net';

export interface MeterCall {
  path: string;
  status: number;
  ms: number;
  firstByteMs: number;
  promptTokens: number;
  completionTokens: number;
  stream: boolean;
  error?: string;
}

export interface MeterTotals {
  calls: number;
  failedCalls: number;
  promptTokens: number;
  completionTokens: number;
  /** Sum of per-request wall time (requests are sequential for one agent, so this is time spent waiting on the model). */
  llmMs: number;
  /** Mean time to first response byte over the chat calls. */
  avgFirstByteMs: number;
}

export interface MeterOptions {
  /** The real gateway, e.g. https://llm.internal/v1. */
  upstream: string;
  apiKey: string;
  allowSelfSigned?: boolean;
  /** Body fields written into every chat/completions request (e.g. { temperature: 0.7, top_p: 0.8 }). */
  force?: Record<string, number>;
  /** Forced fields a gateway may not support: dropped (for good) after a 400/422 that names a request field. */
  droppable?: string[];
}

export interface Meter {
  /** Base URL to give the agents, e.g. http://127.0.0.1:51234/v1. */
  url: string;
  /** Placeholder key for the agents; the proxy replaces it with the real one. */
  readonly agentKey: string;
  calls(): MeterCall[];
  totals(): MeterTotals;
  reset(): void;
  /** The fields currently forced into chat requests (fewer than asked for after a gateway rejected some). */
  forced(): Record<string, number>;
  close(): Promise<void>;
}

export const totalsOf = (calls: MeterCall[]): MeterTotals => {
  const chat = calls.filter((c) => /chat\/completions/.test(c.path));
  return {
    calls: chat.length,
    failedCalls: chat.filter((c) => c.error || c.status >= 400).length,
    promptTokens: calls.reduce((n, c) => n + c.promptTokens, 0),
    completionTokens: calls.reduce((n, c) => n + c.completionTokens, 0),
    llmMs: chat.reduce((n, c) => n + c.ms, 0),
    avgFirstByteMs: chat.length ? Math.round(chat.reduce((n, c) => n + c.firstByteMs, 0) / chat.length) : 0,
  };
};

/** Reads usage from an OpenAI-style object: { usage: { prompt_tokens, completion_tokens } }. */
function usageOf(obj: any): { prompt: number; completion: number } | undefined {
  const u = obj?.usage;
  if (!u || typeof u !== 'object') { return undefined; }
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  return prompt || completion ? { prompt, completion } : undefined;
}

/** The last usage reported in an SSE body (gateways send it in the final chunk). */
export function usageFromSse(body: string): { prompt: number; completion: number } | undefined {
  let found: { prompt: number; completion: number } | undefined;
  for (const line of body.split(/\r?\n/)) {
    const m = /^data:\s*(.*)$/.exec(line);
    if (!m || m[1] === '[DONE]') { continue; }
    try { found = usageOf(JSON.parse(m[1])) ?? found; } catch { /* partial or non-JSON line */ }
  }
  return found;
}

/** Applies include_usage and the forced sampling fields to a chat request body; returns it unchanged otherwise. */
export function rewriteChatBody(raw: Buffer, force: Record<string, number> = {}): { body: Buffer; stream: boolean } {
  let obj: any;
  try { obj = JSON.parse(raw.toString('utf8')); } catch { return { body: raw, stream: false }; }
  if (!obj || typeof obj !== 'object') { return { body: raw, stream: false }; }
  const stream = obj.stream === true;
  if (stream) { obj.stream_options = { ...(obj.stream_options ?? {}), include_usage: true }; }
  Object.assign(obj, force);
  return { body: Buffer.from(JSON.stringify(obj)), stream };
}

export async function startMeter(opts: MeterOptions): Promise<Meter> {
  const upstream = new URL(opts.upstream.replace(/\/+$/, ''));
  const agentKey = 'metered-by-eval-proxy';
  let log: MeterCall[] = [];
  const force = { ...(opts.force ?? {}) };
  const dropForced = (): boolean => {
    const gone = (opts.droppable ?? []).filter((k) => k in force);
    for (const k of gone) { delete force[k]; }
    return gone.length > 0;
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const started = Date.now();
      // The agents see /v1/...; strip that prefix and append the rest to the upstream base path.
      const rest = (req.url ?? '/').replace(/^\/v1(?=\/|$)/, '');
      const target = new URL(upstream.pathname.replace(/\/$/, '') + rest, upstream);
      const isChat = req.method === 'POST' && /\/chat\/completions$/.test(target.pathname);
      const original = Buffer.concat(chunks);
      const { body, stream } = isChat ? rewriteChatBody(original, force) : { body: original, stream: false };

      const isHttps = target.protocol === 'https:';
      const call: MeterCall = { path: target.pathname, status: 0, ms: 0, firstByteMs: 0, promptTokens: 0, completionTokens: 0, stream };
      let retried = false;
      const send = (payload: Buffer): http.ClientRequest => {
        const headers: http.OutgoingHttpHeaders = {
          'content-type': req.headers['content-type'] ?? 'application/json',
          accept: req.headers.accept ?? '*/*',
          authorization: `Bearer ${opts.apiKey}`,
          ...(payload.length ? { 'content-length': payload.length } : {}),
        };
        const r = (isHttps ? https : http).request(target, {
          method: req.method, headers, ...(isHttps ? { rejectUnauthorized: !opts.allowSelfSigned } : {}),
        }, onResponse);
        r.on('error', onError);
        current = r;
        r.end(payload);
        return r;
      };
      let current: http.ClientRequest | undefined;
      const onResponse = (ur: http.IncomingMessage): void => {
        if (isChat && !retried && (ur.statusCode === 400 || ur.statusCode === 422) && (opts.droppable ?? []).some((k) => k in force)) {
          // Read the error; if it is about request fields, drop the forced extras and try again once.
          const errChunks: Buffer[] = [];
          ur.on('data', (c: Buffer) => errChunks.push(c));
          ur.on('end', () => {
            const errText = Buffer.concat(errChunks).toString('utf8');
            if (/top_k|repetition_penalty|extra|unknown|unsupported|unrecognized|unexpected|not (permitted|allowed|supported)/i.test(errText) && dropForced()) {
              retried = true;
              send(rewriteChatBody(original, force).body);
              return;
            }
            relay(ur, Buffer.from(errText));
          });
          return;
        }
        relay(ur);
      };
      const relay = (ur: http.IncomingMessage, already?: Buffer): void => {
        call.status = ur.statusCode ?? 0;
        call.firstByteMs = Date.now() - started;
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        const got: Buffer[] = [];
        if (already) { got.push(already); res.end(already); finish(ur, got); return; }
        ur.on('data', (c: Buffer) => { got.push(c); res.write(c); });
        ur.on('end', () => {
          res.end();
          finish(ur, got);
        });
        ur.on('error', (e) => { call.error = e.message; call.ms = Date.now() - started; log.push(call); res.destroy(e); });
      };
      const finish = (ur: http.IncomingMessage, got: Buffer[]): void => {
        const text = Buffer.concat(got).toString('utf8');
        let usage: { prompt: number; completion: number } | undefined;
        if (/text\/event-stream/.test(String(ur.headers['content-type'] ?? '')) || /^data:/m.test(text)) { usage = usageFromSse(text); }
        else { try { usage = usageOf(JSON.parse(text)); } catch { /* not JSON */ } }
        call.promptTokens = usage?.prompt ?? 0;
        call.completionTokens = usage?.completion ?? 0;
        call.ms = Date.now() - started;
        log.push(call);
      };
      const onError = (e: Error): void => {
        call.error = e.message; call.ms = Date.now() - started; log.push(call);
        if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); }
        res.end(JSON.stringify({ error: { message: `eval proxy: ${e.message}` } }));
      };
      // An agent that gives up (timeout, cancel) closes its socket: stop the upstream request too.
      res.on('close', () => { if (!res.writableEnded) { current?.destroy(); } });
      send(body);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    agentKey,
    calls: () => [...log],
    totals: () => totalsOf(log),
    reset: () => { log = []; },
    forced: () => ({ ...force }),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
