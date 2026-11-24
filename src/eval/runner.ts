/**
 * Runs eval tasks against an LLM with the extension's real agent and grades each run.
 *
 * Every run works in a fresh temp copy of the task's repo/ (prepareRepo), so runs never see each other's changes.
 * Grading (gradeRepo) copies the hidden tests in only after the agent has finished, then runs the task's check;
 * a run also fails when it touched a mustNotChange file. applySolution exists for the offline validator test,
 * which proves every task fails untouched and passes with its reference solution. historyEntry/appendHistory
 * write the one-line-per-suite-run history used to compare pass rates across releases.
 *
 * Comparison runs: `agents` may list several agents ("infraon", this extension's agent; "cline", the Cline CLI via
 * cline.ts). Each task run is repeated for every agent back to back with the same prompt, time limit and grading, so
 * gateway load drifts hit all agents alike. With a metering proxy (meter.ts) in `meter`, LLM calls, tokens and model
 * time are taken from the proxy for every agent, so they are counted the same way whatever the agent reports.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Agent, AgentUi } from '../core/agent';
import { ClineConfig, runCline } from './cline';
import { Meter } from './meter';
import { createFsTools, runShell } from '../core/fstools';
import { matchesGlob } from '../core/glob';
import { LlmConfig, LlmFn } from '../core/llm';
import { Effort } from '../core/policy';
import { DiagnoseFirstSetting } from '../core/diagnosis';
import { detectVerifyCommands } from '../core/verify';
import { DEFAULT_TASK_TIMEOUT_S, EvalTask, solutionDir } from './tasks';

export type AgentKind = 'infraon' | 'cline';
export const AGENT_KINDS: AgentKind[] = ['infraon', 'cline'];

export interface EvalOptions {
  tasks: EvalTask[];
  /** Agents to run every task with (default: just this extension's agent). */
  agents?: AgentKind[];
  /** Metering proxy every agent talks through; when set, LLM numbers come from it. */
  meter?: Meter;
  /** Required when agents include "cline". */
  cline?: ClineConfig;
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
  /** infraonAssistant.diagnoseFirst for this extension's agent (default: off, as before it existed). */
  diagnoseFirst?: DiagnoseFirstSetting;
  /** Override the per-task time limit (tests use short ones). */
  timeoutSeconds?: number;
}

export interface EvalDeps { llm: LlmFn }

export interface RunResult {
  agent: AgentKind;
  task: string;
  run: number;
  passed: boolean;
  /** Why it failed (or "passed"). */
  reason: string;
  durationMs: number;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  /** Time spent waiting on the model (from the metering proxy; 0 without one). */
  llmMs: number;
  /** Mean time to the first response byte per LLM call (metering proxy only). */
  avgFirstByteMs: number;
  /** LLM calls that failed at the gateway (metering proxy only). */
  failedLlmCalls: number;
  toolCalls: Record<string, number>;
  filesChanged: string[];
  checkOutput: string;
  logFile: string;
  workDir?: string;
  agentError?: string;
  timedOut: boolean;
}

export interface EvalSummary { tasks: number; runs: number; passed: number; passRate: number; perTask: Record<string, { passed: number; runs: number }> }

