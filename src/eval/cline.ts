/**
 * Runs the Cline CLI (npm package "cline", 3.x) on an eval task so its results can be compared with this extension's
 * agent on the same tasks, model, sampling and time limit. Used by runner.ts when the agent is "cline".
 *
 * Isolation and containment, because the code under test must not leave the enterprise:
 *  - Cline gets its own state directory (--data-dir, absolute: Cline resolves relative paths against --cwd) with a
 *    providers.json that points the openai-compatible provider at the local metering proxy (meter.ts) with a
 *    placeholder key. The real key and the user's ~/.cline are never used.
 *  - The provider and model are always passed on the command line: without -P, Cline 3 silently falls back to its
 *    own cloud provider, and with -P but no stored baseUrl to api.openai.com.
 *  - Its environment sets HTTPS_PROXY/HTTP_PROXY to a closed loopback port with NO_PROXY for loopback only, so any
 *    call to anything but the local proxy (telemetry, update checks, a wrong provider) fails instead of leaving the
 *    machine. DO_NOT_TRACK and CLINE_NO_AUTO_UPDATE are set as well, and the gateway key variable is removed.
 *
 * Cline runs in --yolo --json mode; every stdout line is one JSON event. Tool calls are counted from
 * agent_event/content_start events that carry a toolName, and the final run_result gives the finish reason.
 * On the time limit the whole process tree is killed (taskkill /T on Windows).
 */
import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface ClineConfig {
  /** The `cline` launcher script, the native cline binary, or a folder that contains node_modules/cline. */
  bin: string;
  /** Base URL the agent must use (the metering proxy). */
  baseUrl: string;
  /** Key Cline sends (the proxy's placeholder). */
  apiKey: string;
  model: string;
  /** Absolute folder for Cline's isolated state. */
  home: string;
  /** Cline --thinking level; omitted means the provider default. */
  thinking?: string;
}

export interface ClineRun {
  exitCode: number | null;
  timedOut: boolean;
  finishReason?: string;
  iterations?: number;
  toolCalls: Record<string, number>;
  /** Last assistant text or error, for the log. */
  lastText: string;
  /** Raw JSON event lines (for the log). */
  events: string[];
  stderr: string;
}

/** How to start Cline: a native .exe runs directly, a launcher script runs under this Node. */
export function clineLauncher(bin: string): { cmd: string; args: string[] } {
  let p = path.resolve(bin);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    const cands = [path.join(p, 'node_modules', 'cline', 'bin', 'cline'), path.join(p, 'bin', 'cline'), path.join(p, 'cline')];
    const hit = cands.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!hit) { throw new Error(`no cline launcher under ${p}`); }
    p = hit;
  }
  if (!fs.existsSync(p)) { throw new Error(`cline not found at ${p}`); }
  return /\.exe$/i.test(p) ? { cmd: p, args: [] } : { cmd: process.execPath, args: [p] };
}

/** Finds an installed cline: npm's global folder (from `cline.cmd`/`cline` on PATH). */
export function findCline(): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const name of ['cline.cmd', 'cline']) {
      if (fs.existsSync(path.join(d, name))) {
        const launcher = path.join(d, 'node_modules', 'cline', 'bin', 'cline');
        if (fs.existsSync(launcher)) { return launcher; }
      }
    }
  }
  return undefined;
}

/** Writes Cline's isolated provider settings (the same file `cline auth` writes). */
export function setupClineHome(cfg: ClineConfig): void {
  const settings = path.join(cfg.home, 'data', 'settings');
  fs.mkdirSync(settings, { recursive: true });
  const providers = {
    version: 1,
    lastUsedProvider: 'openai-compatible',
    modes: {},
    providers: {
      'openai-compatible': {
        settings: { provider: 'openai-compatible', apiKey: cfg.apiKey, model: cfg.model, baseUrl: cfg.baseUrl },
        updatedAt: new Date().toISOString(),
        tokenSource: 'manual',
      },
    },
  };
  fs.writeFileSync(path.join(settings, 'providers.json'), `${JSON.stringify(providers, null, 2)}\n`);
}

