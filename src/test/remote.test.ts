import { catastrophicReason, parseHostSpec, resolveServer, unknownServerMessage } from '../core/remoteTools';
import { after, before, describe, it } from 'node:test';
import * as assert from 'assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpDir } from './helpers';
import { findShell, startSshServer, TestSshServer } from './fixtures/sshServer';
import { buildRemoteCommand, HostKeyInfo, shQuote, SshPool, SshTarget } from '../core/ssh';
import { createRemoteTools, RemoteServerInfo } from '../core/remoteTools';
import { SecretVault } from '../core/redact';
import { evaluatePermission, parseRule, PermissionRule } from '../core/permissions';
import type { ToolCtx } from '../core/tool';

/** Exercises SshPool and the remote tools against a real in-process SSH server on 127.0.0.1. */

const ssh2 = require('ssh2') as typeof import('ssh2');
const PASSWORD = "S3cret-pw'$ x";
const SHELL = findShell();
const NO_SHELL = SHELL ? false : 'no bash/sh found: exec tests skipped';
const clientKey = ssh2.utils.generateKeyPairSync('ed25519');

let server: TestSshServer;
const pools: SshPool[] = [];
const temps: string[] = [];

const target = (o: Partial<SshTarget> = {}): SshTarget => ({ name: 'srv', host: '127.0.0.1', port: server.port, user: 'tester', password: PASSWORD, ...o });
function newPool(verify: (i: HostKeyInfo) => boolean | Promise<boolean> = () => true, seen: HostKeyInfo[] = []): SshPool {
  const p = new SshPool({ verifyHostKey: async (i) => { seen.push(i); return verify(i); }, connectTimeoutMs: 10_000 });
  pools.push(p);
  return p;
}
const waitFor = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) { throw new Error('condition not met in time'); } await new Promise((r) => setTimeout(r, 25)); }
};

before(async () => { server = await startSshServer({ password: PASSWORD, authorizedKeys: [clientKey.public] }); });
after(async () => {
  for (const p of pools) { p.dispose(); }
  await server.close();
  for (const d of temps) { await fs.rm(d, { recursive: true, force: true }); }
});

