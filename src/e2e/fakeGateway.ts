import * as http from 'http';
import { AddressInfo } from 'net';
import { API_KEY, GatewayState, MODELS, RecordedRequest, ScreenshotResult, ScriptStep } from './protocol';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const GATE_SAFETY_MS = 120_000;

/**
 * Local stand-in for the company LLM: GET /v1/models and streaming POST /v1/chat/completions, answering from a
 * queue of scripted steps. Control routes under /__e2e/ let the suite (in the extension host) script it and read
 * what was received. Binds to 127.0.0.1 only.
 */
export class FakeGateway {
  private server?: http.Server;
  private queue: ScriptStep[] = [];
  private requests: RecordedRequest[] = [];
  private unscripted = 0;
  private gates = new Map<string, Array<() => void>>();
  private released = new Set<string>();
  private seq = 0;
  private toolSeq = 0;
  port = 0;
  /** Set by the runner: takes a screenshot through the DevTools protocol. */
  onScreenshot?: (name: string) => Promise<ScreenshotResult>;

  get url(): string { return `http://127.0.0.1:${this.port}`; }

  start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.route(req, res).catch((e) => {
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); }
        res.end(String(e?.message ?? e));
      });
    });
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => { this.port = (this.server!.address() as AddressInfo).port; resolve(); });
    });
  }

  async stop(): Promise<void> {
    this.openAllGates();
    const s = this.server;
    if (!s) { return; }
    this.server = undefined;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  reset(): void {
    this.openAllGates();
    this.queue = [];
    this.requests = [];
    this.unscripted = 0;
    this.released.clear();
  }

  script(steps: ScriptStep[]): void { this.queue.push(...steps); }

  state(): GatewayState { return { requests: this.requests, pending: this.queue.length, unscripted: this.unscripted }; }

  release(name: string): void {
    this.released.add(name);
    for (const w of this.gates.get(name) ?? []) { w(); }
    this.gates.delete(name);
  }

  private openAllGates(): void { for (const name of [...this.gates.keys()]) { this.release(name); } }

  /* ------------------------------------------------------------ routing */

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readBody(req);
    if (url.pathname.startsWith('/__e2e/')) { await this.control(url.pathname.slice('/__e2e/'.length), body, res); return; }
    if (req.headers.authorization !== `Bearer ${API_KEY}`) { json(res, 401, { error: { message: 'bad api key' } }); return; }
    if (req.method === 'GET' && url.pathname === '/v1/models') { json(res, 200, { object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) }); return; }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') { await this.chat(req, res, body); return; }
    json(res, 404, { error: { message: `no route ${req.method} ${url.pathname}` } });
  }

  private async control(action: string, body: string, res: http.ServerResponse): Promise<void> {
    const m = body ? JSON.parse(body) : {};
    switch (action) {
      case 'reset': this.reset(); json(res, 200, { ok: true }); return;
      case 'script': this.script(m.steps ?? []); json(res, 200, { ok: true }); return;
      case 'state': json(res, 200, this.state()); return;
      case 'release': this.release(String(m.name)); json(res, 200, { ok: true }); return;
      case 'screenshot': json(res, 200, this.onScreenshot ? await this.onScreenshot(String(m.name)) : { error: 'screenshots are not available' }); return;
      default: json(res, 404, { error: `unknown control action ${action}` });
    }
  }

  /* ------------------------------------------------------------ chat completions */

  private async chat(req: http.IncomingMessage, res: http.ServerResponse, raw: string): Promise<void> {
    const payload = JSON.parse(raw);
    const scripted = this.queue.shift();
    const step: ScriptStep = scripted ?? { text: '(unscripted reply from the fake gateway)' };
    if (!scripted) { this.unscripted++; }
    const rec: RecordedRequest = {
      seq: ++this.seq, auth: String(req.headers.authorization ?? ''), model: String(payload.model ?? ''), stream: payload.stream === true,
      messages: payload.messages ?? [], tools: (payload.tools ?? []).map((t: any) => String(t?.function?.name)),
      aborted: false, unscripted: !scripted,
    };
    this.requests.push(rec);

    let closed = false;
    res.on('close', () => { closed = true; if (!res.writableEnded) { rec.aborted = true; } });
    req.socket.on('close', () => { closed = true; });

    if (step.delayMs) { await sleep(step.delayMs); }
    if (step.drop) { req.socket.destroy(); return; }
    if (step.status) {
      res.writeHead(step.status, { 'Content-Type': 'application/json' });
      res.end(step.body ?? JSON.stringify({ error: { message: `scripted HTTP ${step.status}` } }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const id = `chatcmpl-e2e-${rec.seq}`;
    const emit = (delta: unknown, finish: string | null = null): void => {
      if (closed) { return; }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: rec.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    };
    emit({ role: 'assistant', content: '' });

    const text = step.text ?? '';
    const gateAt = step.gate ? Math.min(step.gate.afterChars ?? 0, text.length) : -1;
    const pieces = (s: string): string[] => s.match(/\S+\s*|\s+/g) ?? [];
    for (const p of pieces(gateAt >= 0 ? text.slice(0, gateAt) : text)) {
      emit({ content: p });
      await sleep(step.chunkDelayMs ?? 4);
      if (closed) { return; }
    }
    if (step.gate) {
      await this.waitGate(step.gate.name, () => closed);
      if (closed) { return; }
      for (const p of pieces(text.slice(gateAt))) {
        emit({ content: p });
        await sleep(step.chunkDelayMs ?? 4);
        if (closed) { return; }
      }
    }

    (step.toolCalls ?? []).forEach((call, index) => {
      const args = typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {});
      const mid = Math.ceil(args.length / 2);
      // Arguments arrive in two fragments, as real gateways stream them.
      emit({ tool_calls: [{ index, id: call.id ?? `call_e2e_${++this.toolSeq}`, type: 'function', function: { name: call.name, arguments: args.slice(0, mid) } }] });
      emit({ tool_calls: [{ index, function: { arguments: args.slice(mid) } }] });
    });

    emit({}, step.toolCalls?.length ? 'tool_calls' : 'stop');
    if (closed) { return; }
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: rec.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: Math.max(1, Math.ceil(text.length / 4)), total_tokens: 100 + Math.ceil(text.length / 4) } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }

  private waitGate(name: string, isClosed: () => boolean): Promise<void> {
    if (this.released.has(name)) { return Promise.resolve(); }
    return new Promise((resolve) => {
      const done = (): void => { clearInterval(poll); clearTimeout(safety); resolve(); };
      const poll = setInterval(() => { if (isClosed()) { done(); } }, 50);
      const safety = setTimeout(done, GATE_SAFETY_MS);
      this.gates.set(name, [...(this.gates.get(name) ?? []), done]);
    });
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (data += d));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