export interface EvalReport {
  startedAt: string;
  model: string;
  effort: Effort;
  repeat: number;
  agents?: AgentKind[];
  runs: RunResult[];
  /** Over all runs (with one agent: that agent's summary). */
  summary: EvalSummary;
  /** One summary per agent, for comparison runs. */
  byAgent?: Partial<Record<AgentKind, EvalSummary>>;
  /** Fields the metering proxy wrote into every chat request (equal sampling for all agents), if any. */
  forcedSampling?: Record<string, number>;
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

/** In a solution folder: the files the solution deletes, one repository-relative path per line ("#" starts a comment). */
export const SOLUTION_DELETE_FILE = '__delete__.txt';

/**
 * Applies the task's reference solution to a prepared repository: every file in solution/ is copied over the
 * repository (same relative path), then the paths listed in solution/__delete__.txt are removed, then the task's
 * crlf files are converted to CRLF again so a solution keeps the line endings the agent was given.
 * Used by the task validator test to prove that each task can pass; the agent never sees solution/.
 */
export function applySolution(task: EvalTask, dest: string): void {
  const dir = solutionDir(task);
  if (!dir) { throw new Error(`task ${task.name} has no reference solution`); }
  fs.cpSync(dir, dest, { recursive: true, force: true, filter: (src) => path.basename(src) !== SOLUTION_DELETE_FILE });
  const del = readOr(path.join(dir, SOLUTION_DELETE_FILE));
  for (const line of del ? del.toString('utf8').split(/\r?\n/) : []) {
    const rel = line.trim();
    if (rel && !rel.startsWith('#')) { fs.rmSync(path.join(dest, rel), { recursive: true, force: true }); }
  }
  for (const rel of task.crlf ?? []) {
    const f = path.join(dest, rel);
    if (fs.existsSync(f)) { fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')); }
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

async function runOne(task: EvalTask, run: number, kind: AgentKind, opts: EvalOptions, deps: EvalDeps): Promise<RunResult> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `ica-eval-${task.name.replace(/[^\w-]/g, '_')}-`));
  const work = path.join(base, 'repo');
  const pristine = path.join(base, 'original');
  prepareRepo(task, work);
  prepareRepo(task, pristine);
  const logDir = opts.logDir ?? base;
  fs.mkdirSync(logDir, { recursive: true });
  const multi = (opts.agents?.length ?? 1) > 1 || kind !== 'infraon';
  const logFile = path.join(logDir, `${task.name}-run${run}${multi ? `-${kind}` : ''}.log`);
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
  opts.meter?.reset();
  const started = Date.now();
  const limitMs = (opts.timeoutSeconds ?? task.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT_S) * 1000;
  let timedOut = false;
  let agentError: string | undefined;
  note(`agent: ${kind}`);
  note(`prompt: ${task.prompt}`);
  if (kind === 'cline') {
    if (!opts.cline) { throw new Error('agents include "cline" but no Cline configuration was given'); }
    const r = await runCline(opts.cline, work, task.prompt, limitMs, (line) => {
      try {
        const ev = JSON.parse(line);
        const e = ev?.event;
        if (e?.type === 'content_start' && e.toolName) { note(`tool ${e.toolName}`); }
        else if (e?.type === 'error') { note(`cline error: ${String(e.error?.message ?? '').slice(0, 600)}`); }
        else if (ev?.type === 'run_result') { note(`cline finished: ${ev.finishReason} after ${ev.iterations} iterations: ${String(ev.text ?? '').slice(0, 2000)}`); }
      } catch { /* not JSON */ }
    });
    timedOut = r.timedOut;
    Object.assign(toolCalls, r.toolCalls);
    if (r.timedOut) { note('time limit reached: Cline was stopped'); }
    if (!r.timedOut && r.finishReason && !['completed', 'stop', 'submitted'].includes(r.finishReason)) {
      agentError = `cline finished with ${r.finishReason}${r.lastText ? `: ${r.lastText.slice(0, 300)}` : ''}`;
    } else if (r.exitCode !== 0 && !r.timedOut && !r.finishReason) {
      agentError = `cline exited with ${r.exitCode}: ${(r.stderr || r.lastText).slice(-300)}`;
    }
    if (agentError) { note(`agent error: ${agentError}`); }
    if (r.stderr.trim()) { note(`cline stderr: ${r.stderr.slice(-2000)}`); }
  } else {
    const agent = new Agent({
      root: work, llm: counted, getConfig: () => opts.llmConfig, tools: () => createFsTools(),
      checks: () => detectVerifyCommands(work),
      diagnoseFirst: opts.diagnoseFirst ? () => opts.diagnoseFirst! : undefined,
    });
    const timer = setTimeout(() => { timedOut = true; note('time limit reached: cancelling the agent'); agent.cancel(); }, limitMs);
    try {
      await agent.send(task.prompt, { mode: 'auto', effort: opts.effort, model: opts.llmConfig.model }, ui);
    } catch (e: any) {
      agentError = e?.message ?? String(e);
      note(`agent error: ${agentError}`);
    } finally { clearTimeout(timer); }
  }
  const durationMs = Date.now() - started;
  let llmMs = 0, avgFirstByteMs = 0, failedLlmCalls = 0;
  if (opts.meter) {
    const m = opts.meter.totals();
    ({ llmMs, avgFirstByteMs, failedCalls: failedLlmCalls } = m);
    llmCalls = m.calls; promptTokens = m.promptTokens; completionTokens = m.completionTokens;
  }

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
    agent: kind, task: task.name, run, passed, reason, durationMs, llmCalls, promptTokens, completionTokens, llmMs, avgFirstByteMs, failedLlmCalls,
    toolCalls, filesChanged,
    checkOutput: grade.output.slice(-4000), logFile, ...(opts.keep ? { workDir: work } : {}), ...(agentError ? { agentError } : {}), timedOut,
  };
}