describe('SshPool connections', () => {
  it('logs in with a password', { skip: NO_SHELL }, async () => {
    const r = await newPool().exec(target(), 'echo hi');
    assert.equal(r.code, 0);
    assert.equal(r.output, 'hi\n');
    assert.equal(r.timedOut, false);
  });

  it('logs in with a private key', async () => {
    const pool = newPool();
    const t = target({ name: 'keyed', password: undefined, privateKey: clientKey.private });
    await pool.connect(t);
    assert.ok(pool.connected.has('keyed'));
  });

  it('rejects a key the server does not know with the friendly message', async () => {
    const other = ssh2.utils.generateKeyPairSync('ed25519');
    await assert.rejects(newPool().connect(target({ password: undefined, privateKey: other.private })), /Authentication to srv failed: check the user name and private key\./);
  });

  it('reports a wrong password as an authentication error', async () => {
    const seen: HostKeyInfo[] = [];
    const before = server.connections();
    await assert.rejects(newPool(() => true, seen).exec(target({ password: 'wrong' }), 'true'), /Authentication to srv failed: check the user name and password\./);
    assert.equal(server.connections() - before, 1, 'a failed login is attempted once, not retried');
  });

  it('passes the SHA256 host key fingerprint to the host key callback', async () => {
    const seen: HostKeyInfo[] = [];
    await newPool(() => true, seen).connect(target());
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { server: 'srv', host: '127.0.0.1', port: server.port, fingerprint: server.hostKeyFingerprint });
    assert.match(seen[0].fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('refuses the connection when the host key is not trusted, asking only once', async () => {
    const seen: HostKeyInfo[] = [];
    const pool = newPool(() => false, seen);
    await assert.rejects(pool.exec(target(), 'true'), /host key of srv \(SHA256:[^)]+\) was not trusted/);
    assert.equal(seen.length, 1, 'the user is asked about the host key once');
    assert.equal(pool.connected.has('srv'), false);
  });

  it('reports a closed port clearly', async () => {
    await assert.rejects(newPool().connect(target({ port: 1 })), /Could not connect to srv \(127\.0\.0\.1:1\)/);
  });

  it('reuses one connection for several commands, also in parallel', { skip: NO_SHELL }, async () => {
    const pool = newPool();
    const before = server.connections();
    await pool.exec(target(), 'echo 1');
    await pool.exec(target(), 'echo 2');
    const all = await Promise.all([pool.exec(target(), 'echo 3'), pool.exec(target(), 'echo 4'), pool.readFile(target(), '/').catch(() => '')]);
    assert.deepEqual([all[0].output, all[1].output], ['3\n', '4\n']);
    assert.equal(server.connections() - before, 1);
  });

  it('reconnects after the server drops the connection', { skip: NO_SHELL }, async () => {
    const statuses: string[] = [];
    const pool = new SshPool({ verifyHostKey: async () => true, onStatus: (s, up) => statuses.push(`${s}:${up}`) });
    pools.push(pool);
    await pool.exec(target(), 'true');
    const before = server.connections();
    server.dropAll();
    await waitFor(() => !pool.connected.has('srv'));
    const r = await pool.exec(target(), 'echo again');
    assert.equal(r.output, 'again\n');
    assert.equal(server.connections() - before, 1);
    assert.deepEqual(statuses, ['srv:true', 'srv:false', 'srv:true']);
  });

  it('retries once on a fresh connection when a pooled one turns out dead before the command starts', { skip: NO_SHELL }, async () => {
    let made = 0;
    class FlakyClient extends ssh2.Client {
      private first = ++made === 1;
      private fails = 0;
      exec(...args: unknown[]): this {
        // The first connection "dies" after its first command: ssh2 throws Not connected synchronously.
        if (this.first && this.fails++ > 0) { throw new Error('Not connected'); }
        return (ssh2.Client.prototype.exec as (...a: unknown[]) => this).apply(this, args);
      }
    }
    const pool = new SshPool({ verifyHostKey: async () => true, loadClient: () => FlakyClient as unknown as new () => import('ssh2').Client });
    pools.push(pool);
    assert.equal((await pool.exec(target(), 'echo one')).output, 'one\n');
    const r = await pool.exec(target(), 'echo two', { timeoutMs: 5000 });
    assert.equal(r.output, 'two\n');
    assert.equal(made, 2);
  });

  it('opens a new connection when the credentials change, and close() ends it', async () => {
    const pool = newPool();
    const before = server.connections();
    await pool.connect(target());
    await pool.connect(target({ password: undefined, privateKey: clientKey.private }));
    assert.equal(server.connections() - before, 2);
    pool.close('srv');
    assert.equal(pool.connected.has('srv'), false);
  });
});

describe('SshPool.exec', { skip: NO_SHELL }, () => {
  let pool: SshPool;
  before(() => { pool = newPool(); });

  it('merges stderr into the output', async () => {
    const r = await pool.exec(target(), 'echo out; echo err 1>&2');
    assert.match(r.output, /out\n/);
    assert.match(r.output, /err\n/);
  });

  it('returns a non-zero exit code', async () => {
    const r = await pool.exec(target(), 'echo before; exit 3');
    assert.equal(r.code, 3);
    assert.equal(r.output, 'before\n');
  });

  it('applies cwd and environment variables', async () => {
    await fs.mkdir(path.join(server.root, 'sub dir'));
    const env = { GREETING: `it's "quoted" $HOME \`x\``, 'BAD-NAME': 'ignored' };
    const r = await pool.exec(target({ env }), 'basename "$(pwd)"; printf "%s" "$GREETING"', { cwd: 'sub dir' });
    assert.equal(r.code, 0);
    assert.equal(r.output, `sub dir\n${env.GREETING}`);
  });

  it('a missing cwd fails without running the command', async () => {
    const r = await pool.exec(target(), 'echo ran', { cwd: 'no such dir' });
    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.output, /ran/);
  });

  it('quotes awkward values safely', async () => {
    const awkward = `a 'b' "c" $d \`e\` \\f ; g`;
    assert.equal(shQuote("it's"), `'it'\\''s'`);
    assert.equal(buildRemoteCommand('ls', '/a b', { X: '1' }), `cd '/a b' && export X='1'; ls`);
    const r = await pool.exec(target(), `printf '%s' ${shQuote(awkward)}`);
    assert.equal(r.output, awkward);
  });

  it('writes stdin (as for sudo -S)', async () => {
    const r = await pool.exec(target(), 'read -r pw; echo "got:$pw"', { stdin: 'hunter2\n' });
    assert.equal(r.output, 'got:hunter2\n');
  });

  it('streams output through onData', async () => {
    const chunks: string[] = [];
    await pool.exec(target(), 'echo a; echo b', { onData: (c) => chunks.push(c) });
    assert.equal(chunks.join(''), 'a\nb\n');
  });

  it('stops a command at the time limit and reports timedOut', async () => {
    const r = await pool.exec(target(), 'echo started; sleep 30; echo never', { timeoutMs: 1000 });
    assert.equal(r.timedOut, true);
    assert.equal(r.cancelled, false);
    assert.ok(r.ms < 6000, `took ${r.ms}ms`);
    assert.match(r.output, /started/);
    assert.doesNotMatch(r.output, /never/);
  });

  it('sends a KILL signal although stdin is already closed, and the remote command stops', async () => {
    // ssh2's own Server ignores channel requests after EOF, so watch the client side send the request instead.
    const sent: string[] = [];
    class SpyClient extends ssh2.Client {
      constructor() {
        super();
        this.once('ready', () => {
          const proto = (this as unknown as { _protocol: { signal(id: number, s: string): void } })._protocol;
          const orig = proto.signal.bind(proto);
          proto.signal = (id, s) => { sent.push(s); orig(id, s); };
        });
      }
    }
    const spyPool = new SshPool({ verifyHostKey: async () => true, loadClient: () => SpyClient as unknown as new () => import('ssh2').Client });
    pools.push(spyPool);
    const marker = path.join(server.root, 'not-killed.txt');
    const r = await spyPool.exec(target(), 'sleep 2; echo late > not-killed.txt', { timeoutMs: 400 });
    assert.equal(r.timedOut, true);
    assert.deepEqual(sent, ['KILL']);
    await new Promise((res) => setTimeout(res, 2500));
    await assert.rejects(fs.stat(marker), 'the remote process was stopped, not left running');
  });

  it('cancels a command when the signal aborts', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    const started = Date.now();
    const r = await pool.exec(target(), 'sleep 30', { signal: ac.signal });
    assert.equal(r.cancelled, true);
    assert.equal(r.timedOut, false);
    assert.ok(Date.now() - started < 6000);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(pool.exec(target(), 'echo x', { signal: ac.signal }), /Cancelled/);
  });

  it('keeps the tail of a long output', async () => {
    const r = await pool.exec(target(), 'i=1; while [ $i -le 3000 ]; do echo "line $i"; i=$((i+1)); done', { maxBytes: 1000 });
    assert.equal(r.code, 0);
    assert.equal(r.truncated, true);
    assert.ok(r.output.length <= 1000);
    assert.ok(r.output.endsWith('line 3000\n'));
    assert.doesNotMatch(r.output, /line 1\n/);
  });

  it('does not garble multi-byte characters split across chunks', async () => {
    await fs.writeFile(path.join(server.root, 'utf8.txt'), `a${'é'.repeat(100_000)}`);
    const r = await pool.exec(target(), 'cat utf8.txt', { maxBytes: 1_000_000 });
    assert.equal(r.output.includes('\uFFFD'), false);
    assert.equal(r.output, `a${'é'.repeat(100_000)}`);
  });
});

