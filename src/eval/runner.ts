import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Agent, AgentUi } from '../core/agent';
import { createFsTools, runShell } from '../core/fstools';
import { matchesGlob } from '../core/glob';
import { LlmConfig, LlmFn } from '../core/llm';
import { Effort } from '../core/policy';
import { detectVerifyCommands } from '../core/verify';
import { DEFAULT_TASK_TIMEOUT_S, EvalTask } from './tasks';

export interface EvalOptions {
  tasks: EvalTask[];
  llmConfig: LlmConfig;
  effort: Effort;
  /** Runs per task (pass rate is reported over all runs). */
  repeat?: number;
  /** Keep each run's temp repository for inspection. */
  keep?: boolean;
  /** Folder for per-run logs (default: inside each temp repo's parent). */
  logDir?: string;
  /** Progress lines (default: none). */
  print?: (line: string) => void;
  /** Override the per-task time limit (tests use short ones). */
  timeoutSeconds?: number;
}

export interface EvalDeps { llm: LlmFn }

export interface RunResult {
  task: string;
  run: number;
  passed: boolean;
  /** Why it failed (or "passed"). */
  reason: string;
  durationMs: number;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  toolCalls: Record<string, number>;
  filesChanged: string[];
  checkOutput: string;
  logFile: string;
  workDir?: string;
  agentError?: string;
  timedOut: boolean;
}

export interface EvalReport {
  startedAt: string;
  model: string;
  effort: Effort;
  repeat: number;
  runs: RunResult[];
  summary: { tasks: number; runs: number; passed: number; passRate: number; perTask: Record<string, { passed: number; runs: number }> };
}

const CHECK_TIMEOUT_MS = 300_000;
const SKIP = new Set(['node_modules', '.git']);

function walk(root: string, dir = root, out: string[] = []): string[] {
  let ents: fs.Dirent[] = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (SKIP.has(e.name)) { continue; }
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { walk(root, abs, out); } else if (e.isFile()) { out.push(path.relative(root, abs).split(path.sep).join('/')); }
  }
  return out;
}

const readOr = (file: string): Buffer | undefined => { try { return fs.readFileSync(file); } catch { return undefined; } };

/** Files that differ between the original fixture and the worked-on copy (added, changed or deleted). */
export function diffTrees(original: string, worked: string): string[] {
  const all = new Set([...walk(original), ...walk(worked)]);
  const changed: string[] = [];
  for (const rel of [...all].sort()) {
    const a = readOr(path.join(original, rel));
    const b = readOr(path.join(worked, rel));
    if (!a || !b || !a.equals(b)) { changed.push(rel); }
  }
  return changed;
}

/** The task's starting state, as the agent sees it: the fixture, with CRLF applied where the task asks for it. */
export function prepareRepo(task: EvalTask, dest: string): void {
  fs.cpSync(path.join(task.dir, 'repo'), dest, { recursive: true });
  for (const rel of task.crlf ?? []) {
    const f = path.join(dest, rel);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
  }
}

/** Runs the task's check in `dir` after copying its hidden tests in. Returns pass/fail and the check's output. */
export async function gradeRepo(task: EvalTask, dir: string, signal = new AbortController().signal): Promise<{ passed: boolean; output: string }> {
  if (task.hiddenTests) { fs.cpSync(path.join(task.dir, task.hiddenTests), dir, { recursive: true, force: true }); }
  const output = await runShell(task.check, { root: dir, signal, snapshot: async () => undefined }, CHECK_TIMEOUT_MS);
  return { passed: /\[exit 0\]\s*$/.test(output), output };
}

/** Files matching mustNotChange that the agent changed. */
export function protectedChanges(task: EvalTask, changed: string[]): string[] {
  const globs = task.mustNotChange ?? [];
  return changed.filter((f) => globs.some((g) => matchesGlob(f, g)));
}

