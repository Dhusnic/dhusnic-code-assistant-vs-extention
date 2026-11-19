import * as vscode from 'vscode';
import type { ChildProcess } from 'child_process';
import { Tool, ToolCtx, fnSpec } from '../../core/tool';

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 4000;
const MAX_PARTIAL_CHARS = 64000;
const MAX_OUTPUT_CHARS = 20000;
const INTEGRATION_WAIT_MS = 3000;
const FOREGROUND_WAIT_MS = 120000;
const STOP_GRACE_MS = 2000;
const END_GRACE_MS = 500;
const KEEP_JOBS = 20;
const KEEP_TERMINALS = 5;

const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\^_]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const READY_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-z0-9.-]+):\d{2,5}(?:\/[^\s'")\]]*)?/i;
const READY_PORT = /\b(?:listening|running|started|serving|ready)\b.*?\bport\b\s*:?\s*(\d{2,5})\b|\bport\s*:?\s*(\d{2,5})\b.*?\b(?:listening|ready|started)\b|\blistening (?:on|at)\s+(?:[\w.*[\]-]*:)?(\d{2,5})\b/i;

/** Terminal text as readable lines: colours and cursor moves removed, a carriage return overwrites its line. */
function tidy(raw: string): string {
  const line = raw.replace(ANSI, '').replace(/\r+$/, '');
  return line.slice(line.lastIndexOf('\r') + 1).replace(CONTROL, '').slice(0, MAX_LINE_CHARS);
}

function detectReady(line: string): string | undefined {
  const url = READY_URL.exec(line);
  if (url) { return url[0]; }
  const port = READY_PORT.exec(line);
  return port ? `port ${port[1] ?? port[2] ?? port[3]}` : undefined;
}

/** Ring buffer of the most recent complete lines, plus the line still being written. */
class LineBuffer {
  private lines: string[] = [];
  private head = 0;
  private partial = '';
  constructor(private onLine: (line: string) => void) {}

  write(chunk: string): void {
    const parts = (this.partial + chunk).split('\n');
    this.partial = parts.pop() ?? '';
    for (const p of parts) { this.add(tidy(p)); }
    if (this.partial.length > MAX_PARTIAL_CHARS) { this.add(tidy(this.partial)); this.partial = ''; }
  }
  flush(): void {
    if (tidy(this.partial)) { this.add(tidy(this.partial)); }
    this.partial = '';
  }
  private add(line: string): void {
    if (this.lines.length < MAX_LINES) { this.lines.push(line); } else { this.lines[this.head] = line; this.head = (this.head + 1) % MAX_LINES; }
    this.onLine(line);
  }
  tail(n: number): string[] {
    const ordered = [...this.lines.slice(this.head), ...this.lines.slice(0, this.head)];
    const open = tidy(this.partial);
    return (open ? [...ordered, open] : ordered).slice(-Math.max(1, n));
  }
}

type JobStatus = 'running' | 'exited' | 'stopped';
interface Job {
  id: string; name: string; command: string; cwd: string; background: boolean; status: JobStatus; exitCode?: number; note?: string;
  ready?: string; out: LineBuffer; terminal?: vscode.Terminal; stopping: boolean; interrupt?: () => void; stopTimer?: NodeJS.Timeout;
  cleanup: Array<() => void>; release: Array<() => void>; done: Promise<void>; resolve: () => void;
}

function killTree(p: ChildProcess): void {
  if (p.pid === undefined) { return; }
  if (process.platform === 'win32') {
    const pid = String(p.pid);
    void import('child_process').then(({ spawn }) => spawn('taskkill', ['/pid', pid, '/T', '/F'], { windowsHide: true }).on('error', () => p.kill()));
    return;
  }
  try { process.kill(-p.pid, 'SIGTERM'); } catch { p.kill(); }
}

/** Output for the model: the end of a long log matters most, so that is the part kept. */
async function clipTail(lines: string[]): Promise<string> {
  const { clip } = await import('../../core/fstools');
  const text = lines.join('\n');
  return clip(text.length > MAX_OUTPUT_CHARS ? `...[earlier output omitted]\n${text.slice(-MAX_OUTPUT_CHARS)}` : text, MAX_OUTPUT_CHARS + 64);
}

export function createTerminalRunner(): { tools(): Tool[]; dispose(): void } {
  const jobs = new Map<string, Job>();
  let seq = 0;
  let disposed = false;
  let closeSub: vscode.Disposable | undefined;

  const finish = (job: Job, status: JobStatus, exitCode?: number, note?: string): void => {
    if (job.status !== 'running') { return; }
    job.out.flush();
    job.status = job.stopping ? 'stopped' : status;
    job.exitCode = exitCode;
    job.note = note;
    job.interrupt = undefined;
    clearTimeout(job.stopTimer);
    for (const fn of job.cleanup.splice(0)) { fn(); }
    job.resolve();
  };

  const stop = (job: Job): void => {
    if (job.status !== 'running' || job.stopping) { return; }
    job.stopping = true;
    if (!job.interrupt) { finish(job, 'stopped'); return; }
    job.interrupt();
    job.stopTimer = setTimeout(() => { finish(job, 'stopped'); job.terminal?.dispose(); }, STOP_GRACE_MS);
  };

  const prune = (): void => {
    const ended = [...jobs.values()].filter((j) => j.status !== 'running');
    ended.slice(0, Math.max(0, ended.length - KEEP_TERMINALS)).forEach((j) => { j.terminal?.dispose(); j.terminal = undefined; });
    ended.slice(0, Math.max(0, jobs.size - KEEP_JOBS)).forEach((j) => { for (const fn of j.release.splice(0)) { fn(); } jobs.delete(j.id); });
  };

  const newJob = (command: string, name: unknown, cwd: string, background: boolean): Job => {
    closeSub ??= vscode.window.onDidCloseTerminal((t) => {
      for (const j of jobs.values()) { if (j.terminal === t) { finish(j, 'exited', undefined, 'terminal was closed'); } }
    });
    prune();
    let resolve = (): void => undefined;
    const done = new Promise<void>((r) => { resolve = r; });
    const id = `term-${++seq}`;
    const job: Job = {
      id, name: String(name || `Infraon: ${command.slice(0, 32)}`), command, cwd, background, status: 'running', stopping: false,
      out: new LineBuffer((line) => { job.ready ??= detectReady(line); }), cleanup: [], release: [], done, resolve,
    };
    jobs.set(id, job);
    return job;
  };

  /** Resolves with the terminal's shell integration, or undefined if none shows up in time. */
  const waitForIntegration = (term: vscode.Terminal): Promise<any> => new Promise((resolve) => {
    const now = (term as any).shellIntegration;
    if (now) { resolve(now); return; }
    const sub = (vscode.window as any).onDidChangeTerminalShellIntegration((e: any) => {
      if (e.terminal === term) { clearTimeout(timer); sub.dispose(); resolve(e.shellIntegration); }
    });
    const timer = setTimeout(() => { sub.dispose(); resolve((term as any).shellIntegration); }, INTEGRATION_WAIT_MS);
  });

  const runIntegrated = (job: Job, term: vscode.Terminal, integration: any): void => {
    job.terminal = term;
    term.show(true);
    job.interrupt = () => term.sendText('\x03', false);
    let execution: any;
    let streamDone = false;
    let ended = false;
    let code: number | undefined;
    let grace: NodeJS.Timeout | undefined;
    const complete = (): void => finish(job, 'exited', code);
    const settleSoon = (): void => { clearTimeout(grace); grace = setTimeout(complete, END_GRACE_MS); };
    const sub = (vscode.window as any).onDidEndTerminalShellExecution((e: any) => {
      if (e.execution !== execution) { return; }
      ended = true;
      code = e.exitCode;
      if (streamDone) { complete(); } else { settleSoon(); }
    });
    job.cleanup.push(() => { sub.dispose(); clearTimeout(grace); });
    execution = integration.executeCommand(job.command);
    void (async () => {
      try { for await (const chunk of execution.read()) { job.out.write(String(chunk)); } } catch { /* the terminal went away */ }
      streamDone = true;
      if (ended) { complete(); } else { settleSoon(); }
    })();
  };

  /** No shell integration: runs the command as a child process and mirrors it into a terminal the user can see. */
  const runMirrored = async (job: Job): Promise<void> => {
    const { spawn } = await import('child_process');
    if (job.status !== 'running') { return; }
    const writer = new vscode.EventEmitter<string>();
    job.release.push(() => writer.dispose());
    let opened = false;
    let backlog = '';
    const mirror = (s: string): void => {
      const text = s.replace(/\r?\n/g, '\r\n');
      if (opened) { writer.fire(text); } else { backlog = (backlog + text).slice(-MAX_PARTIAL_CHARS); }
    };
    const isWin = process.platform === 'win32';
    // powershell -Command reduces every failure to exit 1, so the real exit code is passed on explicitly.
    const script = `${job.command}\n$ok = $?; if ($ok) { exit 0 }; if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1`;
    const child = spawn(isWin ? 'powershell.exe' : 'bash', isWin ? ['-NoProfile', '-Command', script] : ['-lc', job.command],
      { cwd: job.cwd, detached: !isWin, windowsHide: true });
    job.interrupt = () => killTree(child);
    const pty: vscode.Pseudoterminal = {
      onDidWrite: writer.event,
      open: () => { opened = true; writer.fire(backlog); backlog = ''; },
      close: () => { if (job.status === 'running') { killTree(child); } },
      handleInput: (d) => { if (d === '\x03') { stop(job); } },
    };
    job.terminal = vscode.window.createTerminal({ name: job.name, pty });
    job.terminal.show(true);
    mirror(`> ${job.command}\n`);
    const onData = (s: string): void => { job.out.write(s); mirror(s); };
    child.stdout?.setEncoding('utf8').on('data', onData);
    child.stderr?.setEncoding('utf8').on('data', onData);
    child.on('error', (e) => { onData(`ERROR: ${e.message}\n`); finish(job, 'exited'); });
    child.on('close', (code) => { mirror(`\n[exit ${code ?? 'unknown'}]\n`); finish(job, 'exited', code ?? undefined); });
  };

  const launch = async (job: Job): Promise<void> => {
    try {
      const win = vscode.window as any;
      if (typeof win.onDidChangeTerminalShellIntegration === 'function' && typeof win.onDidEndTerminalShellExecution === 'function') {
        const term = vscode.window.createTerminal({ name: job.name, cwd: job.cwd });
        const integration = await waitForIntegration(term);
        if (job.status !== 'running' || disposed) { term.dispose(); return; }
        if (integration) { runIntegrated(job, term, integration); return; }
        term.dispose();
      }
      await runMirrored(job);
    } catch (e: any) {
      job.out.write(`ERROR: ${e?.message ?? e}\n`);
      finish(job, 'exited');
    }
  };

  const statusOf = (j: Job): string => (j.status === 'running' ? 'running' : j.status === 'stopped' ? 'stopped' : `exited ${j.exitCode ?? 'unknown'}`);
  const summary = (j: Job): string =>
    `${j.id}\t${statusOf(j)}${j.background ? '\tbackground' : ''}${j.ready ? `\tready: ${j.ready}` : ''}\t${j.command.slice(0, 120)}`;

  const foreground = async (job: Job, ctx: ToolCtx): Promise<string> => {
    const onAbort = (): void => stop(job);
    if (ctx.signal.aborted) { stop(job); } else { ctx.signal.addEventListener('abort', onAbort, { once: true }); }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((r) => { timer = setTimeout(() => r(true), FOREGROUND_WAIT_MS); });
    const late = await Promise.race([job.done.then(() => false), timedOut]);
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
    const output = await clipTail(job.out.tail(MAX_LINES));
    if (late) { return `${output}\n[still running after ${FOREGROUND_WAIT_MS / 1000}s as ${job.id}; use terminal_output or stop_terminal]`; }
    if (job.status === 'stopped') { return `${output}\n[stopped]`; }
    return `${output}\n[exit ${job.exitCode ?? 'unknown'}]${job.note ? ` (${job.note})` : ''}`;
  };

  return {
    tools: () => [
      {
        kind: 'exec',
        spec: fnSpec('run_in_terminal',
          'Run a shell command in a terminal the user can see. Set background for servers and watchers: it returns an id at once; read progress with terminal_output.',
          { command: { type: 'string' }, background: { type: 'boolean', description: 'return at once and keep running' }, name: { type: 'string', description: 'terminal title' } }, ['command']),
        describe: (a) => `Run in terminal${a.background ? ' (background)' : ''}: ${a.command}`,
        async run(a, ctx) {
          const command = String(a.command ?? '').trim();
          if (!command) { return 'ERROR: command must not be empty.'; }
          if (disposed) { return 'ERROR: the terminal runner has shut down.'; }
          const job = newJob(command, a.name, ctx.root, a.background === true);
          void launch(job);
          if (job.background) { return `Started ${job.id} in the background ("${job.name}"). Use terminal_output with this id to read its output.`; }
          return foreground(job, ctx);
        },
      },
      {
        kind: 'read',
        spec: fnSpec('terminal_output', 'Read recent output of a terminal command by id. With no id, lists all terminal commands and their status.',
          { id: { type: 'string' }, lines: { type: 'number', description: `lines from the end (default 200, at most ${MAX_LINES})` } }, []),
        describe: (a) => (a.id ? `Read terminal ${a.id}` : 'List terminals'),
        async run(a) {
          if (!a.id) { return [...jobs.values()].map(summary).join('\n') || '(no terminal commands)'; }
          const job = jobs.get(String(a.id));
          if (!job) { return `ERROR: no terminal "${a.id}". Call terminal_output with no id to list them.`; }
          const n = typeof a.lines === 'number' && a.lines > 0 ? Math.min(Math.floor(a.lines), MAX_LINES) : 200;
          return `${summary(job)}${job.note ? ` (${job.note})` : ''}\n${await clipTail(job.out.tail(n))}`;
        },
      },
      {
        kind: 'exec',
        spec: fnSpec('stop_terminal', 'Stop a running terminal command by id.', { id: { type: 'string' } }, ['id']),
        describe: (a) => `Stop terminal ${a.id}`,
        async run(a) {
          const job = jobs.get(String(a.id));
          if (!job) { return `ERROR: no terminal "${a.id}".`; }
          if (job.status !== 'running') { return `${job.id} already ended (${statusOf(job)}).`; }
          stop(job);
          await job.done;
          return `Stopped ${job.id}.`;
        },
      },
    ],
    dispose() {
      disposed = true;
      closeSub?.dispose();
      for (const job of jobs.values()) {
        job.stopping = true;
        job.interrupt?.();
        finish(job, 'stopped');
        job.terminal?.dispose();
        for (const fn of job.release.splice(0)) { fn(); }
      }
      jobs.clear();
    },
  };
}
