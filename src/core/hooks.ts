import { spawn as nodeSpawn, ChildProcess } from 'child_process';
import { createHash } from 'crypto';

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SubagentStop' | 'Notification';
export const HOOK_EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'Notification'];

export interface HookCommand { type: 'command'; command: string; /** Seconds. */ timeout?: number }
export interface HookMatcher { matcher: string; hooks: HookCommand[] }
export type HookConfig = Partial<Record<HookEvent, HookMatcher[]>>;

export interface HookResult { command: string; code: number | null; ms: number; stdout: string; stderr: string; timedOut: boolean }
export interface HookRunResult { blocked: boolean; reason?: string; context: string[]; results: HookResult[] }

export type HookSpawnFn = (file: string, args: string[], options: any) => ChildProcess;
export interface HookRunOptions { cwd: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; spawnFn?: HookSpawnFn }

const DEFAULT_TIMEOUT_S = 60;
const OUTPUT_CAP = 64 * 1024;
const CLOSE_GRACE_MS = 500;
const KILL_GRACE_MS = 2000;
const CAN_BLOCK = new Set<HookEvent>(['PreToolUse', 'UserPromptSubmit', 'Stop']);
const USES_MATCHER = new Set<HookEvent>(['PreToolUse', 'PostToolUse']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const matchesAll = (m: string): boolean => m === '' || m === '*';

/** Validates a raw `hooks` object. Bad entries are skipped and reported; never throws. */
export function parseHooks(raw: unknown): { config: HookConfig; errors: string[] } {
  const config: HookConfig = {};
  const errors: string[] = [];
  if (raw === undefined || raw === null) { return { config, errors }; }
  if (!isObject(raw)) { return { config, errors: ['hooks must be an object'] }; }
  for (const [event, entries] of Object.entries(raw)) {
    if (!(HOOK_EVENTS as string[]).includes(event)) { errors.push(`hooks: unknown event "${event}"`); continue; }
    if (!Array.isArray(entries)) { errors.push(`hooks.${event} must be an array`); continue; }
    const parsed: HookMatcher[] = [];
    entries.forEach((entry, i) => {
      const at = `hooks.${event}[${i}]`;
      if (!isObject(entry)) { errors.push(`${at} must be an object`); return; }
      const matcher = entry.matcher ?? '';
      if (typeof matcher !== 'string') { errors.push(`${at}.matcher must be a string`); return; }
      if (!matchesAll(matcher)) {
        try { new RegExp(matcher); } catch { errors.push(`${at}.matcher is not a valid regex: ${matcher}`); return; }
      }
      if (!Array.isArray(entry.hooks)) { errors.push(`${at}.hooks must be an array`); return; }
      const hooks: HookCommand[] = [];
      entry.hooks.forEach((h: unknown, j: number) => {
        const hat = `${at}.hooks[${j}]`;
        if (!isObject(h) || h.type !== 'command') { errors.push(`${hat}: only type "command" is supported`); return; }
        if (typeof h.command !== 'string' || !h.command.trim()) { errors.push(`${hat}: command must be a non-empty string`); return; }
        if (h.timeout !== undefined && (typeof h.timeout !== 'number' || !Number.isFinite(h.timeout) || h.timeout <= 0)) {
          errors.push(`${hat}: timeout must be a positive number of seconds`); return;
        }
        hooks.push({ type: 'command', command: h.command, ...(h.timeout !== undefined ? { timeout: h.timeout as number } : {}) });
      });
      if (hooks.length) { parsed.push({ matcher, hooks }); }
    });
    if (parsed.length) { config[event as HookEvent] = parsed; }
  }
  return { config, errors };
}

/** Concatenates configs in order; an identical matcher + command pair runs only once. */
export function mergeHooks(list: HookConfig[]): HookConfig {
  const out: HookConfig = {};
  for (const event of HOOK_EVENTS) {
    const seen = new Set<string>();
    const merged: HookMatcher[] = [];
    for (const cfg of list) {
      for (const m of cfg?.[event] ?? []) {
        const hooks = m.hooks.filter((h) => {
          const key = JSON.stringify([m.matcher, h.command, h.timeout ?? DEFAULT_TIMEOUT_S]);
          if (seen.has(key)) { return false; }
          seen.add(key);
          return true;
        });
        if (hooks.length) { merged.push({ matcher: m.matcher, hooks }); }
      }
    }
    if (merged.length) { out[event] = merged; }
  }
  return out;
}

/** Order-independent sha256 of what would execute; changes whenever a trust prompt must be shown again. */
export function hooksHash(config: HookConfig): string {
  const lines: string[] = [];
  for (const event of HOOK_EVENTS) {
    for (const m of config[event] ?? []) {
      for (const h of m.hooks) { lines.push(JSON.stringify([event, m.matcher, h.command, h.timeout ?? DEFAULT_TIMEOUT_S])); }
    }
  }
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex');
}

export const hasHooks = (config: HookConfig, event: HookEvent): boolean =>
  (config[event] ?? []).some((m) => m.hooks.length > 0);

function selectHooks(event: HookEvent, payload: any, config: HookConfig): HookCommand[] {
  const tool = String(payload?.tool_name ?? payload?.tool ?? '');
  const out: HookCommand[] = [];
  for (const m of config[event] ?? []) {
    let hit = !USES_MATCHER.has(event) || matchesAll(m.matcher);
    if (!hit) { try { hit = new RegExp(m.matcher).test(tool); } catch { hit = false; } }
    if (hit) { out.push(...m.hooks); }
  }
  return out;
}

function killTree(child: ChildProcess, spawnFn: HookSpawnFn): void {
  const pid = child.pid;
  try {
    if (pid === undefined) { child.kill('SIGKILL'); return; }
    if (process.platform === 'win32') {
      const killer = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch { /* already gone */ }
}

function collector(): { push(b: Buffer): void; text(): string } {
  const parts: Buffer[] = [];
  let size = 0;
  return {
    push(b) {
      if (size >= OUTPUT_CAP) { return; }
      const piece = b.length > OUTPUT_CAP - size ? b.subarray(0, OUTPUT_CAP - size) : b;
      parts.push(piece); size += piece.length;
    },
    text: () => Buffer.concat(parts).toString('utf8'),
  };
}

function runOne(hook: HookCommand, input: string, opts: HookRunOptions, env: NodeJS.ProcessEnv): Promise<HookResult> {
  const started = Date.now();
  const win = process.platform === 'win32';
  const spawnFn: HookSpawnFn = opts.spawnFn ?? (nodeSpawn as unknown as HookSpawnFn);
  // powershell -Command reports only 0/1 for native programs unless the exit code is forwarded explicitly.
  const file = win ? 'powershell.exe' : 'bash';
  const args = win ? ['-NoProfile', '-Command', `${hook.command}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`] : ['-lc', hook.command];

  return new Promise<HookResult>((resolve) => {
    const out = collector();
    const err = collector();
    let timedOut = false, done = false;
    let spawnError = '';
    let child: ChildProcess;
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;

    const finish = (code: number | null): void => {
      if (done) { return; }
      done = true;
      if (timer) { clearTimeout(timer); }
      if (grace) { clearTimeout(grace); }
      opts.signal?.removeEventListener('abort', onAbort);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve({
        command: hook.command, code, ms: Date.now() - started, stdout: out.text(),
        stderr: spawnError || err.text(), timedOut,
      });
    };
    const kill = (): void => {
      killTree(child, spawnFn);
      grace ??= setTimeout(() => finish(null), KILL_GRACE_MS);
    };
    function onAbort(): void { kill(); }

    try {
      child = spawnFn(file, args, { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !win });
    } catch (e: any) {
      spawnError = String(e?.message ?? e);
      resolve({ command: hook.command, code: null, ms: Date.now() - started, stdout: '', stderr: spawnError, timedOut: false });
      return;
    }

    child.on('error', (e) => { spawnError = String(e?.message ?? e); finish(null); });
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => err.push(d));
    child.stdout?.on('error', () => { /* destroyed on finish */ });
    child.stderr?.on('error', () => { /* destroyed on finish */ });
    child.on('close', (code) => finish(code));
    // A backgrounded grandchild can hold the pipes open forever; do not wait for it.
    child.on('exit', (code) => { grace ??= setTimeout(() => finish(code), CLOSE_GRACE_MS); });

    child.stdin?.on('error', () => { /* EPIPE: the hook did not read its input */ });
    try { child.stdin?.end(input); } catch { /* EPIPE */ }

    timer = setTimeout(() => { timedOut = true; kill(); }, (hook.timeout ?? DEFAULT_TIMEOUT_S) * 1000);
    if (opts.signal?.aborted) { kill(); } else { opts.signal?.addEventListener('abort', onAbort, { once: true }); }
  });
}

function readJsonOutput(stdout: string): Record<string, any> | undefined {
  const t = stdout.trim();
  if (!t.startsWith('{')) { return undefined; }
  try { const v = JSON.parse(t); return isObject(v) ? v : undefined; } catch { return undefined; }
}

/** Runs the hooks matching this event in parallel. Zero matching hooks spawns nothing. */
export async function runHooks(event: HookEvent, payload: unknown, config: HookConfig, opts: HookRunOptions): Promise<HookRunResult> {
  const selected = selectHooks(event, payload, config);
  if (!selected.length || opts.signal?.aborted) { return { blocked: false, context: [], results: [] }; }

  let input = '{}';
  try { input = JSON.stringify({ hook_event_name: event, cwd: opts.cwd, ...(payload as object) }); } catch { /* unserialisable payload */ }
  const env = { ...process.env, ...opts.env, INFRAON_PROJECT_DIR: opts.cwd, INFRAON_HOOK_EVENT: event };
  const results = await Promise.all(selected.map((h) => runOne(h, input, opts, env)));

  const reasons: string[] = [];
  const context: string[] = [];
  let blocked = false;
  for (const r of results) {
    if (r.timedOut || opts.signal?.aborted) { continue; }
    const json = readJsonOutput(r.stdout);
    const extra = json?.additionalContext ?? json?.hookSpecificOutput?.additionalContext;
    if (typeof extra === 'string' && extra) { context.push(extra); }
    else if (!json && r.code === 0 && r.stdout.trim()) { context.push(r.stdout.trim()); }
    if (!CAN_BLOCK.has(event)) { continue; }
    if (r.code === 2) { blocked = true; reasons.push(r.stderr.trim() || `Blocked by hook: ${r.command}`); }
    else if (json?.decision === 'block') {
      blocked = true;
      reasons.push(typeof json.reason === 'string' && json.reason ? json.reason : `Blocked by hook: ${r.command}`);
    }
  }
  return { blocked, ...(reasons.length ? { reason: reasons.join('\n') } : {}), context, results };
}
