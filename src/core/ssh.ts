import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { StringDecoder } from 'string_decoder';
import type { Client, ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2';
import { SKIP_DIRS } from './glob';

/**
 * SSH connections for the agent: one pooled connection per server, verified host keys, commands with time limits
 * and cancellation, and SFTP transfers. The ssh2 library is loaded on first use, so it costs nothing until then.
 */

export interface SshTarget {
  name: string; host: string; port: number; user: string;
  password?: string; privateKey?: string; passphrase?: string;
  env?: Record<string, string>;
}
export interface HostKeyInfo { server: string; host: string; port: number; fingerprint: string }
export interface ExecOptions {
  cwd?: string; timeoutMs?: number; signal?: AbortSignal;
  /** Written to the command's input, e.g. the password for `sudo -S`. */
  stdin?: string;
  onData?(chunk: string): void;
  maxBytes?: number;
}
export interface ExecResult { code: number | null; signal?: string; output: string; timedOut: boolean; cancelled: boolean; truncated: boolean; ms: number }
export interface TransferResult { files: number; bytes: number; skipped: string[] }

export const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const IDLE_CLOSE_MS = 5 * 60_000;
const MAX_TRANSFER_FILES = 5000;
const MAX_TRANSFER_BYTES = 1024 * 1024 * 1024;

export const fingerprintOf = (key: Buffer): string => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

/** Single-quotes a value for a POSIX shell. */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command line actually sent: working directory and environment variables first. */
export function buildRemoteCommand(command: string, cwd?: string, env: Record<string, string> = {}): string {
  // Not named `exports`: in the CommonJS output that local would shadow the module's exports object (and shQuote).
  const envPrefix = Object.entries(env).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, v]) => `export ${k}=${shQuote(v)}; `).join('');
  return `${cwd ? `cd ${shQuote(cwd)} && ` : ''}${envPrefix}${command}`;
}

/** Keeps only the newest bytes of a long output. */
class TailBuffer {
  private parts: string[] = [];
  private size = 0;
  truncated = false;
  constructor(private max: number) {}
  push(s: string): void {
    this.parts.push(s); this.size += s.length;
    while (this.size > this.max && this.parts.length > 1) { this.size -= this.parts.shift()!.length; this.truncated = true; }
    if (this.size > this.max) { const only = this.parts[0]; this.parts[0] = only.slice(only.length - this.max); this.size = this.max; this.truncated = true; }
  }
  text(): string { return this.parts.join(''); }
}

/**
 * Asks the server to KILL the command. ClientChannel.signal() silently does nothing once our side has sent EOF
 * (it checks `writable`), and exec always ends stdin, so send the request at the protocol level while the channel is open.
 */
function sendKill(ch: ClientChannel): void {
  const c = ch as unknown as { outgoing?: { id: number; state: string }; _client?: { _protocol?: { signal(id: number, name: string): void } } };
  try {
    if ((c.outgoing?.state === 'open' || c.outgoing?.state === 'eof') && c._client?._protocol) { c._client._protocol.signal(c.outgoing.id, 'KILL'); } else { ch.signal('KILL'); }
  } catch { /* not supported by every server */ }
}

interface Pooled { client: Client; ready: Promise<Client>; timer?: NodeJS.Timeout; users: number; closed: boolean; signature: string }

export class SshPool {
  private conns = new Map<string, Pooled>();
  readonly connected = new Set<string>();

  constructor(private opts: {
    /** Decides whether to trust the server's host key. Returning false aborts the connection. */
    verifyHostKey(info: HostKeyInfo): Promise<boolean>;
    onStatus?(server: string, connected: boolean): void;
    connectTimeoutMs?: number;
    idleMs?: number;
    loadClient?(): new () => Client;
  }) {}

  private signature(t: SshTarget): string {
    return createHash('sha256').update(JSON.stringify([t.host, t.port, t.user, t.password ?? '', t.privateKey ?? '', t.passphrase ?? ''])).digest('hex');
  }

