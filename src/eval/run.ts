/**
 * Measures how often the real company LLM completes real coding tasks with this agent.
 *
 *   npm run eval -- [--tasks <dir>] [--filter <regex>] [--model <id>] [--effort low|medium|high|max] [--repeat N] [--keep]
 *                   [--history | --history-file <file>]
 *                   [--agent infraon|cline|both] [--cline <path>] [--cline-thinking <level>] [--native-sampling]
 *
 * Environment (never prompted for):
 *   INFRAON_EVAL_BASE_URL          the gateway, e.g. https://llm.internal/v1
 *   INFRAON_EVAL_API_KEY           its API key
 *   INFRAON_EVAL_MODEL             model id (or --model)
 *   INFRAON_EVAL_ALLOW_SELF_SIGNED=1   accept the gateway's self-signed certificate
 *
 * Every task runs in a fresh temp copy of eval/tasks/<task>/repo with the extension's real agent, tools and
 * automatic checks, in Auto-execute mode. Results go to eval-results/<timestamp>.json; logs sit next to them.
 * --filter matches task names, tags, difficulty and language. Tasks whose toolchain (task.json "requires") is
 * missing here are skipped and listed. --history appends a one-line summary (date, extension version, model,
 * pass rate, per-task results, repeat count) to eval/results/history.jsonl, which git ignores; see eval/README.md.
 *
 * Comparison with Cline (--agent cline|both): every agent talks to the gateway through the local metering proxy in
 * meter.ts, which counts calls, tokens and model time identically for all of them and, unless --native-sampling,
 * writes this model's sampling profile into every request so all agents sample the same way. Cline runs isolated
 * and cut off from every host but the proxy (see cline.ts). --cline points at the Cline install (default: the one
 * on PATH, or INFRAON_EVAL_CLINE). History is only written for this extension's own runs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { streamChat } from '../core/llm';
import { NON_STANDARD_FIELDS, resolveSampling, samplingBody } from '../core/sampling';
import { Effort, isEffort } from '../core/policy';
import { ClineConfig, clineLauncher, findCline, setupClineHome } from './cline';
import { Meter, startMeter } from './meter';
import { AgentKind, appendHistory, formatReport, historyEntry, runEval } from './runner';
import { findTasksDir, loadTasks, missingToolchains } from './tasks';

interface Args {
  tasks?: string; filter?: string; model?: string; effort: Effort; repeat: number; keep: boolean; history?: string;
  agents: AgentKind[]; cline?: string; clineThinking?: string; nativeSampling: boolean;
}

/** Marks "use the default history file" until the tasks folder is known. */
export const DEFAULT_HISTORY = '<default>';

export function parseArgs(argv: string[]): Args | string {
  const a: Args = { effort: 'medium', repeat: 1, keep: false, agents: ['infraon'], nativeSampling: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) { throw new Error(`${k} needs a value`); } return v; };
    try {
      switch (k) {
        case '--tasks': a.tasks = val(); break;
        case '--filter': a.filter = val(); new RegExp(a.filter); break;
        case '--model': a.model = val(); break;
        case '--effort': { const e = val(); if (!isEffort(e)) { return `--effort must be low, medium, high or max (got ${e})`; } a.effort = e; break; }
        case '--repeat': { const n = Number(val()); if (!Number.isInteger(n) || n < 1) { return '--repeat must be a positive whole number'; } a.repeat = n; break; }
        case '--keep': a.keep = true; break;
        case '--history': a.history ??= DEFAULT_HISTORY; break;
        case '--history-file': a.history = val(); break;
        case '--agent': {
          const v = val();
          if (v === 'both') { a.agents = ['infraon', 'cline']; } else if (v === 'infraon' || v === 'cline') { a.agents = [v]; } else { return `--agent must be infraon, cline or both (got ${v})`; }
          break;
        }
        case '--cline': a.cline = val(); break;
        case '--cline-thinking': a.clineThinking = val(); break;
        case '--native-sampling': a.nativeSampling = true; break;
        case '--help': case '-h': return 'help';
        default: return `unknown option ${k}`;
      }
    } catch (e: any) { return e.message; }
  }
  return a;
}

const USAGE = 'Usage: npm run eval -- [--tasks <dir>] [--filter <regex>] [--model <id>] [--effort low|medium|high|max] [--repeat N] [--keep] [--history | --history-file <file>]\n'
  + '                    [--agent infraon|cline|both] [--cline <path to cline install>] [--cline-thinking none|low|medium|high|xhigh] [--native-sampling]';