/** Environment for the Cline process: no route out except loopback, no telemetry, no gateway secrets. */
export function clineEnv(cfg: ClineConfig, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of Object.keys(env)) {
    if (/^INFRAON_EVAL_|^OPENAI_|^ANTHROPIC_|^CLINE_API_KEY$/i.test(k) || /^(https?|all|no)_proxy$/i.test(k)) { delete env[k]; }
  }
  const dead = 'http://127.0.0.1:9';
  Object.assign(env, {
    HTTPS_PROXY: dead, HTTP_PROXY: dead, ALL_PROXY: dead, https_proxy: dead, http_proxy: dead, all_proxy: dead,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    DO_NOT_TRACK: '1', CLINE_NO_AUTO_UPDATE: '1', CLINE_NO_INTERACTIVE: '1',
    CLINE_PROVIDER_SETTINGS_PATH: path.join(cfg.home, 'data', 'settings', 'providers.json'),
  });
  return env;
}

export function clineArgs(cfg: ClineConfig, cwd: string, prompt: string, timeoutS: number): string[] {
  return [
    '--yolo', '--json', '-P', 'openai-compatible', '-m', cfg.model, '-k', cfg.apiKey,
    '-c', path.resolve(cwd), '--data-dir', path.join(cfg.home, 'data'),
    '-t', String(Math.max(1, Math.floor(timeoutS))),
    ...(cfg.thinking ? ['--thinking', cfg.thinking] : []),
    prompt,
  ];
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) { return; }
  if (process.platform === 'win32') { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); }
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

/** Parses Cline's JSON event lines into tool counts, finish reason and the last text. */
export function summarizeClineEvents(lines: string[]): Pick<ClineRun, 'finishReason' | 'iterations' | 'toolCalls' | 'lastText'> {
  const toolCalls: Record<string, number> = {};
  let finishReason: string | undefined;
  let iterations: number | undefined;
  let lastText = '';
  for (const line of lines) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    const e = ev?.event;
    if (ev?.type === 'agent_event' && e?.type === 'content_start' && typeof e.toolName === 'string') {
      toolCalls[e.toolName] = (toolCalls[e.toolName] ?? 0) + 1;
    }
    if (ev?.type === 'run_result') {
      finishReason = ev.finishReason;
      iterations = ev.iterations;
      if (typeof ev.text === 'string' && ev.text) { lastText = ev.text; }
    }
    if (ev?.type === 'error' && typeof ev.message === 'string') { lastText = ev.message; }
  }
  return { finishReason, iterations, toolCalls, lastText };
}

/** Runs Cline on one prompt in `cwd`; resolves when it exits or after `limitMs` (then the tree is killed). */
export function runCline(cfg: ClineConfig, cwd: string, prompt: string, limitMs: number, onLine?: (l: string) => void): Promise<ClineRun> {
  const { cmd, args } = clineLauncher(cfg.bin);
  // Cline's own timeout fires a little before ours, so it can stop cleanly.
  const child = spawn(cmd, [...args, ...clineArgs(cfg, cwd, prompt, Math.max(1, limitMs / 1000 - 5))], {
    cwd, env: clineEnv(cfg), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  const events: string[] = [];
  let buf = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { events.push(line); onLine?.(line); }
    }
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (d: string) => { if (stderr.length < 20_000) { stderr += d; } });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, limitMs);
  return new Promise((resolve) => {
    const done = (code: number | null) => {
      clearTimeout(timer);
      if (buf.trim()) { events.push(buf.trim()); }
      resolve({ exitCode: code, timedOut, events, stderr, ...summarizeClineEvents(events) });
    };
    child.on('error', (e) => { stderr += `\n${e.message}`; done(null); });
    child.on('close', (code) => done(code));
  });
}
