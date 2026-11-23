/**
 * End-to-end "build a mid-size project" run: drives the real agent runtime (plan mode -> clarifying questions ->
 * plan approval -> task list -> sub-agents -> edits/commands -> automatic checks) against the company LLM,
 * watches every stage for hangs, then grades the result independently.
 *
 *   npm run e2e:build -- [--model <id>] [--effort low|medium|high|max] [--idle 300] [--timeout 3600] [--followups 2] [--out <dir>]
 *
 * Environment (same as `npm run eval`): INFRAON_EVAL_BASE_URL, INFRAON_EVAL_API_KEY, INFRAON_EVAL_MODEL,
 * INFRAON_EVAL_ALLOW_SELF_SIGNED=1. Everything stays on this machine and the configured gateway.
 *
 *   --max-rounds defaults to 1200, like the extension's infraonAssistant.maxIterations.
 *
 * Verdicts: COMPLETED (autonomous, all grades pass) · COMPLETED_WITH_NUDGES (passed only after "continue" follow-ups)
 * · INCOMPLETE (finished but grades fail) · STUCK (no progress / unanswered prompt) · TIMEOUT · ERROR.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Agent, AgentDeps, DELEGATION_TOOLS } from '../core/agent';
import { BUILTIN_AGENT_TYPES, toolsForType } from '../core/agentTypes';
import { createFsTools } from '../core/fstools';
import { LlmConfig, LlmFn, streamChat } from '../core/llm';
import { resolveSampling } from '../core/sampling';
import { Effort, isEffort } from '../core/policy';
import { Answers, UserQuestion } from '../core/questions';
import { AgentSpec, SessionManager, UiEvent } from '../core/runtime';
import { SessionStore2 } from '../core/store';
import { detectVerifyCommands } from '../core/verify';

export const PROJECT_PROMPT = `Build a small but complete task-management service called "taskly" in this empty folder.
Use Node.js 18+ with NO third-party dependencies (Node built-ins only; tests use node:test and node:assert).

Requirements
1. src/app.js exports createApp({ dataFile }) that returns a Node http.Server which is NOT yet listening.
2. REST API (JSON in, JSON out):
   - GET /health -> 200 {"status":"ok"}
   - GET /api/tasks -> 200 array; supports ?done=true|false and ?tag=<tag> filters
   - POST /api/tasks {title (required non-empty string), description?, tags?: string[], dueDate?: ISO date}
     -> 201 with the task including a generated "id", "done": false and "createdAt"
   - GET /api/tasks/:id -> 200 task, unknown id -> 404
   - PATCH /api/tasks/:id (partial update, including "done") -> 200 updated task
   - DELETE /api/tasks/:id -> 204
   - Invalid input -> 400 {"error": "..."}; unknown route -> 404 {"error": "..."}
3. src/store.js: persistence in the JSON file "dataFile", written atomically (write temp file, then rename).
4. src/validate.js: input validation used by the API.
5. bin/taskly.js CLI: "add <title> [--tag <t>]", "list [--json]", "done <id>", "rm <id>"; the data file comes from the
   TASKLY_FILE environment variable (default ./taskly.json). "list --json" prints the JSON array of tasks.
6. src/server.js starts the app on PORT (default 3000).
7. Tests in test/ for the store, validation, the API (listen on port 0) and the CLI. package.json "test" script: "node --test".
8. README.md with setup and usage.

How to work
- You are in plan mode. FIRST ask me 1-3 clarifying questions with the question tool (for example id format, list sort order),
  then research and present a plan for approval.
- After approval, track the work with a task list, delegate writing the test suite to a sub-agent,
  run "npm test" and fix failures until every test passes. Finish with a short summary.`;

const FOLLOW_UP = 'Continue until every step of the plan is finished and "npm test" passes. Make sure the API and CLI match the requirements exactly.';

export interface BuildOptions {
  llmConfig: LlmConfig;
  effort: Effort;
  /** Seconds without any agent event before the run counts as stuck. */
  idleSeconds: number;
  /** Seconds a question/plan/approval may stay unanswered before the run counts as stuck. */
  pendingSeconds: number;
  timeoutSeconds: number;
  maxFollowUps: number;
  /** Max tool rounds per request (the extension's maxIterations). */
  maxRounds: number;
  outDir: string;
  prompt?: string;
  print?: (line: string) => void;
}

