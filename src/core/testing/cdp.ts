import { ChildProcess, execFile, spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { Socket } from 'net';
import type { Readable, Writable } from 'stream';

/* ------------------------------------------------------------------ transports */

/** A message channel to the browser: the debugging pipe, or a WebSocket on a localhost debugging port. */
export interface Transport {
  send(text: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: (err: Error) => void): void;
  close(): void;
}

/** --remote-debugging-pipe: JSON messages separated by NUL bytes on file descriptors 3 (to the browser) and 4 (from it). */
export function pipeTransport(out: Writable, input: Readable): Transport {
  let onMsg: (t: string) => void = () => undefined;
  let onEnd: (e: Error) => void = () => undefined;
  // Only the newest chunk is searched for the separator, so a 10 MB screenshot is not rescanned chunk after chunk.
  let parts: string[] = [];
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    let start = 0, i: number;
    while ((i = chunk.indexOf('\0', start)) >= 0) {
      parts.push(chunk.slice(start, i));
      const msg = parts.join('');
      parts = [];
      onMsg(msg);
      start = i + 1;
    }
    if (start < chunk.length) { parts.push(chunk.slice(start)); }
  });
  input.on('close', () => onEnd(new Error('The browser closed the connection.')));
  input.on('error', (e) => onEnd(e));
  out.on('error', (e) => onEnd(e));
  return { send: (t) => { out.write(t + '\0'); }, onMessage: (cb) => { onMsg = cb; }, onClose: (cb) => { onEnd = cb; }, close: () => { out.end(); } };
}

/**
 * A minimal RFC 6455 WebSocket client (text frames, fragmentation, ping/pong, close) — enough for the DevTools protocol,
 * and it works on every Node version VS Code ships (Node 20 has no built-in WebSocket).
 */
export function connectWebSocket(url: string, timeoutMs = 10_000): Promise<Transport> {
  const u = new URL(url);
  const key = randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, timeout: timeoutMs, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } });
    req.on('upgrade', (res, socket: Socket, head: Buffer) => {
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (res.headers['sec-websocket-accept'] !== accept) { socket.destroy(); reject(new Error('The browser answered the WebSocket handshake incorrectly.')); return; }
      resolve(wsTransport(socket, head));
    });
    req.on('response', (res) => { res.resume(); reject(new Error(`The browser refused the debugging connection (HTTP ${res.statusCode}).`)); });
    req.on('timeout', () => req.destroy(new Error('Timed out connecting to the browser.')));
    req.on('error', reject);
    req.end();
  });
}

function wsTransport(socket: Socket, head: Buffer): Transport {
  let onMsg: (t: string) => void = () => undefined;
  let onEnd: (e: Error) => void = () => undefined;
  let chunks: Buffer[] = head.length ? [head] : [];
  let total = head.length;
  let frags: Buffer[] = [];
  let ended = false;
  const end = (e: Error) => { if (!ended) { ended = true; onEnd(e); } };

  const frame = (op: number, payload: Buffer) => {
    const len = payload.length;
    const header = len < 126 ? Buffer.from([0x80 | op, 0x80 | len])
      : len < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, len >> 8, len & 0xff])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
    // Client frames must be masked.
    const mask = randomBytes(4);
    const body = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) { body[i] = payload[i] ^ mask[i & 3]; }
    socket.write(Buffer.concat([header, mask, body]));
  };

  /** Merges the buffered chunks only when a whole frame is there, so large messages are copied about once. */
  const pump = () => {
    for (;;) {
      if (total < 2) { return; }
      if (chunks.length > 1 && chunks[0].length < 14) { chunks = [Buffer.concat(chunks)]; }
      const b = chunks[0];
      const op = b[0] & 0x0f, fin = (b[0] & 0x80) !== 0, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) { return; } len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) { return; } len = Number(b.readBigUInt64BE(2)); off = 10; }
      const maskOff = off;
      if (masked) { off += 4; }
      if (total < off + len) { return; }
      const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
      let payload = all.subarray(off, off + len);
      if (masked) { payload = Buffer.from(payload); for (let i = 0; i < len; i++) { payload[i] ^= all[maskOff + (i & 3)]; } }
      const rest = all.subarray(off + len);
      chunks = rest.length ? [rest] : [];
      total = rest.length;
      if (op === 0x8) { try { frame(0x8, Buffer.alloc(0)); } catch { /* closing */ } socket.end(); end(new Error('The browser closed the connection.')); return; }
      if (op === 0x9) { frame(0xa, payload); continue; }
      if (op === 0xa) { continue; }
      frags.push(payload);
      if (fin) { const text = Buffer.concat(frags).toString('utf8'); frags = []; onMsg(text); }
    }
  };

  socket.setNoDelay(true);
  socket.on('data', (d: Buffer) => { chunks.push(d); total += d.length; pump(); });
  socket.on('close', () => end(new Error('The browser closed the connection.')));
  socket.on('error', (e) => end(e));
  return {
    send: (t) => frame(0x1, Buffer.from(t, 'utf8')),
    onMessage: (cb) => { onMsg = cb; if (total) { setImmediate(pump); } },
    onClose: (cb) => { onEnd = cb; },
    close: () => { try { frame(0x8, Buffer.alloc(0)); } catch { /* already closed */ } socket.end(); },
  };
}

