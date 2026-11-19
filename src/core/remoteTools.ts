import * as path from 'path';
import { randomBytes } from 'crypto';
import { clip, resolveSafe } from './fstools';
import { DEFAULT_TIMEOUT_MS, SshPool, SshTarget } from './ssh';
import { Tool, fnSpec } from './tool';

/** The agent's tools for Linux servers: commands, long-running jobs, file transfer and reading remote files. */

export interface RemoteServerInfo { name: string; host: string; port: number; user: string; auth: 'password' | 'key'; notes?: string }
export interface RemoteHost {
  servers(): RemoteServerInfo[];
  /** Connection details including credentials; throws if the server does not exist. */
  target(name: string): Promise<SshTarget>;
  pool: SshPool;
}

export const REMOTE_TOOLS = ['list_servers', 'remote_exec', 'remote_job_output', 'remote_job_stop', 'remote_upload', 'remote_download', 'remote_read_file'];
/** Tools that change something on a server. */
export const REMOTE_CHANGING = new Set(['remote_exec', 'remote_job_stop', 'remote_upload']);

/**
 * Finds a saved server by its name (any letter case), its IP or host name, or user@host. Users often refer to a
 * server by address, so both must work. Returns undefined when nothing matches or an address is ambiguous.
 */
export function resolveServer<T extends { name: string; host: string; user: string; port?: number }>(servers: T[], query: unknown): T | undefined {
  const q = String(query ?? '').trim();
  if (!q) { return undefined; }
  const l = q.toLowerCase();
  const exact = servers.find((s) => s.name === q) ?? servers.find((s) => s.name.toLowerCase() === l);
  if (exact) { return exact; }
  const byAddress = servers.filter((s) => {
    const host = s.host.toLowerCase();
    return host === l || `${s.user}@${host}`.toLowerCase() === l || `${host}:${s.port ?? 22}` === l || `${s.user}@${host}:${s.port ?? 22}`.toLowerCase() === l;
  });
  return byAddress.length === 1 ? byAddress[0] : undefined;
}

/** Splits "user@host:port" (each part optional except the host). IPv6 addresses go in brackets: [::1]:22. */
export function parseHostSpec(spec: unknown, user?: unknown, port?: unknown): { host: string; user?: string; port: number } {
  let s = String(spec ?? '').trim().replace(/^ssh:\/\//i, '').replace(/\/+$/, '');
  let u = typeof user === 'string' && user.trim() ? user.trim() : undefined;
  const at = s.lastIndexOf('@');
  if (at > 0) { u ??= s.slice(0, at); s = s.slice(at + 1); }
  let p = Number(port) || 22;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (v6) { s = v6[1]; if (v6[2] && !Number(port)) { p = Number(v6[2]); } }
  else {
    const m = /^([^:]+):(\d+)$/.exec(s);
    if (m) { s = m[1]; if (!Number(port)) { p = Number(m[2]); } }
  }
  return { host: s, user: u, port: p };
}

/** What the agent is told when no saved server matches, so it can suggest the right one instead of asking for a password. */
export function unknownServerMessage(servers: Array<{ name: string; host: string; user: string; port: number }>, query: unknown): string {
  const q = String(query ?? '').trim();
  const list = servers.map((s) => `"${s.name}" (${s.user}@${s.host}:${s.port})`).join(', ');
  return `No saved server matches "${q}". ${list ? `Saved servers: ${list}. If one of these is what the user meant (for example a similar address), ask the user to confirm before using it.` : 'No servers are saved yet.'} `
    + 'Otherwise call connect_server with the address (and the user name if the user gave one): it asks the user for the credentials in a secure VS Code prompt, tests the connection and saves the server. Never ask the user to type a password or private key in the chat.';
}

/**
 * Splits a shell command into simple commands and their words, honouring single and double quotes and backslash
 * escapes, so a "|" or ";" inside quotes (grep 'a|b') is not mistaken for a pipe or a separator.
 */
export function shellCommands(text: string): Array<{ words: string[]; raw: string }> {
  const out: Array<{ words: string[]; raw: string }> = [];
  let words: string[] = [], word = '', inWord = false, raw = '', quote: string | undefined;
  const endWord = () => { if (inWord) { words.push(word); } word = ''; inWord = false; };
  const endCommand = () => { endWord(); if (words.length) { out.push({ words, raw: raw.trim() }); } words = []; raw = ''; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      raw += c;
      if (c === quote) { quote = undefined; }
      else if (c === '\\' && quote === '"' && i + 1 < text.length) { word += text[++i]; raw += text[i]; }
      else { word += c; }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; raw += c; continue; }
    if (c === '\\' && i + 1 < text.length) { word += text[++i]; inWord = true; raw += c + text[i]; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '\n') {
      // "2>&1" and ">&2" are redirections, not separators.
      if (c === '&' && (text[i - 1] === '>' || text[i + 1] === '>')) { word += c; inWord = true; raw += c; continue; }
      endCommand();
      if ((c === '|' || c === '&') && text[i + 1] === c) { i++; }
      continue;
    }
    if (/\s/.test(c)) { endWord(); raw += c; continue; }
    word += c; inWord = true; raw += c;
  }
  endCommand();
  return out;
}