export type Verdict = 'COMPLETED' | 'COMPLETED_WITH_NUDGES' | 'INCOMPLETE' | 'STUCK' | 'TIMEOUT' | 'ERROR';

export interface Grade { name: string; passed: boolean; output: string }
export interface BuildReport {
  verdict: Verdict;
  reason: string;
  workDir: string;
  durationMs: number;
  followUps: number;
  tokens: number;
  stages: Array<{ at: string; stage: string; detail?: string }>;
  features: Record<string, boolean>;
  toolCalls: Record<string, number>;
  failedTools: number;
  todos: Array<{ content: string; status: string }>;
  modes: string[];
  grades: Grade[];
  stuck?: { activity: string; status: string; idleSeconds: number; pending: string[] };
  logFile: string;
}

/** Picks the "(Recommended)" option if any, else the first one; multi-select questions also get just one pick. */
export function autoAnswer(questions: UserQuestion[]): Answers {
  const out: Answers = {};
  questions.forEach((q, i) => {
    const rec = q.options.find((o) => /recommended/i.test(o.label)) ?? q.options[0];
    out[i] = { selected: [rec.label] };
  });
  return out;
}

const FEATURES: Array<[string, (t: Record<string, number>, s: Set<string>) => boolean]> = [
  ['plan mode start', (_t, s) => s.has('mode:plan')],
  ['clarifying questions asked', (t) => (t.ask_user_question ?? 0) > 0],
  ['questions answered -> run continued', (_t, s) => s.has('continued-after-answer')],
  ['plan presented (exit_plan_mode)', (t) => (t.exit_plan_mode ?? 0) > 0],
  ['plan approved -> mode switched', (_t, s) => s.has('plan-approved')],
  ['task list (todo_write)', (t) => (t.todo_write ?? 0) > 0],
  ['sub-agent delegation', (t) => (t.agent ?? 0) > 0],
  ['sub-agent did real work', (_t, s) => s.has('sub-tools')],
  ['code search (grep/glob/list)', (t) => (t.grep ?? 0) + (t.glob_files ?? 0) + (t.list_dir ?? 0) > 0],
  ['read files', (t) => (t.read_file ?? 0) > 0],
  ['create files (write_file)', (t) => (t.write_file ?? 0) > 0],
  ['edit files (edit_file/multi_edit)', (t) => (t.edit_file ?? 0) + (t.multi_edit ?? 0) > 0],
  ['run commands (run_command)', (t) => (t.run_command ?? 0) > 0],
  ['changes verified (agent ran tests or automatic checks)', (_t, s) => s.has('auto-checks') || s.has('verified')],
  ['all todo steps completed', (_t, s) => s.has('todos-complete')],
];

