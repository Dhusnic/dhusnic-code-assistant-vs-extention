import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ENV, MODELS, RunResults, SuiteResult, TestCaseResult, TestStatus } from '../protocol';
import { Harness, waitFor } from './harness';
import { Flow, FlowContext } from './types';

const DEFAULT_TIMEOUT_MS = 30_000;

interface LoadedSuite { name: string; flows: Flow[] }

/** EXTENSION POINT: every compiled file in flows/ is a suite; see the note in types.ts. */
function loadSuites(): LoadedSuite[] {
  const dir = path.join(__dirname, 'flows');
  const suites = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_')).sort().map((f) => {
    const mod = require(path.join(dir, f)) as { flows?: Flow[] };
    if (!Array.isArray(mod.flows)) { throw new Error(`${f} must export a "flows" array`); }
    return { name: f.replace(/\.js$/, ''), flows: mod.flows };
  });
  const seen = new Set<string>();
  for (const flow of suites.flatMap((s) => s.flows)) {
    if (seen.has(flow.name)) { throw new Error(`duplicate flow name: ${flow.name}`); }
    seen.add(flow.name);
  }
  return suites;
}

function withTimeout(p: Promise<void>, ms: number, name: string): Promise<void> {
  let timer: NodeJS.Timeout;
  const limit = new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error(`Flow "${name}" exceeded its ${ms} ms time limit`)), ms); });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** Problems a flow must never leave behind, whatever it was testing. */
async function verifyClean(h: Harness): Promise<void> {
  const errors: Array<{ where: string; message: string }> = h.hub.webviewErrors;
  if (errors.length) { throw new Error(`hub.webviewErrors is not empty: ${errors.map((e) => `[${e.where}] ${e.message}`).join(' | ')}`); }
  const gw = await h.gw.state();
  if (gw.unscripted) { throw new Error(`The extension made ${gw.unscripted} LLM request(s) this flow did not script.`); }
  if (gw.pending) { throw new Error(`${gw.pending} scripted LLM repl${gw.pending === 1 ? 'y was' : 'ies were'} never requested.`); }
}

/** Leaves a window with no tabs and no running agents for the next flow. */
async function cleanup(h: Harness): Promise<void> {
  const hub = h.hub;
  try {
    hub.manager.stopAll();
    await h.gw.reset();
    await waitFor('all agents to stop', () => !hub.manager.snapshot().some((s: any) => s.agents.some((a: any) => ['queued', 'running', 'waiting'].includes(a.status))), 8000);
  } catch (e) { console.warn(`[e2e] cleanup: ${e}`); }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor('all session tabs to close', () => hub.openPanelIds().length === 0, 5000).catch(() => {
    for (const id of hub.openPanelIds()) { hub.panels?.get(id)?.panel.dispose(); }
  });
  await h.gw.reset();
  hub.webviewErrors.length = 0;
}

async function runFlow(h: Harness, suite: string, flow: Flow): Promise<TestCaseResult> {
  const started = Date.now();
  const t = new FlowContext(h, flow);
  h.hub.setDefaults({ mode: 'ask', effort: 'medium', model: MODELS[0] });
  h.hub.webviewErrors.length = 0;
  await h.gw.reset();
  // VS Code's "extensions are disabled" toast would otherwise cover part of every screenshot.
  await vscode.commands.executeCommand('notifications.clearAll');

  let error: any;
  try {
    await withTimeout(flow.run(t), flow.timeoutMs ?? DEFAULT_TIMEOUT_MS, flow.name);
    await verifyClean(h);
  } catch (e) { error = e; }

  if (error) {
    const shot = await h.screenshot(flow.name);
    if (shot) { t.screenshots.push(shot); }
  }
  await cleanup(h);

  const strict = process.env[ENV.strict] === '1';
  const known = !!flow.knownFailure && !strict;
  const status: TestStatus = error ? (known ? 'known-failure' : 'failed') : (known ? 'unexpected-pass' : 'passed');
  const failure = error
    ? { message: String(error?.message ?? error), stack: error?.stack }
    : status === 'unexpected-pass' ? { message: `Passes now: remove knownFailure from this flow ("${flow.knownFailure}").` } : undefined;
  return {
    name: flow.name, classname: suite, status, time: (Date.now() - started) / 1000,
    ...(failure ? { failure } : {}), ...(flow.knownFailure ? { knownFailure: flow.knownFailure } : {}), screenshots: t.screenshots,
  };
}

function summarize(suites: SuiteResult[], startedAt: number, complete: boolean): RunResults {
  const all = suites.flatMap((s) => s.testcases);
  const n = (...st: TestStatus[]) => all.filter((t) => st.includes(t.status)).length;
  return {
    name: 'infraon-code-assistant-e2e', timestamp: new Date(startedAt).toISOString(), complete,
    tests: all.length, passed: n('passed'), failures: n('failed', 'unexpected-pass', 'skipped'), knownFailures: n('known-failure'), skipped: n('skipped'),
    time: (Date.now() - startedAt) / 1000, testsuites: suites,
  };
}

/** Entry point called by VS Code (extensionTestsPath). Rejecting makes VS Code exit with a failure code. */
export async function run(): Promise<void> {
  const startedAt = Date.now();
  const outDir = process.env[ENV.outDir] ?? path.join(__dirname, '..', '..', '..', '.e2e');
  const budget = Number(process.env[ENV.budgetMs] ?? 255_000);
  const grep = process.env[ENV.grep] ? new RegExp(process.env[ENV.grep]!) : undefined;
  const suites: SuiteResult[] = [];
  const save = (complete: boolean): RunResults => {
    const r = summarize(suites, startedAt, complete);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(r, null, 2));
    return r;
  };

  let h: Harness;
  let loaded: LoadedSuite[];
  try {
    loaded = loadSuites();
    h = await Harness.create();
  } catch (e: any) {
    suites.push({ name: 'setup', tests: 1, failures: 1, time: 0, testcases: [{ name: 'setup', classname: 'setup', status: 'failed', time: 0, failure: { message: String(e?.message ?? e), stack: e?.stack }, screenshots: [] }] });
    save(true);
    throw e;
  }

  for (const s of loaded) {
    const flows = s.flows.filter((f) => !grep || grep.test(f.name));
    if (!flows.length) { continue; }
    const suiteStart = Date.now();
    const result: SuiteResult = { name: s.name, tests: 0, failures: 0, time: 0, testcases: [] };
    suites.push(result);
    for (const flow of flows) {
      let tc: TestCaseResult;
      if (Date.now() - startedAt > budget) {
        tc = { name: flow.name, classname: s.name, status: 'skipped', time: 0, failure: { message: `Not run: the suite used up its ${budget / 1000}s budget.` }, screenshots: [] };
      } else {
        console.log(`[e2e] > ${flow.name}`);
        tc = await runFlow(h, s.name, flow).catch((e): TestCaseResult => ({ name: flow.name, classname: s.name, status: 'failed', time: 0, failure: { message: `Harness error: ${e?.message ?? e}`, stack: e?.stack }, screenshots: [] }));
        console.log(`[e2e] ${tc.status.toUpperCase()} ${flow.name} (${tc.time.toFixed(1)}s)${tc.failure ? `: ${tc.failure.message}` : ''}`);
      }
      result.testcases.push(tc);
      result.tests++;
      if (['failed', 'unexpected-pass', 'skipped'].includes(tc.status)) { result.failures++; }
      result.time = (Date.now() - suiteStart) / 1000;
      save(false);
    }
  }

  const final = save(true);
  if (final.failures) { throw new Error(`${final.failures} of ${final.tests} UI tests failed.`); }
}
