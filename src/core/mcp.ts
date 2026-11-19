import { ChildProcess, spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { Tool, ToolKind } from './tool';
import { clip } from './fstools';

export interface McpServerConfig { command: string; args?: string[]; env?: Record<string, string>; disabled?: boolean }
export interface McpToolInfo { name: string; description?: string; inputSchema?: any; annotations?: { readOnlyHint?: boolean } }
export interface ServerStatus { name: string; status: 'connected' | 'error' | 'disabled'; tools: number; error?: string }

const CLIENT_INFO = { name: 'infraon-code-assistant', version: '1.0.0' };

export function parseMcpConfig(raw: unknown): { servers: Record<string, McpServerConfig>; errors: string[] } {
  const servers: Record<string, McpServerConfig> = {};
  const errors: string[] = [];
  const map = (raw && typeof raw === 'object' && 'mcpServers' in (raw as object) ? (raw as any).mcpServers : raw) as Record<string, any> | undefined;
  if (!map || typeof map !== 'object' || Array.isArray(map)) { return { servers, errors: raw === undefined ? [] : ['MCP config must be an object of servers.'] }; }
  for (const [name, c] of Object.entries(map)) {
    if (!c || typeof c.command !== 'string' || !c.command.trim()) { errors.push(`${name}: "command" is required (only stdio servers are supported).`); continue; }
    if (c.args !== undefined && (!Array.isArray(c.args) || c.args.some((a: unknown) => typeof a !== 'string'))) { errors.push(`${name}: "args" must be an array of strings.`); continue; }
    if (c.env !== undefined && (typeof c.env !== 'object' || Object.values(c.env).some((v) => typeof v !== 'string'))) { errors.push(`${name}: "env" must map names to strings.`); continue; }
    servers[name] = { command: c.command, args: c.args, env: c.env, disabled: c.disabled === true };
  }
  return { servers, errors };
}

export const mcpConfigHash = (name: string, cfg: McpServerConfig): string =>
  createHash('sha1').update(JSON.stringify([name, cfg.command, cfg.args ?? [], cfg.env ?? {}])).digest('hex').slice(0, 16);

/** Minimal MCP client over the stdio transport (newline-delimited JSON-RPC 2.0). */
export class McpClient {
  private proc?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buf = '';
  private stderrTail = '';
  closed = false;
  onClose?: (err: Error) => void;

  constructor(readonly name: string, private cfg: McpServerConfig, private cwd: string) {}

  async start(timeoutMs = 15000): Promise<void> {
    const useShell = process.platform === 'win32' && !/\.exe$/i.test(this.cfg.command);
    const proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      cwd: this.cwd, env: { ...process.env, ...this.cfg.env }, stdio: ['pipe', 'pipe', 'pipe'], shell: useShell, windowsHide: true,
    });
    this.proc = proc;
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (d: string) => this.onData(d));
    proc.stderr!.on('data', (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-2000); });
    proc.stdin!.on('error', () => { /* surfaced through exit/error handlers */ });
    proc.on('error', (e) => this.fail(e));
    proc.on('exit', (code) => this.fail(new Error(`MCP server "${this.name}" exited (code ${code})${this.stderrTail ? `: ${this.stderrTail.trim().slice(-300)}` : ''}`)));
    try {
      await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: CLIENT_INFO }, timeoutMs);
      this.notify('notifications/initialized');
    } catch (e) { this.stop(); throw e; }
  }

  private fail(err: Error): void {
    if (this.closed) { return; }
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
    this.onClose?.(err);
  }

  private onData(chunk: string): void {
    if (this.closed) { return; }
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) { continue; }
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) { p.reject(new Error(`${msg.error.message ?? 'MCP error'}${msg.error.code !== undefined ? ` (${msg.error.code})` : ''}`)); } else { p.resolve(msg.result); }
      } else if (msg.method && msg.id !== undefined) {
        try { this.write({ jsonrpc: '2.0', id: msg.id, ...(msg.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Method not found' } }) }); } catch { /* server went away */ }
      }
    }
  }

  private write(obj: unknown): void {
    if (this.closed || !this.proc?.stdin?.writable) { throw new Error(`MCP server "${this.name}" is not running.`); }
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  private notify(method: string, params?: unknown): void { this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); }

  request(method: string, params: unknown, timeoutMs = 60000, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('Cancelled')); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener('abort', () => {
        if (this.pending.delete(id)) { clearTimeout(timer); try { this.notify('notifications/cancelled', { requestId: id }); } catch { /* gone */ } reject(new Error('Cancelled')); }
      }, { once: true });
      try { this.write({ jsonrpc: '2.0', id, method, params }); } catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e as Error); }
    });
  }

  async listTools(): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await this.request('tools/list', cursor ? { cursor } : {});
      out.push(...(res.tools ?? []));
      cursor = res.nextCursor;
      if (!cursor) { break; }
    }
    return out;
  }

  async callTool(tool: string, args: unknown, signal?: AbortSignal, timeoutMs = 120000): Promise<{ text: string; isError: boolean }> {
    const res = await this.request('tools/call', { name: tool, arguments: args ?? {} }, timeoutMs, signal);
    const parts: string[] = [];
    for (const c of res.content ?? []) {
      if (c.type === 'text') { parts.push(String(c.text)); }
      else if (c.type === 'image') { parts.push('[image omitted]'); }
      else { parts.push(JSON.stringify(c).slice(0, 2000)); }
    }
    return { text: parts.join('\n') || '(no output)', isError: res.isError === true };
  }

  stop(): void {
    const proc = this.proc;
    this.fail(new Error(`MCP server "${this.name}" stopped.`));
    if (!proc?.pid) { return; }
    if (process.platform === 'win32') { try { spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }); } catch { /* already gone */ } }
    else { proc.kill(); }
  }
}