/** Commands that only look at the server. Sub-commands are checked for the tools that also have changing ones. */
const READ_ONLY = new Set(['ls', 'll', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'zgrep', 'zcat', 'stat', 'file', 'wc', 'du', 'df', 'free', 'uptime', 'uname',
  'whoami', 'id', 'groups', 'hostname', 'hostnamectl', 'ps', 'pgrep', 'pidof', 'which', 'whereis', 'type', 'echo', 'printf', 'pwd', 'date', 'printenv', 'tree',
  'lsblk', 'lscpu', 'lsmem', 'lsof', 'ss', 'netstat', 'nproc', 'vmstat', 'iostat', 'mpstat', 'sort', 'uniq', 'cut', 'tr', 'column', 'jq', 'md5sum', 'sha256sum',
  'readlink', 'realpath', 'basename', 'dirname', 'test', '[', 'true', 'sleep', 'getent', 'dig', 'nslookup', 'host', 'ping', 'last', 'w', 'who', 'dmesg', 'awk', 'sed', 'find', 'journalctl', 'curl', 'wget', 'env', 'nginx', 'ip']);
const READ_SUB: Record<string, Set<string>> = {
  systemctl: new Set(['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files', 'list-timers', 'show', 'cat', 'list-dependencies']),
  docker: new Set(['ps', 'images', 'logs', 'inspect', 'stats', 'version', 'info', 'top', 'port', 'diff', 'history']),
  git: new Set(['status', 'log', 'show', 'diff', 'branch', 'rev-parse', 'describe', 'remote', 'tag', 'ls-files', 'blame', 'config']),
  kubectl: new Set(['get', 'describe', 'logs', 'top', 'version', 'explain', 'api-resources']),
  pm2: new Set(['list', 'ls', 'status', 'show', 'describe', 'logs', 'jlist', 'prettylist']),
  apt: new Set(['list', 'show', 'policy', 'search']), dpkg: new Set(['-l', '-L', '-s', '--list', '--status']), rpm: new Set(['-q', '-qa', '-qi', '-ql']),
  npm: new Set(['ls', 'list', 'view', 'outdated', '-v', '--version']), pip: new Set(['list', 'show', 'freeze', '--version']), crontab: new Set(['-l']),
};

const OPTIONS_WITH_VALUE: Record<string, Set<string>> = {
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']),
  docker: new Set(['-H', '--host', '--context', '--config', '-l', '--log-level']),
  kubectl: new Set(['-n', '--namespace', '--context', '--cluster', '--kubeconfig', '-s', '--server', '--user']),
  systemctl: new Set(['-H', '--host', '-M', '--machine', '-p', '--property', '-n', '--lines', '-o', '--output', '--state', '-t', '--type']),
};

