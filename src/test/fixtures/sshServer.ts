import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { createHash, timingSafeEqual } from 'crypto';
import type { Connection, ServerChannel, SFTPWrapper } from 'ssh2';

/**
 * A small in-process SSH server for tests: password and public-key login, `exec` in a real local shell inside a temp
 * "remote root" folder, and an SFTP subsystem backed by that folder. Listens on 127.0.0.1 only.
 */

export interface TestSshServer {
  port: number;
  hostKeyFingerprint: string;
  /** The temp folder that SFTP "/" maps to and where commands start. */
  root: string;
  /** Number of client connections accepted so far. */
  connections(): number;
  /** Signals received from clients, e.g. ['KILL']. Note ssh2's Server drops channel requests sent after the client's EOF. */
  signals: string[];
  /** Drops every open client connection (to test reconnecting). */
  dropAll(): void;
  close(): Promise<void>;
}

export interface TestSshServerOptions {
  user?: string;
  password?: string;
  /** Public keys (OpenSSH format) accepted for `user`. */
  authorizedKeys?: string[];
}

/** The shell used for `exec`: Git Bash on Windows, /bin/sh elsewhere. Undefined when none is found. */
export function findShell(): string | undefined {
  const candidates = process.platform === 'win32'
    ? [process.env.TEST_BASH, 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe', path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe')]
    : ['/bin/sh', '/usr/bin/sh'];
  return candidates.find((c): c is string => !!c && fs.existsSync(c));
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) { return; }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => { /* ignore */ });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }
}

const safeEq = (a: string, b: string): boolean => {
  const x = createHash('sha256').update(a).digest(), y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y) && a === b;
};