const san = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_');

export function toolName(server: string, tool: string, taken: Set<string>): string {
  let base = `mcp__${san(server)}__${san(tool)}`.slice(0, 64);
  let n = 2;
  while (taken.has(base)) { const suffix = `_${n++}`; base = `${base.slice(0, 64 - suffix.length)}${suffix}`; }
  taken.add(base);
  return base;
}

function toTool(client: McpClient, info: McpToolInfo, name: string): Tool {
  const kind: ToolKind = info.annotations?.readOnlyHint === true ? 'read' : 'exec';
  const schema = info.inputSchema && typeof info.inputSchema === 'object' ? info.inputSchema : { type: 'object', properties: {} };
  return {
    kind,
    spec: { type: 'function', function: { name, description: `[MCP ${client.name}] ${info.description ?? info.name}`.slice(0, 1000), parameters: { type: 'object', ...schema } } },
    describe: (a) => `${client.name}: ${info.name}(${clip(JSON.stringify(a ?? {}), 120)})`,
    async run(a, ctx) {
      const r = await client.callTool(info.name, a, ctx.signal);
      if (r.isError) { throw new Error(clip(r.text)); }
      return clip(r.text);
    },
  };
}

export class McpManager {
  private entries = new Map<string, { client: McpClient; tools: Tool[] }>();
  private statuses: ServerStatus[] = [];

  constructor(private cwd: string) {}

  status(): ServerStatus[] { return this.statuses; }
  tools(): Tool[] { return [...this.entries.values()].flatMap((e) => e.tools); }

  async reload(configs: Record<string, McpServerConfig>, startTimeoutMs = 15000): Promise<ServerStatus[]> {
    this.stopAll();
    const taken = new Set<string>();
    const statuses: ServerStatus[] = [];
    await Promise.all(Object.entries(configs).map(async ([name, cfg], order) => {
      if (cfg.disabled) { statuses[order] = { name, status: 'disabled', tools: 0 }; return; }
      const client = new McpClient(name, cfg, this.cwd);
      try {
        await client.start(startTimeoutMs);
        const infos = await client.listTools();
        const tools = infos.map((i) => toTool(client, i, toolName(name, i.name, taken)));
        this.entries.set(name, { client, tools });
        client.onClose = (err) => {
          this.entries.delete(name);
          const s = this.statuses.find((x) => x.name === name);
          if (s) { s.status = 'error'; s.tools = 0; s.error = err.message; }
        };
        statuses[order] = { name, status: 'connected', tools: tools.length };
      } catch (e: any) {
        client.stop();
        statuses[order] = { name, status: 'error', tools: 0, error: e.message ?? String(e) };
      }
    }));
    this.statuses = statuses.filter(Boolean);
    return this.statuses;
  }

  stopAll(): void {
    for (const { client } of this.entries.values()) { client.onClose = undefined; client.stop(); }
    this.entries.clear();
    this.statuses = [];
  }
}