/** Runs every task (repeat times each) against the given LLM and returns the report. */
export async function runEval(opts: EvalOptions, deps: EvalDeps): Promise<EvalReport> {
  const repeat = Math.max(1, Math.floor(opts.repeat ?? 1));
  const startedAt = new Date().toISOString();
  const agents: AgentKind[] = opts.agents?.length ? [...new Set(opts.agents)] : ['infraon'];
  const runs: RunResult[] = [];
  for (const task of opts.tasks) {
    for (let r = 1; r <= repeat; r++) {
      for (const kind of agents) {
        opts.print?.(`▶ ${task.name}${repeat > 1 ? ` (run ${r}/${repeat})` : ''}${agents.length > 1 || kind !== 'infraon' ? ` [${kind}]` : ''}`);
        const res = await runOne(task, r, kind, opts, deps);
        runs.push(res);
        opts.print?.(`  ${res.passed ? 'PASS' : 'FAIL'}  ${(res.durationMs / 1000).toFixed(1)} s, ${res.llmCalls} LLM calls${res.passed ? '' : ` — ${res.reason}`}  (log: ${res.logFile})`);
      }
    }
  }
  const byAgent: Partial<Record<AgentKind, EvalSummary>> = {};
  for (const kind of agents) { byAgent[kind] = summarize(runs.filter((r) => r.agent === kind), opts.tasks.length); }
  return {
    startedAt, model: opts.llmConfig.model, effort: opts.effort, repeat, agents, runs,
    summary: summarize(runs, opts.tasks.length), byAgent,
  };
}

function summarize(runs: RunResult[], tasks: number): EvalSummary {
  const perTask: Record<string, { passed: number; runs: number }> = {};
  for (const r of runs) {
    const t = (perTask[r.task] ??= { passed: 0, runs: 0 });
    t.runs++;
    if (r.passed) { t.passed++; }
  }
  const passed = runs.filter((r) => r.passed).length;
  return { tasks, runs: runs.length, passed, passRate: runs.length ? passed / runs.length : 0, perTask };
}