describe('remote tools', () => {
  let ws: string;
  let snaps: string[];
  let remote: ReturnType<typeof createRemoteTools>;
  let pool: SshPool;
  const run = (name: string, args: object, signal = new AbortController().signal): Promise<string> => {
    const tool = remote.tools.find((t) => t.spec.function.name === name)!;
    const ctx: ToolCtx = { root: ws, signal, snapshot: async (abs) => { snaps.push(abs); } };
    return tool.run(args, ctx);
  };

  before(async () => {
    ws = await tmpDir('ica-remote-ws-');
    temps.push(ws);
    pool = newPool();
    const infos: RemoteServerInfo[] = [
      { name: 'prod', host: '127.0.0.1', port: server.port, user: 'tester', auth: 'password', notes: 'App in /deploy/app\nService: app.service', alwaysAsk: true },
      { name: 'keybox', host: '127.0.0.1', port: server.port, user: 'tester', auth: 'key', alwaysAsk: false },
    ];
    remote = createRemoteTools({
      pool,
      servers: () => infos,
      target: async (name) => {
        const s = infos.find((x) => x.name === name);
        if (!s) { throw new Error(`no ${name}`); }
        return { name, host: s.host, port: s.port, user: s.user, ...(s.auth === 'password' ? { password: PASSWORD } : { privateKey: clientKey.private }) };
      },
    });
  });
  after(() => remote.dispose());

  it('list_servers shows each server with its notes', async () => {
    const out = await run('list_servers', {});
    assert.match(out, /- prod: tester@127\.0\.0\.1:\d+ \(asks the user before every change, even in Auto-execute\)\n {2}Notes: App in \/deploy\/app\n {2}Service: app\.service/);
    assert.match(out, /- keybox: tester@127\.0\.0\.1:\d+$/m);
  });

  it('remote_exec rejects an unknown server', async () => {
    await assert.rejects(run('remote_exec', { server: 'nope', command: 'ls' }), /No saved server matches "nope"\. Saved servers: "prod" \(tester@127\.0\.0\.1:\d+\), "keybox" \(tester@127\.0\.0\.1:\d+\)\./);
  });

  it('remote_exec rejects an empty command', async () => {
    await assert.rejects(run('remote_exec', { server: 'prod', command: '  ' }), /must not be empty/);
  });

  it('remote_exec runs in the foreground with a summary line', { skip: NO_SHELL }, async () => {
    assert.match(await run('remote_exec', { server: 'prod', command: 'echo hello' }), /^hello\n\[exit 0 after \d+\.\ds\]$/);
    assert.match(await run('remote_exec', { server: 'keybox', command: 'exit 4' }), /^\(no output\)\n\[exit 4 after \d+\.\ds\]$/);
    const slow = await run('remote_exec', { server: 'prod', command: 'sleep 20', timeout_seconds: 1 });
    assert.match(slow, /\[timed out after \d+\.\ds\]\nThe command was stopped at the time limit\. Rerun it with background: true/);
  });

  it('remote_exec throws when the agent cancels a foreground command', { skip: NO_SHELL }, async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    await assert.rejects(run('remote_exec', { server: 'prod', command: 'sleep 20' }, ac.signal), /Cancelled/);
  });

  it('background job: remote_job_output waits until it finishes', { skip: NO_SHELL }, async () => {
    const started = await run('remote_exec', { server: 'prod', command: 'echo first; sleep 1; echo last', background: true });
    const id = /Started (job-[0-9a-f]{6}) on prod\./.exec(started)?.[1];
    assert.ok(id, started);
    const t0 = Date.now();
    const out = await run('remote_job_output', { job_id: id, wait_seconds: 20 });
    assert.ok(Date.now() - t0 < 10_000, 'returned when the job finished, not at the wait limit');
    assert.match(out, new RegExp(`^Job ${id} on prod: exited \\(exit 0\\), \\d+s\\n\\$ echo first; sleep 1; echo last\\nfirst\\nlast$`));
    assert.match(await run('remote_job_output', {}), new RegExp(`${id} \\[exited 0\\] prod: echo first`));
    assert.equal(await run('remote_job_stop', { job_id: id }), `Job ${id} already exited.`);
  });

  it('remote_job_stop stops a running job', { skip: NO_SHELL }, async () => {
    const started = await run('remote_exec', { server: 'prod', command: 'echo going; sleep 30', background: true });
    const id = /Started (job-[0-9a-f]{6})/.exec(started)![1];
    assert.match(await run('remote_job_output', { job_id: id, wait_seconds: 1 }), /going/);
    assert.equal(await run('remote_job_stop', { job_id: id }), `Stopping job ${id}.`);
    const out = await run('remote_job_output', { job_id: id, wait_seconds: 10 });
    assert.match(out, new RegExp(`Job ${id} on prod: stopped`));
    await assert.rejects(run('remote_job_stop', { job_id: 'job-000000' }), /No job "job-000000"/);
    await assert.rejects(run('remote_job_output', { job_id: 'job-000000' }), /No job "job-000000"/);
  });

  it('use_sudo_password writes the stored password to stdin; refused for key servers', { skip: NO_SHELL }, async () => {
    const out = await run('remote_exec', { server: 'prod', command: 'read -r pw; echo "pw=$pw"', use_sudo_password: true });
    assert.match(out, new RegExp(`^pw=${PASSWORD.replace(/[$'\\]/g, '\\$&')}\\n`));
    await assert.rejects(run('remote_exec', { server: 'keybox', command: 'sudo -S true', use_sudo_password: true }), /keybox uses key authentication, so there is no stored password for sudo\./);
  });

  it('SecretVault.addKnown masks a saved password in command output', { skip: NO_SHELL }, async () => {
    const vault = new SecretVault();
    vault.addKnown(PASSWORD, 'server-password');
    const out = await run('remote_exec', { server: 'prod', command: `echo "login with ${PASSWORD.replace(/[$"\\`]/g, '\\$&')} ok"` });
    assert.ok(out.includes(PASSWORD));
    const masked = vault.redact(out).text;
    assert.equal(masked.includes(PASSWORD), false);
    assert.match(masked, /login with ‹secret:server-password:\d+› ok/);
  });

  it('remote_upload sends a folder (skipping node_modules and .git) and a single file', async () => {
    const build = path.join(ws, 'build');
    await fs.mkdir(path.join(build, 'nested', 'deep'), { recursive: true });
    await fs.mkdir(path.join(build, 'node_modules', 'pkg'), { recursive: true });
    await fs.mkdir(path.join(build, '.git'), { recursive: true });
    await fs.writeFile(path.join(build, 'index.html'), '<h1>hi</h1>');
    await fs.writeFile(path.join(build, 'nested', 'deep', 'app.js'), 'console.log(1)');
    await fs.writeFile(path.join(build, 'node_modules', 'pkg', 'x.js'), 'x');
    await fs.writeFile(path.join(build, '.git', 'HEAD'), 'ref');
    const out = await run('remote_upload', { server: 'prod', local_path: 'build', remote_path: '/deploy/app/' });
    assert.match(out, /^Uploaded 2 files \(0\.0 KB\) to prod:\/deploy\/app\/\. Skipped: /);
    assert.match(out, /node_modules\//);
    assert.match(out, /\.git\//);
    const app = path.join(server.root, 'deploy', 'app');
    assert.equal(await fs.readFile(path.join(app, 'index.html'), 'utf8'), '<h1>hi</h1>');
    assert.equal(await fs.readFile(path.join(app, 'nested', 'deep', 'app.js'), 'utf8'), 'console.log(1)');
    await assert.rejects(fs.stat(path.join(app, 'node_modules')));
    await assert.rejects(fs.stat(path.join(app, '.git')));

    const big = Buffer.alloc(300_000, 7);
    await fs.writeFile(path.join(ws, 'blob.bin'), big);
    assert.match(await run('remote_upload', { server: 'keybox', local_path: 'blob.bin', remote_path: '/single/copy.bin' }), /^Uploaded 1 file \(293\.0 KB\) to keybox:\/single\/copy\.bin\.$/);
    assert.ok((await fs.readFile(path.join(server.root, 'single', 'copy.bin'))).equals(big));
    await assert.rejects(run('remote_upload', { server: 'prod', local_path: '../outside', remote_path: '/x' }));
  });

  it('remote_download fetches a folder and snapshots every local file first', async () => {
    const logs = path.join(server.root, 'var', 'logs');
    await fs.mkdir(path.join(logs, 'old'), { recursive: true });
    await fs.writeFile(path.join(logs, 'app.log'), 'line1\nline2\n');
    await fs.writeFile(path.join(logs, 'old', 'app.1.log'), 'older');
    snaps = [];
    const out = await run('remote_download', { server: 'prod', remote_path: '/var/logs', local_path: 'fetched' });
    assert.match(out, /^Downloaded 2 files \(0\.0 KB\) to fetched\.$/);
    assert.equal(await fs.readFile(path.join(ws, 'fetched', 'app.log'), 'utf8'), 'line1\nline2\n');
    assert.equal(await fs.readFile(path.join(ws, 'fetched', 'old', 'app.1.log'), 'utf8'), 'older');
    assert.deepEqual(snaps.sort(), [path.join(ws, 'fetched', 'app.log'), path.join(ws, 'fetched', 'old', 'app.1.log')].sort());

    snaps = [];
    await run('remote_download', { server: 'prod', remote_path: '/var/logs/app.log', local_path: 'one.log' });
    assert.deepEqual(snaps, [path.join(ws, 'one.log')]);
    await assert.rejects(run('remote_download', { server: 'prod', remote_path: '/missing', local_path: 'm' }), /\/missing: /);
  });

  it('remote_read_file reads line ranges and refuses big, binary and folder paths', async () => {
    await fs.mkdir(path.join(server.root, 'etc'), { recursive: true });
    await fs.writeFile(path.join(server.root, 'etc', 'app.conf'), 'a=1\nb=2\nc=3\nd=4\n');
    assert.equal(await run('remote_read_file', { server: 'prod', path: '/etc/app.conf', start_line: 2, end_line: 3 }), '2\tb=2\n3\tc=3');
    assert.match(await run('remote_read_file', { server: 'prod', path: '/etc/app.conf' }), /^1\ta=1\n2\tb=2\n3\tc=3\n4\td=4/);
    await fs.writeFile(path.join(server.root, 'etc', 'big.log'), Buffer.alloc(3 * 1024 * 1024, 'x'));
    await assert.rejects(run('remote_read_file', { server: 'prod', path: '/etc/big.log' }), /\/etc\/big\.log is 3072 KB; read part of it with remote_exec/);
    await fs.writeFile(path.join(server.root, 'etc', 'bin.dat'), Buffer.from([1, 2, 0, 3]));
    await assert.rejects(run('remote_read_file', { server: 'prod', path: '/etc/bin.dat' }), /\/etc\/bin\.dat is a binary file\./);
    await assert.rejects(run('remote_read_file', { server: 'prod', path: '/etc' }), /\/etc is not a file\./);
    await assert.rejects(run('remote_read_file', { server: 'prod', path: '/etc/none' }), /\/etc\/none: /);
  });
});