/* ------------------------------------------------------------------ protocol */

/** Chrome DevTools Protocol over any transport: request/response by id, events to listeners. */
export class CdpConnection {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private listeners = new Set<(method: string, params: any, sessionId?: string) => void>();
  private closedError?: Error;

  constructor(private transport: Transport) {
    transport.onMessage((raw) => this.onMessage(raw));
    transport.onClose((e) => this.close(e));
  }

  private onMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) { return; }
      this.pending.delete(msg.id);
      if (msg.error) { p.reject(new Error(`${p.method}: ${msg.error.message ?? 'failed'}${msg.error.data ? ` (${msg.error.data})` : ''}`)); } else { p.resolve(msg.result ?? {}); }
    } else if (msg.method) {
      for (const l of this.listeners) { try { l(msg.method, msg.params ?? {}, msg.sessionId); } catch { /* a listener bug must not break the connection */ } }
    }
  }

  send(method: string, params: object = {}, sessionId?: string, timeoutMs = 30_000): Promise<any> {
    if (this.closedError) { return Promise.reject(this.closedError); }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
      this.pending.set(id, { method, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      try { this.transport.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); } catch (e: any) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  on(listener: (method: string, params: any, sessionId?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get closed(): boolean { return !!this.closedError; }

  close(err = new Error('The browser connection is closed.')): void {
    if (this.closedError) { return; }
    this.closedError = err;
    for (const p of this.pending.values()) { p.reject(err); }
    this.pending.clear();
    try { this.transport.close(); } catch { /* already gone */ }
  }
}

/* ------------------------------------------------------------------ finding and launching */

/** Chrome, Edge and Chromium in their usual install places. The first one that exists wins. */
export function browserCandidates(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(Boolean) as string[];
    const rel = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'Chromium\\Application\\chrome.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'];
    return rel.flatMap((r) => roots.map((root) => path.win32.join(root, r)));
  }
  if (platform === 'darwin') {
    return ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser'].map((n) => `/Applications/${n}.app/Contents/MacOS/${n}`);
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable']
    .flatMap((n) => ['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome'].map((d) => `${d}/${n}`));
}

export function findBrowser(configured?: string): string | undefined {
  if (configured) { return fs.existsSync(configured) ? configured : undefined; }
  return browserCandidates().find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

/**
 * pipe: debugging pipe on a child process (no open port) — the default.
 * port: a child process with a localhost debugging port.
 * detached: Windows only — started by the system (WMI) outside the caller's process tree, with a localhost debugging port.
 *   VS Code's extension host on Windows runs in a job object, and Chrome refuses remote debugging for any process
 *   started inside it ("requires a non-default data directory"), whichever transport is used.
 */
export type LaunchMode = 'pipe' | 'port' | 'detached';

export interface LaunchOptions { executable: string; headless: boolean; width: number; height: number; extraArgs?: string[]; ignoreHttpsErrors?: boolean; mode?: LaunchMode }

export interface LaunchedBrowser { cdp: CdpConnection; mode: LaunchMode; pid?: number; profileDir: string; kill(): Promise<void> }

/** The refusal Chrome prints when it will not allow remote debugging from where it was started. */
const REFUSED = /requires a non-default data directory/i;

/** The mode to try first here: inside VS Code's extension host on Windows only a detached browser can be debugged. */
export function defaultLaunchMode(platform = process.platform, proc: { type?: string } = process as any): LaunchMode {
  return platform === 'win32' && proc.type === 'utility' ? 'detached' : 'pipe';
}

export function browserArgs(o: LaunchOptions, profileDir: string, transport: 'pipe' | 'port'): string[] {
  return [
    transport === 'pipe' ? '--remote-debugging-pipe' : '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync',
    '--disable-component-update', '--disable-default-apps', '--metrics-recording-only', '--mute-audio', '--disable-features=Translate,MediaRouter',
    '--password-store=basic', `--window-size=${o.width},${o.height}`,
    ...(o.headless ? ['--headless=new', '--hide-scrollbars'] : []),
    ...(o.ignoreHttpsErrors ? ['--ignore-certificate-errors'] : []),
    // Chrome refuses to run as root (Linux CI containers) unless its sandbox is off.
    ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : []),
    ...(o.extraArgs ?? []), 'about:blank',
  ];
}

/** Starts the browser with a throw-away profile, so tests never see (or change) the user's cookies and logins. */
export async function launchBrowser(o: LaunchOptions): Promise<LaunchedBrowser> {
  const first = o.mode ?? defaultLaunchMode();
  try {
    return await launchWith(o, first);
  } catch (e: any) {
    // Started inside a job (or similar) where Chrome refuses debugging: retry outside it, or on a port.
    if (!o.mode && first === 'pipe' && e?.refused) { return launchWith(o, process.platform === 'win32' ? 'detached' : 'port'); }
    throw e;
  }
}

async function launchWith(o: LaunchOptions, mode: LaunchMode): Promise<LaunchedBrowser> {
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'infraon-browser-'));
  const cleanup = () => fsp.rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  try {
    return mode === 'pipe' ? await launchPipe(o, profileDir, cleanup) : await launchPort(o, profileDir, cleanup, mode);
  } catch (e) {
    await cleanup();
    throw e;
  }
}