const avgOf = (rs: RunResult[], f: (r: RunResult) => number) => (rs.length ? rs.reduce((n, r) => n + f(r), 0) / rs.length : 0);
const median = (xs: number[]) => {
  if (!xs.length) { return 0; }
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const table = (rows: string[][]) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(rows[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.slice(1).map(line)].join('\n');
};

/** Side-by-side table of a run with several agents: per task, then totals per agent. */
export function formatComparison(rep: EvalReport): string {
  const agents = rep.agents ?? ['infraon'];
  const rows = [['task', ...agents.flatMap((a) => [`${a} pass`, `${a} time`, `${a} calls`, `${a} tok in/out`])]];
  for (const name of Object.keys(rep.summary.perTask)) {
    const cells = [name];
    for (const a of agents) {
      const rs = rep.runs.filter((r) => r.task === name && r.agent === a);
      const t = rep.byAgent?.[a]?.perTask[name] ?? { passed: 0, runs: 0 };
      cells.push(`${t.passed}/${t.runs}`, `${(avgOf(rs, (r) => r.durationMs) / 1000).toFixed(1)} s`, avgOf(rs, (r) => r.llmCalls).toFixed(1),
        `${Math.round(avgOf(rs, (r) => r.promptTokens))}/${Math.round(avgOf(rs, (r) => r.completionTokens))}`);
    }
    rows.push(cells);
  }
  const totals = [['agent', 'pass rate', 'passed', 'avg time', 'median time', 'avg LLM calls', 'avg model wait', 'avg 1st byte',
    'avg tokens in', 'avg tokens out', 'timeouts', 'gateway errors']];
  for (const a of agents) {
    const rs = rep.runs.filter((r) => r.agent === a);
    const s = rep.byAgent?.[a];
    totals.push([a, `${((s?.passRate ?? 0) * 100).toFixed(1)}%`, `${s?.passed ?? 0}/${s?.runs ?? 0}`,
      `${(avgOf(rs, (r) => r.durationMs) / 1000).toFixed(1)} s`, `${(median(rs.map((r) => r.durationMs)) / 1000).toFixed(1)} s`,
      avgOf(rs, (r) => r.llmCalls).toFixed(1), `${(avgOf(rs, (r) => r.llmMs) / 1000).toFixed(1)} s`, `${Math.round(avgOf(rs, (r) => r.avgFirstByteMs))} ms`,
      String(Math.round(avgOf(rs, (r) => r.promptTokens))), String(Math.round(avgOf(rs, (r) => r.completionTokens))),
      String(rs.filter((r) => r.timedOut).length), String(rs.reduce((n, r) => n + r.failedLlmCalls, 0))]);
  }
  // Tasks where the agents disagree are the ones worth reading the logs for.
  const differ = Object.keys(rep.summary.perTask).filter((name) => new Set(agents.map((a) => rep.byAgent?.[a]?.perTask[name]?.passed ?? 0)).size > 1);
  const sampling = rep.forcedSampling && Object.keys(rep.forcedSampling).length
    ? `same sampling for all agents: ${Object.entries(rep.forcedSampling).map(([k, v]) => `${k}=${v}`).join(', ')}` : 'each agent used its own sampling';
  return [table(rows), '', table(totals), '',
    `Model ${rep.model}, ${rep.repeat} run(s) per task per agent, ${sampling}.`,
    differ.length ? `Tasks where results differ: ${differ.join(', ')}` : 'Every task had the same pass count for all agents.'].join('\n');
}

/** Plain-text table of a report. */
export function formatReport(rep: EvalReport): string {
  if ((rep.agents?.length ?? 1) > 1) { return formatComparison(rep); }
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

/** One line of the results history (eval/results/history.jsonl): enough to compare pass rates across releases. */
export interface HistoryEntry {
  date: string;
  version: string;
  model: string;
  effort: Effort;
  repeat: number;
  tasks: number;
  runs: number;
  passed: number;
  passRate: number;
  /** Pass counts per difficulty ("unrated" for tasks without one). */
  byDifficulty: Record<string, { passed: number; runs: number }>;
  perTask: Record<string, { passed: number; runs: number }>;
  /** Tasks left out because a toolchain they need is missing on this machine. */
  skipped: string[];
}

export function historyEntry(rep: EvalReport, tasks: EvalTask[], version: string, skipped: string[] = []): HistoryEntry {
  const difficulty = new Map(tasks.map((t) => [t.name, t.difficulty ?? 'unrated']));
  const byDifficulty: Record<string, { passed: number; runs: number }> = {};
  for (const [name, t] of Object.entries(rep.summary.perTask)) {
    const d = (byDifficulty[difficulty.get(name) ?? 'unrated'] ??= { passed: 0, runs: 0 });
    d.passed += t.passed;
    d.runs += t.runs;
  }
  const s = rep.summary;
  return {
    date: rep.startedAt, version, model: rep.model, effort: rep.effort, repeat: rep.repeat,
    tasks: s.tasks, runs: s.runs, passed: s.passed, passRate: Math.round(s.passRate * 10000) / 10000,
    byDifficulty, perTask: s.perTask, skipped,
  };
}

/** Appends one JSON line to the history file, creating its folder with a .gitignore so results stay local. */
export function appendHistory(file: string, entry: HistoryEntry): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.gitignore'))) { fs.writeFileSync(path.join(dir, '.gitignore'), '*\n'); }
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}