describe('remote_exec permission rules', () => {
  const rule = (effect: PermissionRule['effect'], pattern: string | undefined, source: PermissionRule['source'] = 'user'): PermissionRule =>
    ({ effect, tool: 'remote_exec', pattern, source, raw: `remote_exec${pattern ? `(${pattern})` : ''}` });
  const decide = (rules: PermissionRule[], server: string, command: string) =>
    evaluatePermission(rules, { tool: 'remote_exec', kind: 'exec', args: { server, command }, root: process.cwd() }).effect;

  it('a server-scoped rule applies only to that server', () => {
    const rules = [rule('allow', 'prod:systemctl status*')];
    assert.equal(decide(rules, 'prod', 'systemctl status nginx'), 'allow');
    assert.equal(decide(rules, 'staging', 'systemctl status nginx'), undefined);
    assert.equal(decide(rules, 'prod', 'systemctl restart nginx'), undefined);
  });

  it('an unscoped rule applies to every server', () => {
    const rules = [rule('allow', 'df -h*')];
    assert.equal(decide(rules, 'prod', 'df -h'), 'allow');
    assert.equal(decide(rules, 'staging', 'df -h /'), 'allow');
  });

  it('deny beats allow, and a scoped deny does not leak to other servers', () => {
    const rules = [rule('allow', 'systemctl*'), rule('deny', 'prod:systemctl stop*', 'project')];
    assert.equal(decide(rules, 'prod', 'systemctl stop app'), 'deny');
    assert.equal(decide(rules, 'staging', 'systemctl stop app'), 'allow');
    assert.equal(decide([rule('deny', 'rm -rf*'), rule('allow', 'prod:rm*')], 'prod', 'rm -rf /srv'), 'deny');
    assert.equal(decide([rule('deny', undefined)], 'staging', 'ls'), 'deny');
  });

  it('allow rules do not cover chained commands they do not match', () => {
    assert.equal(decide([rule('allow', 'prod:systemctl status*')], 'prod', 'systemctl status app && rm -rf /'), undefined);
  });

  it('parseRule accepts server-scoped remote_exec rules', () => {
    const r = parseRule('remote_exec(prod:systemctl status*)', 'allow', 'user');
    assert.ok(r);
    assert.equal(r.pattern, 'prod:systemctl status*');
  });
});