async function launchPipe(o: LaunchOptions, profileDir: string, cleanup: () => Promise<unknown>): Promise<LaunchedBrowser> {
  const proc = spawn(o.executable, browserArgs(o, profileDir, 'pipe'), { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  let refusedNow: () => void = () => undefined;
  const refused = new Promise<never>((_, reject) => { refusedNow = () => reject(Object.assign(new Error('The browser refused remote debugging here.'), { refused: true })); });
  refused.catch(() => undefined);
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (d: string) => { stderr = (stderr + d).slice(-4000); if (REFUSED.test(stderr)) { refusedNow(); } });
  const cdp = new CdpConnection(pipeTransport(proc.stdio[3] as Writable, proc.stdio[4] as Readable));
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  proc.once('exit', (code) => cdp.close(new Error(`The browser exited${code ? ` with code ${code}` : ''}.${stderr.trim() ? ` ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`)));
  const failed = new Promise<never>((_, reject) => proc.once('error', (e) => reject(new Error(`Could not start the browser at ${o.executable}: ${e.message}`))));
  const kill = async () => {
    await stopBrowser(cdp, proc.pid, () => exited);
    await cleanup();
  };
  try {
    await Promise.race([cdp.send('Browser.getVersion', {}, undefined, 20_000), failed, refused]);
  } catch (e) {
    cdp.close();
    if (proc.exitCode === null) { proc.kill(); await Promise.race([exited, delay(3000)]); }
    throw e;
  }
  return { cdp, mode: 'pipe', pid: proc.pid, profileDir, kill };
}

async function launchPort(o: LaunchOptions, profileDir: string, cleanup: () => Promise<unknown>, mode: 'port' | 'detached'): Promise<LaunchedBrowser> {
  const args = browserArgs(o, profileDir, 'port');
  let proc: ChildProcess | undefined;
  let pid: number | undefined;
  if (mode === 'detached') {
    if (process.platform !== 'win32') { throw new Error('Detached launch is only for Windows.'); }
    pid = await createProcessViaWmi(windowsCommandLine([o.executable, ...args]));
  } else {
    proc = spawn(o.executable, args, { stdio: 'ignore', windowsHide: true });
    pid = proc.pid;
    await new Promise<void>((resolve, reject) => { proc!.once('spawn', resolve); proc!.once('error', (e) => reject(new Error(`Could not start the browser at ${o.executable}: ${e.message}`))); });
  }
  const alive = () => (proc ? proc.exitCode === null : isAlive(pid));
  try {
    const target = await waitForDevToolsPort(profileDir, alive, 30_000);
    const cdp = new CdpConnection(await connectWebSocket(`ws://127.0.0.1:${target.port}${target.path}`));
    // A detached browser is not our child: notice when it goes away.
    const watch = setInterval(() => { if (!alive()) { cdp.close(new Error('The browser exited.')); } }, 2000);
    watch.unref?.();
    proc?.once('exit', () => cdp.close(new Error('The browser exited.')));
    await cdp.send('Browser.getVersion', {}, undefined, 20_000);
    const kill = async () => {
      clearInterval(watch);
      await stopBrowser(cdp, pid, () => waitUntil(() => !alive(), 5000));
      await cleanup();
    };
    return { cdp, mode, pid, profileDir, kill };
  } catch (e) {
    if (pid && alive()) { try { process.kill(pid); } catch { /* gone */ } await waitUntil(() => !alive(), 3000); }
    throw e;
  }
}

/** Closes the browser politely (so it can flush and release the profile), and forcibly if it does not go. */
async function stopBrowser(cdp: CdpConnection, pid: number | undefined, gone: () => Promise<unknown>): Promise<void> {
  if (!cdp.closed) { await cdp.send('Browser.close', {}, undefined, 3000).catch(() => undefined); }
  cdp.close();
  const done = await Promise.race([gone().then(() => true), delay(4000).then(() => false)]);
  if (!done && pid && isAlive(pid)) { try { process.kill(pid); } catch { /* gone */ } await Promise.race([gone(), delay(3000)]); }
}

/** Chrome writes "<port>\n<browser target path>" to DevToolsActivePort in the profile once it is listening. */
export async function waitForDevToolsPort(profileDir: string, alive: () => boolean, timeoutMs: number): Promise<{ port: number; path: string }> {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const [port, p] = (await fsp.readFile(file, 'utf8')).split(/\r?\n/);
      if (Number(port) > 0 && p) { return { port: Number(port), path: p.trim() }; }
    } catch { /* not written yet */ }
    if (!alive()) { throw new Error('The browser exited before it was ready.'); }
    await delay(150);
  }
  throw new Error(`The browser did not open its debugging port within ${Math.round(timeoutMs / 1000)} s.`);
}

/** Windows command-line quoting (CommandLineToArgvW rules) for a process started by the system. */
export function windowsCommandLine(args: string[]): string {
  return args.map((a) => {
    if (a && !/[\s"]/.test(a)) { return a; }
    let out = '"', slashes = 0;
    for (const ch of a) {
      if (ch === '\\') { slashes++; continue; }
      out += ch === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + ch;
      slashes = 0;
    }
    return out + '\\'.repeat(slashes * 2) + '"';
  }).join(' ');
}

/** Starts a process through WMI (Win32_Process.Create): same user, but outside the caller's job object. Returns its pid. */
function createProcessViaWmi(commandLine: string): Promise<number> {
  const script = `$ErrorActionPreference='Stop'; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}' }; Write-Output "$($r.ReturnValue) $($r.ProcessId)"`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
      const [code, pid] = String(stdout).trim().split(/\s+/).map(Number);
      if (err || code !== 0 || !pid) {
        reject(new Error(`Could not start the browser outside VS Code (Windows WMI${code ? ` error ${code}` : ''}): ${String(stderr || err?.message || stdout).trim().split('\n')[0]}. Set infraonAssistant.testing.browserPath, or check that PowerShell and WMI are allowed on this machine.`));
        return;
      }
      resolve(pid);
    });
  });
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isAlive = (pid: number | undefined) => { if (!pid) { return false; } try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; } };
async function waitUntil(cond: () => boolean, ms: number): Promise<void> { const end = Date.now() + ms; while (!cond() && Date.now() < end) { await delay(100); } }