function sh(command: string, cwd: string, env: NodeJS.ProcessEnv = {}, timeoutMs = 300_000): { ok: boolean; out: string } {
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, ...env } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`;
  return { ok: r.status === 0 && !r.error, out: out.slice(-6000) };
}

/** Black-box acceptance test of the built API, run in a separate Node process. */
const ACCEPTANCE = String.raw`
const path = require('path'); const fs = require('fs'); const os = require('os');
const root = process.argv[2];
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'taskly-acc-')), 'data.json');
const { createApp } = require(path.join(root, 'src', 'app.js'));
const server = createApp({ dataFile });
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
server.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const req = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    return { status: r.status, json };
  };
  try {
    let r = await req('GET', '/health'); if (r.status !== 200 || r.json?.status !== 'ok') fail('/health ' + JSON.stringify(r));
    r = await req('POST', '/api/tasks', {}); if (r.status !== 400) fail('POST without title should be 400, got ' + r.status);
    r = await req('POST', '/api/tasks', { title: 'first', tags: ['work'] }); if (r.status !== 201 || !r.json?.id) fail('create ' + JSON.stringify(r));
    const id = r.json.id; if (r.json.done !== false || !r.json.createdAt) fail('new task needs done:false and createdAt');
    await req('POST', '/api/tasks', { title: 'second', tags: ['home'] });
    r = await req('GET', '/api/tasks'); if (r.status !== 200 || !Array.isArray(r.json) || r.json.length !== 2) fail('list ' + JSON.stringify(r));
    r = await req('GET', '/api/tasks?tag=work'); if (r.json?.length !== 1) fail('tag filter ' + JSON.stringify(r.json));
    r = await req('PATCH', '/api/tasks/' + id, { done: true }); if (r.status !== 200 || r.json?.done !== true) fail('patch ' + JSON.stringify(r));
    r = await req('GET', '/api/tasks?done=true'); if (r.json?.length !== 1) fail('done filter ' + JSON.stringify(r.json));
    r = await req('GET', '/api/tasks/does-not-exist'); if (r.status !== 404) fail('unknown id should be 404, got ' + r.status);
    r = await req('GET', '/nope'); if (r.status !== 404) fail('unknown route should be 404, got ' + r.status);
    if (!fs.existsSync(dataFile)) fail('data file was not written');
    r = await req('DELETE', '/api/tasks/' + id); if (r.status !== 204) fail('delete should be 204, got ' + r.status);
    r = await req('GET', '/api/tasks'); if (r.json?.length !== 1) fail('after delete ' + JSON.stringify(r.json));
    console.log('API acceptance: all checks passed'); server.close(); process.exit(0);
  } catch (e) { fail(e && e.stack || e); }
});`;

export function gradeProject(dir: string, scratch: string): Grade[] {
  const grades: Grade[] = [];
  const pkgPath = path.join(dir, 'package.json');
  let pkgOk = false;
  try { pkgOk = typeof JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts?.test === 'string'; } catch { /* reported */ }
  grades.push({ name: 'package.json with a test script', passed: pkgOk, output: pkgOk ? 'ok' : 'missing or invalid' });
  const files = ['src/app.js', 'src/store.js', 'src/validate.js', 'src/server.js', 'bin/taskly.js', 'README.md'];
  const missing = files.filter((f) => !fs.existsSync(path.join(dir, f)));
  const testFiles = fs.existsSync(path.join(dir, 'test')) ? fs.readdirSync(path.join(dir, 'test')).filter((f) => /\.(test\.)?[cm]?js$/.test(f)) : [];
  grades.push({ name: 'required files present', passed: !missing.length && testFiles.length > 0, output: missing.length ? `missing: ${missing.join(', ')}` : `ok (${testFiles.length} test files)` });
  if (pkgOk) { const t = sh('npm test', dir); grades.push({ name: 'npm test (project\'s own tests)', passed: t.ok, output: t.out }); }
  if (fs.existsSync(path.join(dir, 'src/app.js'))) {
    const acc = path.join(scratch, 'acceptance.js');
    fs.writeFileSync(acc, ACCEPTANCE);
    const r = sh(`node "${acc}" "${dir}"`, scratch, {}, 60_000);
    grades.push({ name: 'API acceptance (independent)', passed: r.ok, output: r.out });
  }
  if (fs.existsSync(path.join(dir, 'bin/taskly.js'))) {
    const env = { TASKLY_FILE: path.join(scratch, 'cli.json') };
    try { fs.rmSync(env.TASKLY_FILE, { force: true }); } catch { /* fine */ }
    const cli = (args: string) => sh(`node bin/taskly.js ${args}`, dir, env, 30_000);
    const add = cli('add "buy milk" --tag home');
    const list = cli('list --json');
    let ok = add.ok && list.ok;
    let detail = `add: ${add.out.trim()}\nlist: ${list.out.trim()}`;
    try {
      const arr = JSON.parse(list.out.slice(list.out.indexOf('[')));
      ok = ok && Array.isArray(arr) && arr.length === 1 && arr[0].title === 'buy milk';
      if (ok) {
        const done = cli(`done ${arr[0].id}`);
        const after = JSON.parse(cli('list --json').out.replace(/^[^[]*/, ''));
        ok = done.ok && after[0]?.done === true;
        const rm = cli(`rm ${arr[0].id}`);
        const empty = JSON.parse(cli('list --json').out.replace(/^[^[]*/, ''));
        ok = ok && rm.ok && Array.isArray(empty) && empty.length === 0;
        detail += `\ndone/rm: ${ok ? 'ok' : 'unexpected result'}`;
      }
    } catch (e: any) { ok = false; detail += `\nnot JSON: ${e.message}`; }
    grades.push({ name: 'CLI acceptance (independent)', passed: ok, output: detail });
  }
  return grades;
}

export async function runBuild(opts: BuildOptions, llm: LlmFn): Promise<BuildReport> {
  const print = opts.print ?? ((l: string) => console.log(l));
  const workDir = path.join(opts.outDir, 'project');
  const scratch = path.join(opts.outDir, 'scratch');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });
  const logFile = path.join(opts.outDir, 'run.log');
  const log = fs.createWriteStream(logFile);
  const started = Date.now();
  const clock = () => { const s = Math.round((Date.now() - started) / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const note = (l: string) => log.write(`[${clock()}] ${l}\n`);
  const stages: BuildReport['stages'] = [];
  const stage = (s: string, detail?: string) => { stages.push({ at: clock(), stage: s, detail }); note(`== ${s}${detail ? `: ${detail}` : ''}`); print(`[${clock()}] ${s}${detail ? ` — ${detail}` : ''}`); };

  const toolCalls: Record<string, number> = {};
  const seen = new Set<string>();
  const modes: string[] = [];
  const pendingSince = new Map<string, { at: number; what: string }>();
  let failedTools = 0;
  let lastEvent = Date.now();
  let answeredAt = 0;
  let mainId = '';
  let todos: Array<{ content: string; status: string }> = [];

  let mgr: SessionManager; // assigned below; the agent factory closes over it
  const tools = () => createFsTools();
  const createAgent = (sid: string, aid: string, spec: AgentSpec = { role: 'main' }): Agent => {
    const sub = spec.role === 'sub' ? spec.type : undefined;
    const deps: AgentDeps = {
      subagent: !!sub,
      extraSystem: sub?.prompt,
      agentTypes: () => BUILTIN_AGENT_TYPES,
      spawn: sub ? undefined : (req) => mgr.spawn(sid, aid, req),
      sendToAgent: sub ? undefined : (to, message) => mgr.message(sid, to, message),
      root: (spec.role === 'sub' && spec.root) || workDir,
      llm,
      getConfig: (o) => ({ ...opts.llmConfig, model: o.model || opts.llmConfig.model }),
      tools: () => (sub ? toolsForType(tools(), sub, DELEGATION_TOOLS) : tools()),
      checks: sub ? undefined : () => detectVerifyCommands(workDir),
      // Same default as the extension (infraonAssistant.maxIterations).
      limits: () => ({ maxIterations: opts.maxRounds }),
    };
    return new Agent(deps);
  };

  const onEvent = (sid: string, aid: string, ev: UiEvent): void => {
    lastEvent = Date.now();
    const who = aid === mainId ? 'main' : `sub:${aid}`;
    switch (ev.type) {
      case 'token': return;
      case 'toolStart':
        toolCalls[ev.name] = (toolCalls[ev.name] ?? 0) + 1;
        if (aid !== mainId) { seen.add('sub-tools'); }
        if (answeredAt && aid === mainId && ev.name !== 'ask_user_question') { seen.add('continued-after-answer'); }
        if (ev.name === 'agent') { stage('Sub-agent launched', ev.detail); }
        if (String(ev.id).startsWith('check_')) { seen.add('auto-checks'); }
        note(`${who} tool ${ev.name}: ${ev.detail ?? ''}`);
        return;
      case 'toolEnd':
        if (!ev.ok) { failedTools++; }
        note(`${who}   -> ${ev.ok ? 'ok' : 'FAILED'}: ${String(ev.result ?? '').slice(0, 500).replace(/\n/g, ' ⏎ ')}`);
        return;
      case 'question': {
        const qs = ev.questions as UserQuestion[];
        pendingSince.set(ev.id, { at: Date.now(), what: 'question' });
        const answers = autoAnswer(qs);
        stage('Stage 1: clarifying questions', qs.map((q, i) => `${q.question} -> ${answers[i].selected[0]}`).join(' | '));
        setImmediate(() => {
          const ok = mgr.resolveQuestion(sid, aid, ev.id, answers);
          pendingSince.delete(ev.id);
          answeredAt = Date.now();
          note(`answered question ${ev.id}: ${ok}`);
        });
        return;
      }
      case 'planApprove':
        pendingSince.set(ev.id, { at: Date.now(), what: 'plan approval' });
        stage('Plan presented', `${String(ev.plan).split('\n').length} lines`);
        note(`PLAN:\n${ev.plan}`);
        setImmediate(() => {
          if (mgr.resolveApproval(sid, aid, ev.id, 'auto')) { seen.add('plan-approved'); stage('Plan approved', 'switching to auto mode'); }
          pendingSince.delete(ev.id);
        });
        return;
      case 'approve':
        pendingSince.set(ev.id, { at: Date.now(), what: `approval: ${ev.detail}` });
        setImmediate(() => { mgr.resolveApproval(sid, aid, ev.id, true); pendingSince.delete(ev.id); note(`auto-allowed: ${ev.detail}`); });
        return;
      case 'todos':
        if (aid === mainId) {
          const first = !todos.length;
          todos = (ev.items ?? []).map((t: any) => ({ content: t.content, status: t.status }));
          if (first) { stage('Task list created', `${todos.length} steps`); }
          const done = todos.filter((t) => t.status === 'completed').length;
          note(`todos ${done}/${todos.length}`);
          if (todos.length && done === todos.length) { seen.add('todos-complete'); }
        }
        return;
      case 'agentSettings':
        if (aid === mainId && modes[modes.length - 1] !== ev.settings?.mode) { modes.push(ev.settings.mode); note(`mode -> ${ev.settings.mode}`); }
        return;
      case 'info':
        if (/^Project checks (passed|skipped)/.test(ev.text)) { seen.add('auto-checks'); }
        if (/Checked after the last change: .*✓/.test(ev.text)) { seen.add('verified'); }
        note(`${who} info: ${ev.text}`);
        return;
      default:
        note(`${who} ${ev.type}`);
    }
  };

  mgr = new SessionManager({
    store: new SessionStore2(path.join(opts.outDir, 'sessions')),
    createAgent,
    agentTypes: () => BUILTIN_AGENT_TYPES,
    defaults: () => ({ mode: 'plan', effort: opts.effort, model: opts.llmConfig.model }),
    onEvent,
    maxConcurrent: () => 4,
    saveThrottleMs: 60_000,
  });
  const session = mgr.newSession();
  mainId = [...session.agents.keys()][0];
  const rt = mgr.agent(session.id, mainId);
  modes.push(rt.settings.mode);
  if (rt.settings.mode === 'plan') { seen.add('mode:plan'); }

  let verdict: Verdict | undefined;
  let reason = '';
  let stuck: BuildReport['stuck'];
  const watchdog = setInterval(() => {
    if (verdict) { return; }
    const now = Date.now();
    const idle = (now - lastEvent) / 1000;
    const late = [...pendingSince.values()].filter((p) => now - p.at > opts.pendingSeconds * 1000);
    const unanswered = [...rt.pending.keys()].filter((id) => !pendingSince.has(id));
    let why = '';
    if ((now - started) / 1000 > opts.timeoutSeconds) { verdict = 'TIMEOUT'; why = `overall limit of ${opts.timeoutSeconds}s reached`; }
    else if (late.length) { verdict = 'STUCK'; why = `prompt not resolved after ${opts.pendingSeconds}s: ${late.map((p) => p.what).join(', ')}`; }
    else if (rt.status === 'waiting' && unanswered.length && idle > opts.pendingSeconds) { verdict = 'STUCK'; why = `waiting on a prompt the harness never saw (${unanswered.join(', ')})`; }
    else if (idle > opts.idleSeconds) { verdict = 'STUCK'; why = `no agent activity for ${Math.round(idle)}s`; }
    if (!verdict) { return; }
    reason = why;
    stuck = { activity: rt.activity, status: rt.status, idleSeconds: Math.round(idle), pending: [...rt.pending.keys()] };
    stage(verdict, `${why} (last activity: "${rt.activity}")`);
    mgr.stopAll(session.id);
  }, 2000);

  let followUps = 0;
  let grades: Grade[] = [];
  try {
    stage('Started', `model ${opts.llmConfig.model}, effort ${opts.effort}, mode ${rt.settings.mode}`);
    let prompt = opts.prompt ?? PROJECT_PROMPT;
    for (;;) {
      note(`USER: ${prompt}`);
      try { await mgr.send(session.id, mainId, prompt, { noQueue: true }); } catch (e: any) {
        if (!verdict) { verdict = 'ERROR'; reason = e?.message ?? String(e); stage('ERROR', reason); }
      }
      if (rt.status === 'error' && !verdict) { verdict = 'ERROR'; reason = rt.error ?? 'agent error'; stage('ERROR', reason); }
      if (verdict) { break; }
      stage(followUps ? `Follow-up ${followUps} finished` : 'Agent finished its turn', `mode ${rt.settings.mode}, todos ${todos.filter((t) => t.status === 'completed').length}/${todos.length}`);
      grades = gradeProject(workDir, scratch);
      const passed = grades.every((g) => g.passed);
      stage('Grading', grades.map((g) => `${g.passed ? 'PASS' : 'FAIL'} ${g.name}`).join(' | '));
      if (passed) { verdict = followUps ? 'COMPLETED_WITH_NUDGES' : 'COMPLETED'; reason = followUps ? `passed after ${followUps} follow-up(s)` : 'finished autonomously and all grades pass'; break; }
      if (followUps >= opts.maxFollowUps) { verdict = 'INCOMPLETE'; reason = `grades still failing after ${followUps} follow-up(s)`; break; }
      followUps++;
      const failing = grades.filter((g) => !g.passed).map((g) => `- ${g.name}: ${g.output.slice(-800)}`).join('\n');
      prompt = `${FOLLOW_UP}\n\nThese checks currently fail:\n${failing}`;
    }
  } finally {
    clearInterval(watchdog);
  }
  if (!grades.length) { grades = gradeProject(workDir, scratch); }

  const features: Record<string, boolean> = {};
  for (const [name, test] of FEATURES) { features[name] = test(toolCalls, seen); }
  const report: BuildReport = {
    verdict: verdict!, reason, workDir, durationMs: Date.now() - started, followUps, tokens: rt.tokens,
    stages, features, toolCalls, failedTools, todos, modes, grades, ...(stuck ? { stuck } : {}), logFile,
  };
  note(`RESULT ${report.verdict}: ${reason}`);
  await new Promise<void>((r) => log.end(r));
  return report;
}

export function formatBuildReport(r: BuildReport): string {
  const mins = (r.durationMs / 60000).toFixed(1);
  const lines = [
    '', '=================== END-TO-END BUILD REPORT ===================',
    `Verdict : ${r.verdict}  (${r.reason})`,
    `Time    : ${mins} min · follow-ups ${r.followUps} · tokens ${r.tokens.toLocaleString()} · failed tool calls ${r.failedTools}`,
    `Modes   : ${r.modes.join(' -> ')}`,
    '', 'Stages:', ...r.stages.map((s) => `  ${s.at}  ${s.stage}${s.detail ? ` — ${s.detail.slice(0, 160)}` : ''}`),
    '', 'Features exercised:', ...Object.entries(r.features).map(([k, v]) => `  ${v ? '✔' : '✘'} ${k}`),
    '', `Tool calls: ${Object.entries(r.toolCalls).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', ')}`,
    `Todos (${r.todos.filter((t) => t.status === 'completed').length}/${r.todos.length} done):`, ...r.todos.map((t) => `  [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`),
    '', 'Grades:', ...r.grades.map((g) => `  ${g.passed ? 'PASS' : 'FAIL'}  ${g.name}${g.passed ? '' : `\n        ${g.output.trim().split('\n').slice(-8).join('\n        ')}`}`),
    ...(r.stuck ? ['', `Stuck at: status=${r.stuck.status}, activity="${r.stuck.activity}", idle ${r.stuck.idleSeconds}s, pending=[${r.stuck.pending.join(', ')}]`] : []),
    '', `Project : ${r.workDir}`, `Log     : ${r.logFile}`,
    '===============================================================',
  ];
  return lines.join('\n');
}

interface Args { model?: string; effort: Effort; idle: number; pending: number; timeout: number; followups: number; rounds: number; out?: string }

export function parseBuildArgs(argv: string[]): Args | string {
  const a: Args = { effort: 'medium', idle: 300, pending: 60, timeout: 3600, followups: 2, rounds: 1200 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    const num = (): number => { const n = Number(v); if (!Number.isFinite(n) || n < 0) { throw new Error(`${k} needs a number`); } i++; return n; };
    try {
      switch (k) {
        case '--model': if (!v) { return '--model needs a value'; } a.model = v; i++; break;
        case '--effort': if (!v || !isEffort(v)) { return '--effort must be low, medium, high or max'; } a.effort = v; i++; break;
        case '--idle': a.idle = num(); break;
        case '--pending': a.pending = num(); break;
        case '--timeout': a.timeout = num(); break;
        case '--followups': a.followups = Math.floor(num()); break;
        case '--max-rounds': a.rounds = Math.max(1, Math.floor(num())); break;
        case '--out': if (!v) { return '--out needs a value'; } a.out = v; i++; break;
        case '--help': case '-h': return 'help';
        default: return `unknown option ${k}`;
      }
    } catch (e: any) { return e.message; }
  }
  return a;
}

const USAGE = 'Usage: npm run e2e:build -- [--model <id>] [--effort low|medium|high|max] [--idle 300] [--pending 60] [--timeout 3600] [--followups 2] [--max-rounds 1200] [--out <dir>]';

async function main(): Promise<number> {
  const args = parseBuildArgs(process.argv.slice(2));
  if (typeof args === 'string') { console.log(args === 'help' ? USAGE : `${args}\n${USAGE}`); return args === 'help' ? 0 : 2; }
  const baseUrl = process.env.INFRAON_EVAL_BASE_URL ?? '';
  const apiKey = process.env.INFRAON_EVAL_API_KEY ?? '';
  const model = args.model ?? process.env.INFRAON_EVAL_MODEL ?? '';
  const missing = [!baseUrl && 'INFRAON_EVAL_BASE_URL', !apiKey && 'INFRAON_EVAL_API_KEY', !model && 'INFRAON_EVAL_MODEL (or --model)'].filter(Boolean);
  if (missing.length) { console.log(`Missing configuration: ${missing.join(', ')}.\n${USAGE}`); return 2; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const results = path.resolve(process.cwd(), 'eval-results');
  fs.mkdirSync(results, { recursive: true });
  if (!fs.existsSync(path.join(results, '.gitignore'))) { fs.writeFileSync(path.join(results, '.gitignore'), '*\n'); }
  const outDir = args.out ? path.resolve(args.out) : path.join(os.tmpdir(), `infraon-build-${stamp}`);
  console.log(`Building "taskly" end to end in ${outDir}\n`);
  const report = await runBuild({
    llmConfig: { baseUrl, apiKey, model, ...resolveSampling(model), allowSelfSigned: process.env.INFRAON_EVAL_ALLOW_SELF_SIGNED === '1' },
    effort: args.effort, idleSeconds: args.idle, pendingSeconds: args.pending, timeoutSeconds: args.timeout, maxFollowUps: args.followups, maxRounds: args.rounds, outDir,
  }, streamChat);
  const file = path.join(results, `build-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${formatBuildReport(report)}\nJSON    : ${file}`);
  return report.verdict === 'COMPLETED' ? 0 : report.verdict === 'COMPLETED_WITH_NUDGES' ? 1 : report.verdict === 'INCOMPLETE' ? 4 : report.verdict === 'STUCK' || report.verdict === 'TIMEOUT' ? 5 : 3;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e?.stack ?? e); process.exitCode = 3; });
}