describe('finding a saved server', () => {
  const servers = [
    { name: 'personal server', host: '10.0.5.110', user: 'root', port: 22 },
    { name: 'prod', host: 'app.example.internal', user: 'deploy', port: 2222 },
  ];
  it('matches by name in any letter case, by IP, host name, user@host and host:port', () => {
    assert.equal(resolveServer(servers, 'personal server')?.name, 'personal server');
    assert.equal(resolveServer(servers, 'Personal Server')?.name, 'personal server');
    assert.equal(resolveServer(servers, '10.0.5.110')?.name, 'personal server');
    assert.equal(resolveServer(servers, 'root@10.0.5.110')?.name, 'personal server');
    assert.equal(resolveServer(servers, 'APP.example.internal')?.name, 'prod');
    assert.equal(resolveServer(servers, 'app.example.internal:2222')?.name, 'prod');
  });
  it('does not guess for an unsaved or ambiguous address', () => {
    assert.equal(resolveServer(servers, '10.0.4.110'), undefined);
    assert.equal(resolveServer([...servers, { name: 'copy', host: '10.0.5.110', user: 'admin', port: 22 }], '10.0.5.110'), undefined);
    assert.equal(resolveServer([...servers, { name: 'copy', host: '10.0.5.110', user: 'admin', port: 22 }], 'admin@10.0.5.110')?.name, 'copy');
  });
  it('lists the saved servers when nothing matches and forbids asking for passwords', () => {
    const m = unknownServerMessage(servers, '10.0.4.110');
    assert.match(m, /No saved server matches "10\.0\.4\.110"/);
    assert.match(m, /"personal server" \(root@10\.0\.5\.110:22\)/);
    assert.match(m, /Never ask the user to type a password/);
  });
});