/** The extension version from the package.json above this file (out/eval or src/eval), or "unknown". */
export function extensionVersion(start = __dirname): string {
  for (let cur = path.resolve(start); ; cur = path.dirname(cur)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cur, 'package.json'), 'utf8'));
      if (pkg?.name === 'infraon-code-assistant' && typeof pkg.version === 'string') { return pkg.version; }
    } catch { /* keep looking */ }
    if (path.dirname(cur) === cur) { return 'unknown'; }
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') { console.log(args === 'help' ? USAGE : `${args}\n${USAGE}`); return args === 'help' ? 0 : 2; }
  const baseUrl = process.env.INFRAON_EVAL_BASE_URL ?? '';
  const apiKey = process.env.INFRAON_EVAL_API_KEY ?? '';
  const model = args.model ?? process.env.INFRAON_EVAL_MODEL ?? '';
  const missing = [!baseUrl && 'INFRAON_EVAL_BASE_URL', !apiKey && 'INFRAON_EVAL_API_KEY', !model && 'INFRAON_EVAL_MODEL (or --model)'].filter(Boolean);
  if (missing.length) {
    console.log(`Missing configuration: ${missing.join(', ')}.\nSet them as environment variables, for example in PowerShell:\n  $env:INFRAON_EVAL_BASE_URL = "https://<gateway>/v1"\n  $env:INFRAON_EVAL_API_KEY = "<key>"\n  $env:INFRAON_EVAL_MODEL = "<model id>"\n${USAGE}`);
    return 2;
  }
  const tasksDir = args.tasks ? path.resolve(args.tasks) : findTasksDir(__dirname, process.cwd());
  if (!tasksDir) { console.log('Could not find eval/tasks. Pass --tasks <dir>.'); return 2; }
  const loaded = loadTasks(tasksDir);
  for (const e of loaded.errors) { console.log(`skipping ${e}`); }
  const re = args.filter ? new RegExp(args.filter, 'i') : undefined;
  const matching = loaded.tasks.filter((t) => !re || [t.name, ...(t.tags ?? []), t.difficulty ?? '', t.language ?? ''].some((g) => g && re.test(g)));
  const skipped: string[] = [];
  const tasks = matching.filter((t) => {
    const missing = missingToolchains(t);
    if (missing.length) { skipped.push(t.name); console.log(`skipping ${t.name}: needs ${missing.join(', ')}`); }
    return !missing.length;
  });
  if (!tasks.length) { console.log('No tasks to run.'); return 2; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(process.cwd(), 'eval-results');
  fs.mkdirSync(outDir, { recursive: true });
  // Results contain model output and paths of this machine: keep them out of git.
  if (!fs.existsSync(path.join(outDir, '.gitignore'))) { fs.writeFileSync(path.join(outDir, '.gitignore'), '*\n'); }
  const logDir = path.join(outDir, `${stamp}-logs`);

  const allowSelfSigned = process.env.INFRAON_EVAL_ALLOW_SELF_SIGNED === '1';
  const sampling = resolveSampling(model);
  const comparing = args.agents.includes('cline');
  let meter: Meter | undefined;
  let cline: ClineConfig | undefined;
  if (comparing) {
    const bin = args.cline ?? process.env.INFRAON_EVAL_CLINE ?? findCline();
    if (!bin) { console.log('Cline not found. Install it (npm install -g cline) or pass --cline <folder or launcher>.'); return 2; }
    try { clineLauncher(bin); } catch (e: any) { console.log(e.message); return 2; }
    const force = args.nativeSampling ? undefined : { temperature: sampling.temperature, ...samplingBody(sampling.sampling) };
    meter = await startMeter({ upstream: baseUrl, apiKey, allowSelfSigned, force, droppable: [...NON_STANDARD_FIELDS] });
    const home = path.join(outDir, `${stamp}-cline-home`);
    cline = { bin, baseUrl: meter.url, apiKey: meter.agentKey, model, home, thinking: args.clineThinking };
    setupClineHome(cline);
  }
  // Through the proxy, the extension gets the placeholder key too; it adds the real one.
  const llmConfig = meter
    ? { baseUrl: meter.url, apiKey: meter.agentKey, model, ...sampling, allowSelfSigned: false }
    : { baseUrl, apiKey, model, ...sampling, allowSelfSigned };

  console.log(`Running ${tasks.length} task(s) × ${args.repeat} with ${model} (effort ${args.effort})${comparing ? ` for ${args.agents.join(' and ')}` : ''}\n`);
  let report;
  try {
    report = await runEval({
      tasks, effort: args.effort, repeat: args.repeat, keep: args.keep, logDir, print: (l) => console.log(l),
      llmConfig, agents: args.agents, meter, cline,
    }, { llm: streamChat });
    if (meter) { report.forcedSampling = meter.forced(); }
  } finally { await meter?.close(); }
  const file = path.join(outDir, `${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${formatReport(report)}\n\nResults: ${file}\nLogs:    ${logDir}`);
  if (args.history && !args.agents.includes('infraon')) { console.log('History: not written (only this extension\'s runs go into it).'); }
  else if (args.history) {
    const historyFile = args.history === DEFAULT_HISTORY ? path.join(path.dirname(tasksDir), 'results', 'history.jsonl') : path.resolve(args.history);
    const own = { ...report, runs: report.runs.filter((r) => r.agent === 'infraon'), summary: report.byAgent?.infraon ?? report.summary };
    appendHistory(historyFile, historyEntry(own, tasks, extensionVersion(), skipped));
    console.log(`History: ${historyFile}`);
  }
  return report.summary.passed === report.summary.runs ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e?.stack ?? e); process.exitCode = 3; });
}