async function runOne(task: EvalTask, run: number, opts: EvalOptions, deps: EvalDeps): Promise<RunResult> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `ica-eval-${task.name.replace(/[^\w-]/g, '_')}-`));
  const work = path.join(base, 'repo');
  const pristine = path.join(base, 'original');
  prepareRepo(task, work);
  prepareRepo(task, pristine);
  const logDir = opts.logDir ?? base;
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${task.name}-run${run}.log`);
  const log: string[] = [];
  const note = (l: string) => log.push(`[${new Date().toISOString().slice(11, 19)}] ${l}`);

  let llmCalls = 0, promptTokens = 0, completionTokens = 0;
  const counted: LlmFn = async (cfg, messages, tools, onToken, signal, onToolProgress, onEvent) => {
    llmCalls++;
    const r = await deps.llm(cfg, messages, tools, onToken, signal, onToolProgress, onEvent);
    promptTokens += r.usage?.prompt ?? 0;
    completionTokens += r.usage?.completion ?? 0;
    if (r.content) { note(`assistant: ${r.content.slice(0, 2000)}`); }
    return r;
  };
  const toolCalls: Record<string, number> = {};
  const ui: AgentUi = {
    token: () => undefined,
    toolStart: (_id, name, _kind, _args, detail) => { toolCalls[name] = (toolCalls[name] ?? 0) + 1; note(`tool ${name}: ${detail}`); },
    toolEnd: (_id, ok, result) => note(`  -> ${ok ? 'ok' : 'FAILED'}: ${result.slice(0, 600).replace(/\n/g, '\n     ')}`),
    info: (t) => note(`info: ${t}`),
    approve: async () => true,
  };
  const agent = new Agent({
    root: work, llm: counted, getConfig: () => opts.llmConfig, tools: () => createFsTools(),
    checks: () => detectVerifyCommands(work),
  });

  const started = Date.now();
  const limitMs = (opts.timeoutSeconds ?? task.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT_S) * 1000;
  let timedOut = false;
  let agentError: string | undefined;
  const timer = setTimeout(() => { timedOut = true; note('time limit reached: cancelling the agent'); agent.cancel(); }, limitMs);
  try {
    note(`prompt: ${task.prompt}`);
    await agent.send(task.prompt, { mode: 'auto', effort: opts.effort, model: opts.llmConfig.model }, ui);
  } catch (e: any) {
    agentError = e?.message ?? String(e);
    note(`agent error: ${agentError}`);
  } finally { clearTimeout(timer); }
  const durationMs = Date.now() - started;

  const filesChanged = diffTrees(pristine, work);
  const touched = protectedChanges(task, filesChanged);
  const grade = await gradeRepo(task, work);
  note(`check ${task.check}:\n${grade.output}`);
  let reason = 'passed';
  if (touched.length) { reason = `changed protected files: ${touched.join(', ')}`; }
  else if (!grade.passed) { reason = timedOut ? 'timed out and the check fails' : agentError ? `agent error: ${agentError.slice(0, 200)}` : 'check failed'; }
  const passed = reason === 'passed';
  fs.writeFileSync(logFile, `${log.join('\n')}\n\nRESULT: ${passed ? 'PASS' : `FAIL (${reason})`}\n`);
  if (!opts.keep) { try { fs.rmSync(path.join(base, 'original'), { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } }

  return {
    task: task.name, run, passed, reason, durationMs, llmCalls, promptTokens, completionTokens, toolCalls, filesChanged,
    checkOutput: grade.output.slice(-4000), logFile, ...(opts.keep ? { workDir: work } : {}), ...(agentError ? { agentError } : {}), timedOut,
  };
}

/** Runs every task (repeat times each) against the given LLM and returns the report. */
export async function runEval(opts: EvalOptions, deps: EvalDeps): Promise<EvalReport> {
  const repeat = Math.max(1, Math.floor(opts.repeat ?? 1));
  const startedAt = new Date().toISOString();
  const runs: RunResult[] = [];
  for (const task of opts.tasks) {
    for (let r = 1; r <= repeat; r++) {
      opts.print?.(`▶ ${task.name}${repeat > 1 ? ` (run ${r}/${repeat})` : ''}`);
      const res = await runOne(task, r, opts, deps);
      runs.push(res);
      opts.print?.(`  ${res.passed ? 'PASS' : 'FAIL'}  ${(res.durationMs / 1000).toFixed(1)} s, ${res.llmCalls} LLM calls${res.passed ? '' : ` — ${res.reason}`}  (log: ${res.logFile})`);
    }
  }
  const perTask: Record<string, { passed: number; runs: number }> = {};
  for (const r of runs) {
    const t = (perTask[r.task] ??= { passed: 0, runs: 0 });
    t.runs++;
    if (r.passed) { t.passed++; }
  }
  const passed = runs.filter((r) => r.passed).length;
  return {
    startedAt, model: opts.llmConfig.model, effort: opts.effort, repeat, runs,
    summary: { tasks: opts.tasks.length, runs: runs.length, passed, passRate: runs.length ? passed / runs.length : 0, perTask },
  };
}

/** Plain-text table of a report. */
export function formatReport(rep: EvalReport): string {
  const rows = [['task', 'passed', 'avg time', 'avg LLM calls', 'avg tokens (in/out)']];
  for (const [name, t] of Object.entries(rep.summary.perTask)) {
    const rs = rep.runs.filter((r) => r.task === name);
    const avg = (f: (r: RunResult) => number) => rs.reduce((n, r) => n + f(r), 0) / rs.length;
    rows.push([name, `${t.passed}/${t.runs}`, `${(avg((r) => r.durationMs) / 1000).toFixed(1)} s`, avg((r) => r.llmCalls).toFixed(1),
      `${Math.round(avg((r) => r.promptTokens))}/${Math.round(avg((r) => r.completionTokens))}`]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ');
  const s = rep.summary;
  return [line(rows[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.slice(1).map(line), '',
    `Overall: ${s.passed}/${s.runs} runs passed (${(s.passRate * 100).toFixed(0)}%) — model ${rep.model}, effort ${rep.effort}`].join('\n');
}