describe('commands that could wreck a server', () => {
  it('flags reboots, formatting, disk overwrites and recursive deletes of system folders', () => {
    for (const c of ['reboot', 'sudo reboot', 'sudo -n shutdown -h now', 'systemctl reboot', 'init 6', 'mkfs.ext4 /dev/sdb1', 'dd if=/dev/zero of=/dev/sda bs=1M',
      'rm -rf /', 'sudo rm -rf /etc', 'rm -fr /var/*', 'cd /opt && rm -rf /usr', 'chmod -R 777 /', ':(){ :|:& };:', 'echo hi; /sbin/poweroff']) {
      assert.ok(catastrophicReason(c), c);
    }
  });
  it('leaves everyday operations alone, including words that only look dangerous', () => {
    for (const c of ['echo reboot', 'systemctl restart nginx', 'systemctl status app --no-pager', 'rm -rf /opt/app/releases/old', 'rm -rf ./build', 'df -h',
      'grep shutdown /var/log/syslog', 'docker compose up -d', 'dd if=/dev/zero of=/tmp/test bs=1M count=1', 'chmod -R 755 /opt/app']) {
      assert.equal(catastrophicReason(c), undefined, c);
    }
  });
});

describe('reading a server address', () => {
  it('splits user@host:port, keeps explicit values, and handles IPv6 and ssh:// forms', () => {
    assert.deepEqual(parseHostSpec('10.0.5.97'), { host: '10.0.5.97', user: undefined, port: 22 });
    assert.deepEqual(parseHostSpec('root@10.0.5.97'), { host: '10.0.5.97', user: 'root', port: 22 });
    assert.deepEqual(parseHostSpec('root@10.0.5.97:2222'), { host: '10.0.5.97', user: 'root', port: 2222 });
    assert.deepEqual(parseHostSpec('ssh://deploy@app.internal/'), { host: 'app.internal', user: 'deploy', port: 22 });
    assert.deepEqual(parseHostSpec('[fe80::1]:2200', 'admin'), { host: 'fe80::1', user: 'admin', port: 2200 });
    assert.deepEqual(parseHostSpec('root@10.0.5.97', 'ubuntu', 2022), { host: '10.0.5.97', user: 'ubuntu', port: 2022 });
  });
  it('points the agent to connect_server for an address that is not saved', () => {
    assert.match(unknownServerMessage([], '10.0.4.110'), /call connect_server/);
  });
});