export async function startSshServer(o: TestSshServerOptions = {}): Promise<TestSshServer> {
  const ssh2 = require('ssh2') as typeof import('ssh2');
  const { utils } = ssh2;
  const { STATUS_CODE, OPEN_MODE } = utils.sftp;
  const user = o.user ?? 'tester';
  const hostKey = utils.generateKeyPairSync('ed25519');
  const hostPub = utils.parseKey(hostKey.public);
  if (hostPub instanceof Error) { throw hostPub; }
  const hostKeyFingerprint = `SHA256:${createHash('sha256').update(hostPub.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  const allowed = (o.authorizedKeys ?? []).map((k) => {
    const p = utils.parseKey(k);
    if (p instanceof Error) { throw p; }
    return p;
  });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ica-sshroot-')));
  const shell = findShell();
  const clients = new Set<Connection>();
  const children = new Set<ChildProcess>();
  const signals: string[] = [];
  let accepted = 0;

  /** Maps a remote path to a local one inside root; throws on escapes. */
  const local = (p: string): string => {
    const norm = path.posix.normalize(`/${String(p).replace(/\\/g, '/')}`);
    const abs = path.resolve(root, `.${norm}`);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) { throw new Error('outside root'); }
    return abs;
  };
  const remoteOf = (abs: string): string => `/${path.relative(root, abs).split(path.sep).join('/')}`.replace(/\/+$/, '') || '/';
  const attrsOf = (st: fs.Stats) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });

  const runExec = (stream: ServerChannel, command: string): void => {
    if (!shell) { stream.stderr.write('no shell available\n'); stream.exit(127); stream.end(); return; }
    const child = spawn(shell, ['-c', command], { cwd: root, env: { ...process.env, HOME: root }, detached: process.platform !== 'win32', windowsHide: true });
    children.add(child);
    let done = false;
    child.stdout.on('data', (b: Buffer) => { try { stream.write(b); } catch { /* channel gone */ } });
    child.stderr.on('data', (b: Buffer) => { try { stream.stderr.write(b); } catch { /* channel gone */ } });
    child.stdin.on('error', () => { /* child exited before reading */ });
    stream.on('data', (b: Buffer) => { child.stdin.write(b); });
    stream.on('end', () => { child.stdin.end(); });
    stream.on('close', () => { if (!done) { killTree(child); } });
    stream.on('error', () => { killTree(child); });
    (stream as unknown as { killChild?: () => void }).killChild = () => killTree(child);
    child.on('error', (e) => { done = true; children.delete(child); try { stream.stderr.write(`${e.message}\n`); stream.exit(127); stream.end(); } catch { /* gone */ } });
    child.on('close', (code, sig) => {
      done = true; children.delete(child);
      try {
        if (sig) { stream.exit(sig.replace(/^SIG/, ''), false, ''); } else { stream.exit(code ?? 0); }
        stream.end();
      } catch { /* channel gone */ }
    });
  };

  const serveSftp = (sftp: SFTPWrapper): void => {
    const handles = new Map<number, { fd?: number; dir?: string; listed?: boolean }>();
    let nextHandle = 1;
    const newHandle = (h: { fd?: number; dir?: string }): Buffer => { const id = nextHandle++; handles.set(id, h); const b = Buffer.alloc(4); b.writeUInt32BE(id); return b; };
    const getHandle = (b: Buffer) => (b.length === 4 ? handles.get(b.readUInt32BE(0)) : undefined);
    const fail = (reqid: number, e: unknown) => {
      const code = (e as NodeJS.ErrnoException)?.code;
      sftp.status(reqid, code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : code === 'EACCES' || code === 'EPERM' ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE, (e as Error)?.message);
    };
    sftp.on('OPEN', (reqid, filename, flags) => {
      try {
        let mode = 'r';
        if (flags & OPEN_MODE.WRITE) {
          mode = flags & OPEN_MODE.APPEND ? 'a' : (flags & OPEN_MODE.TRUNC ? 'w' : 'r+');
          if (flags & OPEN_MODE.READ) { mode = mode === 'w' ? 'w+' : mode === 'a' ? 'a+' : 'r+'; }
          if (mode.startsWith('r') && flags & OPEN_MODE.CREAT && !fs.existsSync(local(filename))) { mode = 'w+'; }
          if (flags & OPEN_MODE.EXCL) { mode = mode.replace(/^(w|a)/, '$1x'); }
        }
        sftp.handle(reqid, newHandle({ fd: fs.openSync(local(filename), mode) }));
      } catch (e) { fail(reqid, e); }
    });
    sftp.on('READ', (reqid, handle, offset, length) => {
      const h = getHandle(handle);
      if (h?.fd === undefined) { sftp.status(reqid, STATUS_CODE.FAILURE); return; }
      try {
        const buf = Buffer.alloc(Math.min(length, 256 * 1024));
        const n = fs.readSync(h.fd, buf, 0, buf.length, offset);
        if (n === 0) { sftp.status(reqid, STATUS_CODE.EOF); } else { sftp.data(reqid, buf.subarray(0, n)); }
      } catch (e) { fail(reqid, e); }
    });
    sftp.on('WRITE', (reqid, handle, offset, data) => {
      const h = getHandle(handle);
      if (h?.fd === undefined) { sftp.status(reqid, STATUS_CODE.FAILURE); return; }
      try { fs.writeSync(h.fd, data, 0, data.length, offset); sftp.status(reqid, STATUS_CODE.OK); } catch (e) { fail(reqid, e); }
    });
    sftp.on('CLOSE', (reqid, handle) => {
      const h = getHandle(handle);
      if (!h) { sftp.status(reqid, STATUS_CODE.FAILURE); return; }
      handles.delete(handle.readUInt32BE(0));
      try { if (h.fd !== undefined) { fs.closeSync(h.fd); } sftp.status(reqid, STATUS_CODE.OK); } catch (e) { fail(reqid, e); }
    });
    sftp.on('FSTAT', (reqid, handle) => {
      const h = getHandle(handle);
      if (h?.fd === undefined) { sftp.status(reqid, STATUS_CODE.FAILURE); return; }
      try { sftp.attrs(reqid, attrsOf(fs.fstatSync(h.fd))); } catch (e) { fail(reqid, e); }
    });
    const stat = (reqid: number, p: string) => { try { sftp.attrs(reqid, attrsOf(fs.statSync(local(p)))); } catch (e) { fail(reqid, e); } };
    sftp.on('STAT', stat);
    sftp.on('LSTAT', stat);
    sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
    sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
    sftp.on('MKDIR', (reqid, p) => { try { fs.mkdirSync(local(p)); sftp.status(reqid, STATUS_CODE.OK); } catch (e) { fail(reqid, e); } });
    sftp.on('RMDIR', (reqid, p) => { try { fs.rmdirSync(local(p)); sftp.status(reqid, STATUS_CODE.OK); } catch (e) { fail(reqid, e); } });
    sftp.on('REMOVE', (reqid, p) => { try { fs.unlinkSync(local(p)); sftp.status(reqid, STATUS_CODE.OK); } catch (e) { fail(reqid, e); } });
    sftp.on('RENAME', (reqid, a, b) => { try { fs.renameSync(local(a), local(b)); sftp.status(reqid, STATUS_CODE.OK); } catch (e) { fail(reqid, e); } });
    sftp.on('OPENDIR', (reqid, p) => {
      try {
        const dir = local(p);
        if (!fs.statSync(dir).isDirectory()) { sftp.status(reqid, STATUS_CODE.FAILURE, 'not a directory'); return; }
        sftp.handle(reqid, newHandle({ dir }));
      } catch (e) { fail(reqid, e); }
    });
    sftp.on('READDIR', (reqid, handle) => {
      const h = getHandle(handle);
      if (!h?.dir) { sftp.status(reqid, STATUS_CODE.FAILURE); return; }
      if (h.listed) { sftp.status(reqid, STATUS_CODE.EOF); return; }
      h.listed = true;
      try {
        const names = fs.readdirSync(h.dir).map((name) => {
          const st = fs.statSync(path.join(h.dir!, name));
          return { filename: name, longname: `${st.isDirectory() ? 'd' : '-'}rw-r--r-- 1 0 0 ${st.size} Jan 1 00:00 ${name}`, attrs: attrsOf(st) };
        });
        if (names.length) { sftp.name(reqid, names); } else { sftp.status(reqid, STATUS_CODE.EOF); }
      } catch (e) { fail(reqid, e); }
    });
    sftp.on('REALPATH', (reqid, p) => {
      try { const abs = local(p); sftp.name(reqid, [{ filename: remoteOf(abs), longname: remoteOf(abs), attrs: {} as never }]); } catch (e) { fail(reqid, e); }
    });
    sftp.on('end', () => { for (const h of handles.values()) { if (h.fd !== undefined) { try { fs.closeSync(h.fd); } catch { /* closed */ } } } handles.clear(); });
  };

  const server = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
    accepted++;
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => { /* client went away */ });
    client.on('authentication', (ctx) => {
      if (ctx.username !== user) { ctx.reject(); return; }
      if (ctx.method === 'password' && o.password !== undefined) {
        if (safeEq(ctx.password, o.password)) { ctx.accept(); } else { ctx.reject(); }
        return;
      }
      if (ctx.method === 'publickey') {
        const key = allowed.find((k) => k.type === ctx.key.algo && k.getPublicSSH().equals(ctx.key.data));
        if (!key) { ctx.reject(); return; }
        if (!ctx.signature) { ctx.accept(); return; } // key query: "would this key be accepted?"
        if (key.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true) { ctx.accept(); } else { ctx.reject(); }
        return;
      }
      ctx.reject(['password', 'publickey'].filter((m) => (m === 'password' ? o.password !== undefined : allowed.length > 0)) as never);
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        let current: ServerChannel | undefined;
        session.on('exec', (accept, _reject, info) => { current = accept(); runExec(current, info.command); });
        session.on('signal', (accept, _reject, info) => {
          signals.push(info.name);
          (current as unknown as { killChild?: () => void } | undefined)?.killChild?.();
          accept?.();
        });
        session.on('env', (accept) => accept?.());
        session.on('sftp', (accept) => serveSftp(accept()));
      });
    });
  });

  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const port = (server.address() as { port: number }).port;

  return {
    port, hostKeyFingerprint, root, signals,
    connections: () => accepted,
    dropAll() { for (const c of clients) { try { c.end(); } catch { /* gone */ } } },
    async close() {
      for (const ch of children) { killTree(ch); }
      for (const c of clients) { try { c.end(); } catch { /* gone */ } }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Give killed shells a moment to release the folder on Windows.
      for (let i = 0; i < 20; i++) {
        try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
      }
    },
  };
}