  /** A ready connection for this server, reusing the open one when its details have not changed. */
  async connect(t: SshTarget): Promise<Client> {
    const signature = this.signature(t);
    const existing = this.conns.get(t.name);
    if (existing && !existing.closed && existing.signature === signature) { return existing.ready; }
    if (existing) { this.drop(t.name); }
    const ClientCtor = this.opts.loadClient?.() ?? (require('ssh2') as typeof import('ssh2')).Client;
    const client = new ClientCtor();
    let hostKeyError: Error | undefined;
    const entry: Pooled = { client, users: 0, closed: false, signature, ready: undefined as unknown as Promise<Client> };
    entry.ready = new Promise<Client>((resolve, reject) => {
      const cfg: ConnectConfig = {
        host: t.host, port: t.port, username: t.user, readyTimeout: this.opts.connectTimeoutMs ?? 20_000,
        keepaliveInterval: 15_000, keepaliveCountMax: 4,
        ...(t.privateKey ? { privateKey: t.privateKey, passphrase: t.passphrase } : { password: t.password }),
        hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
          const fingerprint = fingerprintOf(key);
          this.opts.verifyHostKey({ server: t.name, host: t.host, port: t.port, fingerprint }).then((ok) => {
            if (!ok) { hostKeyError = new Error(`The host key of ${t.name} (${fingerprint}) was not trusted, so the connection was refused.`); }
            verify(ok);
          }, (e) => { hostKeyError = e instanceof Error ? e : new Error(String(e)); verify(false); });
        },
      } as ConnectConfig;
      client.once('ready', () => { this.connected.add(t.name); this.opts.onStatus?.(t.name, true); resolve(client); });
      // `on`, not `once`: a second error (e.g. a keepalive timeout after a reset) must not become an uncaught 'error'.
      client.on('error', (e: Error & { level?: string }) => {
        entry.closed = true;
        const msg = hostKeyError?.message
          ?? (e.level === 'client-authentication' ? `Authentication to ${t.name} failed: check the user name and ${t.privateKey ? 'private key' : 'password'}.` : `Could not connect to ${t.name} (${t.host}:${t.port}): ${e.message}`);
        reject(new Error(msg));
      });
      client.on('close', () => { entry.closed = true; if (this.conns.get(t.name) === entry) { this.conns.delete(t.name); } if (this.connected.delete(t.name)) { this.opts.onStatus?.(t.name, false); } });
      client.connect(cfg);
    });
    this.conns.set(t.name, entry);
    entry.ready.catch(() => { if (this.conns.get(t.name) === entry) { this.conns.delete(t.name); } });
    return entry.ready;
  }

  /** Runs `fn` with a connection; idle connections close themselves after a few minutes. */
  private async use<T>(t: SshTarget, fn: (c: Client) => Promise<T>, retry = true): Promise<T> {
    const before = this.conns.get(t.name);
    const reused = !!before && !before.closed && before.signature === this.signature(t);
    // A failed fresh connection is not retried: that would ask about the host key or try the password twice.
    const client = await this.connect(t);
    const entry = this.conns.get(t.name);
    if (entry) { clearTimeout(entry.timer); entry.users++; }
    try { return await fn(client); } catch (e) {
      // One retry covers a pooled connection the server dropped while it was idle, when nothing was started on it.
      if (retry && reused && (e as { notStarted?: boolean }).notStarted) { this.drop(t.name); return this.use(t, fn, false); }
      throw e;
    } finally {
      if (entry && --entry.users === 0 && !entry.closed) {
        entry.timer = setTimeout(() => this.drop(t.name), this.opts.idleMs ?? IDLE_CLOSE_MS);
        entry.timer.unref?.();
      }
    }
  }

  exec(t: SshTarget, command: string, o: ExecOptions = {}): Promise<ExecResult> {
    return this.use(t, (client) => new Promise<ExecResult>((resolve, reject) => {
      if (o.signal?.aborted) { reject(new Error('Cancelled')); return; }
      const started = Date.now();
      const out = new TailBuffer(o.maxBytes ?? MAX_OUTPUT_BYTES);
      let timedOut = false, cancelled = false, settled = false, channel: ClientChannel | undefined;
      // Kill first and close a moment later: closing at once can reach the server before the signal, and a command
      // without a terminal keeps running after its channel closes.
      const stop = () => {
        const ch = channel;
        if (!ch) { return; }
        sendKill(ch);
        setTimeout(() => { try { ch.close(); } catch { /* already closed */ } }, 300).unref?.();
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const onAbort = () => { cancelled = true; stop(); };
      o.signal?.addEventListener('abort', onAbort, { once: true });
      const finish = (code: number | null, sig?: string) => {
        if (settled) { return; }
        settled = true; clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort);
        resolve({ code, signal: sig, output: out.text(), timedOut, cancelled, truncated: out.truncated, ms: Date.now() - started });
      };
      const notStarted = (err: Error) => {
        clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); settled = true;
        reject(Object.assign(new Error(`Could not start the command on ${t.name}: ${err.message}`), { notStarted: true }));
      };
      // client.exec throws synchronously ("Not connected") when the socket is already gone.
      try { client.exec(buildRemoteCommand(command, o.cwd, t.env), (err, ch) => {
        if (err) { notStarted(err); return; }
        channel = ch;
        // One decoder per stream so a multi-byte character split across packets is not garbled.
        const reader = (dec: StringDecoder) => (b: Buffer) => { const s = dec.write(b); if (s) { out.push(s); o.onData?.(s); } };
        ch.on('data', reader(new StringDecoder('utf8')));
        ch.stderr.on('data', reader(new StringDecoder('utf8')));
        let code: number | null = null, sig: string | undefined;
        ch.on('exit', (c: number | null, s?: string) => { code = c; sig = s ?? undefined; });
        ch.on('close', () => finish(code, sig));
        if (o.stdin !== undefined) { ch.write(o.stdin); }
        ch.end();
        if (cancelled) { stop(); }
      }); } catch (e) { notStarted(e instanceof Error ? e : new Error(String(e))); }
    }));
  }

  private sftp(client: Client): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      const fail = (e: Error) => reject(Object.assign(new Error(`SFTP is not available: ${e.message}`), { notStarted: true }));
      try { client.sftp((e, s) => (e ? fail(e) : resolve(s))); } catch (e) { fail(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  private static mkdirp(sftp: SFTPWrapper, dir: string): Promise<void> {
    const parts = dir.split('/').filter(Boolean);
    let cur = dir.startsWith('/') ? '' : '.';
    return parts.reduce((p, part) => p.then(() => new Promise<void>((resolve, reject) => {
      cur = `${cur}/${part}`;
      const target = cur;
      sftp.stat(target, (e, st) => {
        if (!e) { if (st.isDirectory()) { resolve(); } else { reject(new Error(`${target} exists and is not a folder.`)); } return; }
        sftp.mkdir(target, (e2) => (e2 ? sftp.stat(target, (e3) => (e3 ? reject(new Error(`Could not create ${target}: ${e2.message}`)) : resolve())) : resolve()));
      });
    })), Promise.resolve());
  }

  /** Uploads a file or a folder (skipping .git, node_modules and similar). Folders keep their structure. */
  upload(t: SshTarget, localAbs: string, remotePath: string, signal?: AbortSignal): Promise<TransferResult> {
    return this.use(t, async (client) => {
      const sftp = await this.sftp(client);
      try {
        const st = await fs.stat(localAbs);
        const files: Array<{ abs: string; rel: string; size: number }> = [];
        const skipped: string[] = [];
        if (st.isDirectory()) {
          const walk = async (dir: string, rel: string): Promise<void> => {
            for (const e of await fs.readdir(dir, { withFileTypes: true })) {
              if (signal?.aborted) { throw new Error('Cancelled'); }
              const r = rel ? `${rel}/${e.name}` : e.name;
              if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) { skipped.push(`${r}/`); } else { await walk(path.join(dir, e.name), r); } }
              else if (e.isFile()) { files.push({ abs: path.join(dir, e.name), rel: r, size: (await fs.stat(path.join(dir, e.name))).size }); }
              if (files.length > MAX_TRANSFER_FILES) { throw new Error(`More than ${MAX_TRANSFER_FILES} files: upload an archive instead.`); }
            }
          };
          await walk(localAbs, '');
        } else { files.push({ abs: localAbs, rel: '', size: st.size }); }
        const bytes = files.reduce((n, f) => n + f.size, 0);
        if (bytes > MAX_TRANSFER_BYTES) { throw new Error('The upload is larger than 1 GB.'); }
        const base = remotePath.replace(/\/+$/, '') || '/';
        const target = (rel: string) => (rel ? `${base}/${rel}` : base);
        const dirs = new Set(files.map((f) => path.posix.dirname(target(f.rel))));
        for (const d of [...dirs].sort()) { await SshPool.mkdirp(sftp, d); }
        for (const f of files) {
          if (signal?.aborted) { throw new Error('Cancelled'); }
          await new Promise<void>((resolve, reject) => sftp.fastPut(f.abs, target(f.rel), (e) => (e ? reject(new Error(`Upload of ${f.rel || path.basename(f.abs)} failed: ${e.message}`)) : resolve())));
        }
        return { files: files.length, bytes, skipped };
      } finally { sftp.end(); }
    });
  }

  /** Downloads a remote file or folder into `localAbs`. `beforeWrite` runs for every local file first (checkpoints). */
  download(t: SshTarget, remotePath: string, localAbs: string, beforeWrite?: (abs: string) => Promise<void>, signal?: AbortSignal): Promise<TransferResult> {
    return this.use(t, async (client) => {
      const sftp = await this.sftp(client);
      const stat = (p: string) => new Promise<import('ssh2').Stats>((resolve, reject) => sftp.stat(p, (e, s) => (e ? reject(new Error(`${p}: ${e.message}`)) : resolve(s))));
      const list = (p: string) => new Promise<import('ssh2').FileEntry[]>((resolve, reject) => sftp.readdir(p, (e, l) => (e ? reject(new Error(`${p}: ${e.message}`)) : resolve(l))));
      try {
        const files: Array<{ remote: string; local: string; size: number }> = [];
        const skipped: string[] = [];
        const walk = async (remote: string, local: string): Promise<void> => {
          for (const e of await list(remote)) {
            if (signal?.aborted) { throw new Error('Cancelled'); }
            const r = `${remote.replace(/\/+$/, '')}/${e.filename}`;
            // Directory entries carry only the raw mode bits, so the file type is read from them.
            const type = e.attrs.mode & 0o170000;
            if (type === 0o040000) { if (SKIP_DIRS.has(e.filename)) { skipped.push(`${r}/`); } else { await walk(r, path.join(local, e.filename)); } }
            else if (type === 0o100000) { files.push({ remote: r, local: path.join(local, e.filename), size: e.attrs.size }); }
            if (files.length > MAX_TRANSFER_FILES) { throw new Error(`More than ${MAX_TRANSFER_FILES} files: download an archive instead.`); }
          }
        };
        const st = await stat(remotePath);
        if (st.isDirectory()) { await walk(remotePath, localAbs); } else { files.push({ remote: remotePath, local: localAbs, size: st.size }); }
        const bytes = files.reduce((n, f) => n + f.size, 0);
        if (bytes > MAX_TRANSFER_BYTES) { throw new Error('The download is larger than 1 GB.'); }
        for (const f of files) {
          if (signal?.aborted) { throw new Error('Cancelled'); }
          await beforeWrite?.(f.local);
          await fs.mkdir(path.dirname(f.local), { recursive: true });
          await new Promise<void>((resolve, reject) => sftp.fastGet(f.remote, f.local, (e) => (e ? reject(new Error(`Download of ${f.remote} failed: ${e.message}`)) : resolve())));
        }
        return { files: files.length, bytes, skipped };
      } finally { sftp.end(); }
    });
  }

  readFile(t: SshTarget, remotePath: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
    return this.use(t, async (client) => {
      const sftp = await this.sftp(client);
      try {
        const size = await new Promise<number>((resolve, reject) => sftp.stat(remotePath, (e, s) => (e ? reject(new Error(`${remotePath}: ${e.message}`)) : s.isFile() ? resolve(s.size) : reject(new Error(`${remotePath} is not a file.`)))));
        if (size > maxBytes) { throw new Error(`${remotePath} is ${Math.round(size / 1024)} KB; read part of it with remote_exec (for example tail -n 200).`); }
        const buf = await new Promise<Buffer>((resolve, reject) => sftp.readFile(remotePath, (e, b) => (e ? reject(new Error(`${remotePath}: ${e.message}`)) : resolve(b))));
        if (buf.includes(0)) { throw new Error(`${remotePath} is a binary file.`); }
        return buf.toString('utf8');
      } finally { sftp.end(); }
    });
  }

  private drop(name: string): void {
    const e = this.conns.get(name);
    if (!e) { return; }
    clearTimeout(e.timer);
    this.conns.delete(name);
    e.closed = true;
    try { e.client.end(); } catch { /* already closed */ }
    if (this.connected.delete(name)) { this.opts.onStatus?.(name, false); }
  }

  close(name: string): void { this.drop(name); }
  dispose(): void { for (const name of [...this.conns.keys()]) { this.drop(name); } }
}