/**
 * Whether a command only reads (ls, cat, grep, systemctl status, docker ps, curl for a health check…). Such commands
 * skip a server's "ask before every change" setting. Anything uncertain counts as a change: redirection to a file,
 * command substitution, sed -i, find -delete/-exec, curl uploads, or a program not on the read-only list.
 */
export function isReadOnlyCommand(command: unknown): boolean {
  const text = String(command ?? '').trim();
  if (!text || /`|\$\(|<\(|>\(/.test(text)) { return false; }
  // Only discarding output is allowed: >/dev/null, 2>/dev/null, 2>&1.
  const skeleton = text.replace(/'[^']*'|"(?:[^"\\\\]|\\\\.)*"/g, '""');
  if (/`|\$\(|<\(|>\(/.test(skeleton)) { return false; }
  if (/>/.test(skeleton.replace(/\d?>>?\s*\/dev\/null|\d?>&\d|&>\s*\/dev\/null/g, ''))) { return false; }
  for (const { words: all, raw: segment } of shellCommands(text)) {
    let words = all.filter((w) => !/^\d?>/.test(w) && w !== '/dev/null');
    while (words.length && (words[0] === 'sudo' || words[0] === 'nice' || words[0] === 'timeout' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || /^-/.test(words[0]) || (/^\d+[smh]?$/.test(words[0]) && words.length > 1))) { words = words.slice(1); }
    const [cmd, ...args] = words;
    if (!cmd) { continue; }
    const base = cmd.split('/').pop()!;
    if (args.length === 1 && /^(-v|-V|--version|version)$/.test(args[0])) { continue; }
    if (base === 'docker' && args[0] === 'compose') { if (!['ps', 'logs', 'config', 'ls', 'images', 'top', 'version'].includes(args[1] ?? '')) { return false; } continue; }
    const sub = READ_SUB[base];
    if (sub) {
      // Global options before the sub-command may take a value (git -C dir, docker -H host, kubectl -n ns).
      const valued = OPTIONS_WITH_VALUE[base] ?? new Set<string>();
      let first = '';
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (sub.has(a) || !a.startsWith('-')) { first = a; break; }
        if (valued.has(a)) { i++; }
      }
      if (!sub.has(first)) { return false; }
      if (base === 'git' && first === 'branch' && args.some((a) => /^-[dDmMcC]$|^--(delete|move|copy)/.test(a))) { return false; }
      if (base === 'git' && (first === 'config' || first === 'remote' || first === 'tag') && args.length > 2 && !args.includes('-l') && !args.includes('--list') && !args.includes('-v') && !args.includes('--get')) { return false; }
      continue;
    }
    if (!READ_ONLY.has(base)) { return false; }
    if (base === 'sed' && args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) { return false; }
    if (base === 'awk' && /system\s*\(|print\s*>|\|\s*"/.test(segment)) { return false; }
    if (base === 'find' && args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(a))) { return false; }
    if (base === 'journalctl' && args.some((a) => /^--(vacuum|rotate|flush|relinquish|setup-keys)/.test(a))) { return false; }
    if ((base === 'curl' || base === 'wget') && args.some((a) => /^(-X|--request|-d|--data.*|-F|--form|-T|--upload-file|-o|--output|-O|--remote-name|--post-data|--post-file|--method)$/.test(a) || /^-[a-zA-Z]*[dFTOo]/.test(a) && !/^-[a-zA-Z]*s?f?S?L?$/.test(a))) { return false; }
    if (base === 'nginx' && !(args.length === 1 && args[0] === '-t') && !(args.length === 1 && args[0] === '-T')) { return false; }
    if (base === 'ip' && !args.some((a) => /^(a|addr|address|r|route|link|neigh|-br|-s)$/.test(a)) || base === 'ip' && args.some((a) => /^(add|del|delete|set|flush|change|replace)$/.test(a))) { return false; }
    if (base === 'env' && args.length) { return false; }
  }
  return true;
}

const POWER = new Set(['reboot', 'shutdown', 'poweroff', 'halt']);
const DISK = new Set(['wipefs', 'fdisk', 'sfdisk', 'parted', 'mkswap']);
const SYSTEM_PATH = /^(\/|\/\*|~|~\/|~\/\*|\/(etc|usr|var|boot|bin|sbin|lib|lib32|lib64|home|root|opt|srv|dev|proc|sys)\/?\*?)$/;

/**
 * Why a remote command could wreck the server (reboot, formatting, wiping system folders), or undefined.
 * These still ask the user first in every mode, including Auto-execute. Checks each command word, not text, so
 * "echo reboot" is fine.
 */
export function catastrophicReason(command: unknown): string | undefined {
  const text = String(command ?? '');
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(text)) { return 'fork bomb'; }
  for (const { words: all } of shellCommands(text)) {
    let words = all;
    while (words.length && (words[0] === 'sudo' || words[0] === 'env' || words[0] === 'nohup' || words[0] === 'exec' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || (words[0].startsWith('-') && words.length > 1))) { words = words.slice(1); }
    const [cmd, ...args] = words;
    if (!cmd) { continue; }
    const base = cmd.split('/').pop()!;
    if (POWER.has(base)) { return `${base} the server`; }
    if (base === 'systemctl' && args.some((a) => POWER.has(a))) { return 'reboot or power off the server'; }
    if (base === 'init' && (args[0] === '0' || args[0] === '6')) { return 'reboot or power off the server'; }
    if (base.startsWith('mkfs') || DISK.has(base)) { return 'format or repartition a disk'; }
    if (base === 'dd' && args.some((a) => /^of=\/dev\//.test(a))) { return 'overwrite a disk device'; }
    if (base === 'rm' && args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive') && args.some((a) => SYSTEM_PATH.test(a))) { return 'delete a system folder recursively'; }
    if ((base === 'chmod' || base === 'chown') && args.some((a) => a === '-R' || a === '--recursive') && args.some((a) => a === '/' || a === '/*')) { return `${base} the whole file system`; }
  }
  return undefined;
}

const MAX_TIMEOUT_S = 1800;
const JOB_LINES = 4000;
const MAX_JOBS = 20;

const GUIDE = `Runs a shell command on a configured Linux server over SSH (never use run_command with ssh, scp or sshpass: they cannot authenticate here).
How to work on servers like an experienced operator:
- Start with list_servers to see the saved servers (name, user@host) and their notes (paths, service names, health URLs). A server can be given by its name or its IP address. Credentials are already saved: never ask the user for a password or key in the chat. If the address the user gave is not saved and is not a typo of a saved one, call connect_server: it asks the user for the credentials securely, tests the connection and saves the server, then continue with remote_exec.
- Look before you change: check state first (systemctl status, docker ps, df -h, free -m, git -C <dir> log -1, ls).
- Commands run non-interactively: never start editors, pagers or prompts (use --no-pager, -y, DEBIAN_FRONTEND=noninteractive). If a tool is missing from PATH, run it through bash -lc '...'.
- sudo: use "sudo -S -p '' <command>" and set use_sudo_password: true; the stored password is supplied privately and you never see it.
- Anything longer than about two minutes (builds, docker compose up, migrations, deploys) must run with background: true, then follow it with remote_job_output (it can wait for new output).
- Deploying: 1) note the current version or commit and back up what you replace (cp -a to a timestamped folder, or keep the previous release), 2) upload the build with remote_upload or pull it on the server, 3) apply it (install, migrate, restart), 4) verify (service status, journalctl -u <svc> -n 50 --no-pager, curl the health URL), 5) if verification fails, roll back to the backup and report. Never finish without verifying.
- Destructive commands (rm -rf, dropping data, reboot, firewall changes) need the user's explicit request.
- Report the exit code and the important output lines, not the whole log.`;

interface Job { id: string; server: string; command: string; lines: string[]; partial: string; status: 'running' | 'exited' | 'failed' | 'stopped'; code?: number | null; error?: string; started: number; ended?: number; stop: AbortController; waiters: Array<() => void> }

export function createRemoteTools(host: RemoteHost): { tools: Tool[]; jobs: () => Job[]; dispose(): void } {
  const jobs = new Map<string, Job>();
  const known = (name: unknown): RemoteServerInfo => {
    const all = host.servers();
    const s = resolveServer(all, name);
    if (!s) { throw new Error(unknownServerMessage(all, name)); }
    return s;
  };
  const push = (job: Job, chunk: string) => {
    const text = job.partial + chunk;
    const parts = text.split(/\r?\n/);
    job.partial = parts.pop() ?? '';
    job.lines.push(...parts);
    if (job.lines.length > JOB_LINES) { job.lines.splice(0, job.lines.length - JOB_LINES); }
    for (const w of job.waiters.splice(0)) { w(); }
  };
  const finish = (job: Job) => { if (job.partial) { job.lines.push(job.partial); job.partial = ''; } job.ended = Date.now(); for (const w of job.waiters.splice(0)) { w(); } };
  const summary = (r: { code: number | null; signal?: string; timedOut: boolean; cancelled: boolean; truncated: boolean; ms: number }) =>
    `[${r.timedOut ? 'timed out' : r.cancelled ? 'cancelled' : `exit ${r.code ?? r.signal ?? '?'}`} after ${(r.ms / 1000).toFixed(1)}s${r.truncated ? '; earlier output was cut' : ''}]`;
  const jobView = (j: Job, lines: number) => {
    const head = `Job ${j.id} on ${j.server}: ${j.status}${j.code !== undefined ? ` (exit ${j.code})` : ''}${j.error ? ` — ${j.error}` : ''}, ${(((j.ended ?? Date.now()) - j.started) / 1000).toFixed(0)}s\n$ ${j.command}`;
    const tail = [...j.lines, ...(j.partial ? [j.partial] : [])].slice(-lines).join('\n');
    return clip(`${head}\n${tail || '(no output yet)'}`);
  };

  const tools: Tool[] = [
    {
      kind: 'read',
      spec: fnSpec('list_servers', 'List the Linux servers you can reach with remote_exec, with their notes (deploy paths, service names, health checks).', {}, []),
      describe: () => 'List servers',
      async run() {
        const all = host.servers();
        if (!all.length) { return 'No Linux servers are configured. Ask the user to add one in the Infraon sidebar (Servers → Add server).'; }
        return all.map((s) => `- ${s.name}: ${s.user}@${s.host}:${s.port}${s.notes ? `\n  Notes: ${s.notes.replace(/\n/g, '\n  ')}` : ''}`).join('\n');
      },
    },
    {
      kind: 'exec',
      spec: fnSpec('remote_exec', GUIDE, {
        server: { type: 'string', description: 'The server: its name from list_servers, its IP address or host name, or user@host.' },
        command: { type: 'string', description: 'Shell command to run.' },
        cwd: { type: 'string', description: 'Remote working directory (optional).' },
        timeout_seconds: { type: 'number', description: `Time limit for foreground commands (default ${DEFAULT_TIMEOUT_MS / 1000}, max ${MAX_TIMEOUT_S}).` },
        background: { type: 'boolean', description: 'Start it as a job and return at once; follow it with remote_job_output.' },
        use_sudo_password: { type: 'boolean', description: 'Supply the server\'s stored password on standard input (for sudo -S).' },
      }, ['server', 'command']),
      describe: (a) => `Remote ${String(a.server ?? '?')}: ${String(a.command ?? '')}`,
      async run(a, ctx) {
        const s = known(a.server);
        const command = String(a.command ?? '').trim();
        if (!command) { throw new Error('command must not be empty.'); }
        const t = await host.target(s.name);
        let stdin: string | undefined;
        if (a.use_sudo_password === true) {
          if (!t.password) { throw new Error(`${s.name} uses key authentication, so there is no stored password for sudo.`); }
          stdin = `${t.password}\n`;
        }
        const cwd = a.cwd ? String(a.cwd) : undefined;
        if (a.background === true) {
          const running = [...jobs.values()].filter((j) => j.status === 'running').length;
          if (running >= MAX_JOBS) { throw new Error(`${running} jobs are already running; stop one with remote_job_stop first.`); }
          const id = `job-${randomBytes(3).toString('hex')}`;
          const job: Job = { id, server: s.name, command, lines: [], partial: '', status: 'running', started: Date.now(), stop: new AbortController(), waiters: [] };
          jobs.set(id, job);
          host.pool.exec(t, command, { cwd, stdin, timeoutMs: 24 * 3600_000, signal: job.stop.signal, onData: (c) => push(job, c), maxBytes: 64 * 1024 }).then((r) => {
            job.code = r.code; job.status = r.cancelled ? 'stopped' : 'exited'; finish(job);
          }, (e) => { job.status = 'failed'; job.error = e.message ?? String(e); finish(job); });
          return `Started ${id} on ${s.name}. Follow it with remote_job_output (job_id "${id}", wait_seconds up to 60) until it finishes, then verify the result.`;
        }
        const timeoutMs = Math.min(MAX_TIMEOUT_S, Math.max(1, Number(a.timeout_seconds) || DEFAULT_TIMEOUT_MS / 1000)) * 1000;
        const r = await host.pool.exec(t, command, { cwd, stdin, timeoutMs, signal: ctx.signal });
        if (r.cancelled) { throw new Error('Cancelled'); }
        return clip(`${r.output.replace(/\s+$/, '') || '(no output)'}\n${summary(r)}${r.timedOut ? '\nThe command was stopped at the time limit. Rerun it with background: true if it needs longer.' : ''}`);
      },
    },
    {
      kind: 'read',
      spec: fnSpec('remote_job_output', 'Show the status and latest output of background jobs started with remote_exec. With wait_seconds it waits for new output or for the job to finish, so you do not need to poll quickly.', {
        job_id: { type: 'string', description: 'Job id; omit to list every job.' },
        lines: { type: 'number', description: 'How many of the last lines to show (default 80).' },
        wait_seconds: { type: 'number', description: 'Wait up to this long (max 60) for new output or completion.' },
      }, []),
      describe: (a) => (a.job_id ? `Job output ${a.job_id}` : 'Remote jobs'),
      async run(a, ctx) {
        if (!a.job_id) {
          const all = [...jobs.values()];
          return all.length ? all.map((j) => `${j.id} [${j.status}${j.code !== undefined ? ` ${j.code}` : ''}] ${j.server}: ${j.command}`).join('\n') : 'No remote jobs.';
        }
        const job = jobs.get(String(a.job_id));
        if (!job) { throw new Error(`No job "${a.job_id}".`); }
        const wait = Math.min(60, Math.max(0, Number(a.wait_seconds) || 0)) * 1000;
        if (wait && job.status === 'running') {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, wait);
            function done() { clearTimeout(timer); ctx.signal.removeEventListener('abort', done); resolve(); }
            // Wake on completion, or once enough new output has arrived.
            const before = job.lines.length;
            const check = () => { if (job.status !== 'running' || job.lines.length - before >= 20) { done(); } else { job.waiters.push(check); } };
            job.waiters.push(check);
            ctx.signal.addEventListener('abort', done, { once: true });
          });
        }
        return jobView(job, Math.min(1000, Math.max(1, Number(a.lines) || 80)));
      },
    },
    {
      kind: 'exec',
      spec: fnSpec('remote_job_stop', 'Stop a running background job.', { job_id: { type: 'string' } }, ['job_id']),
      describe: (a) => `Stop job ${a.job_id}`,
      async run(a) {
        const job = jobs.get(String(a.job_id));
        if (!job) { throw new Error(`No job "${a.job_id}".`); }
        if (job.status !== 'running') { return `Job ${job.id} already ${job.status}.`; }
        job.stop.abort();
        return `Stopping job ${job.id}.`;
      },
    },
    {
      kind: 'exec',
      spec: fnSpec('remote_upload', 'Upload a workspace file or folder to a server over SFTP (folders keep their structure; .git, node_modules and similar are skipped). Prefer uploading one archive for large builds.', {
        server: { type: 'string', description: 'Server name, IP or host name.' }, local_path: { type: 'string', description: 'File or folder in the workspace.' }, remote_path: { type: 'string', description: 'Destination file, or destination folder for a folder.' },
      }, ['server', 'local_path', 'remote_path']),
      describe: (a) => `Upload ${a.local_path} → ${a.server}:${a.remote_path}`,
      async run(a, ctx) {
        const s = known(a.server);
        const r = await host.pool.upload(await host.target(s.name), resolveSafe(ctx.root, String(a.local_path ?? '')), String(a.remote_path ?? ''), ctx.signal);
        return `Uploaded ${r.files} file${r.files === 1 ? '' : 's'} (${(r.bytes / 1024).toFixed(1)} KB) to ${s.name}:${a.remote_path}.${r.skipped.length ? ` Skipped: ${r.skipped.slice(0, 10).join(', ')}` : ''}`;
      },
    },
    {
      kind: 'edit',
      spec: fnSpec('remote_download', 'Download a file or folder from a server into the workspace (for logs, configs or backups). Existing local files are overwritten and can be restored with rewind.', {
        server: { type: 'string', description: 'Server name, IP or host name.' }, remote_path: { type: 'string' }, local_path: { type: 'string', description: 'Destination in the workspace.' },
      }, ['server', 'remote_path', 'local_path']),
      describe: (a) => `Download ${a.server}:${a.remote_path} → ${a.local_path}`,
      async run(a, ctx) {
        const s = known(a.server);
        const r = await host.pool.download(await host.target(s.name), String(a.remote_path ?? ''), resolveSafe(ctx.root, String(a.local_path ?? '')), (abs) => {
          resolveSafe(ctx.root, path.relative(ctx.root, abs));
          return ctx.snapshot(abs);
        }, ctx.signal);
        return `Downloaded ${r.files} file${r.files === 1 ? '' : 's'} (${(r.bytes / 1024).toFixed(1)} KB) to ${a.local_path}.`;
      },
    },
    {
      kind: 'read',
      spec: fnSpec('remote_read_file', 'Read a text file on a server (up to 2 MB), optionally a 1-based line range.', {
        server: { type: 'string', description: 'Server name, IP or host name.' }, path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' },
      }, ['server', 'path']),
      describe: (a) => `Read ${a.server}:${a.path}`,
      async run(a) {
        const s = known(a.server);
        const lines = (await host.pool.readFile(await host.target(s.name), String(a.path ?? ''))).replace(/\r?\n$/, '').split('\n');
        const from = Math.max(1, Number(a.start_line) || 1), to = Math.min(lines.length, Number(a.end_line) || lines.length);
        return clip(lines.slice(from - 1, to).map((l, i) => `${from + i}\t${l}`).join('\n'));
      },
    },
  ];
  return {
    tools,
    jobs: () => [...jobs.values()],
    dispose() { for (const j of jobs.values()) { if (j.status === 'running') { j.stop.abort(); } } },
  };
}
