/**
 * UI test runner: starts the fake gateway, builds an isolated VS Code profile and workspace, launches the VS Code
 * already installed on this machine, runs the suite inside it, and always cleans up what it started.
 *
 *   node out/e2e/run.js
 *
 * Environment:
 *   INFRAON_E2E_CODE       path to Code.exe (or the `code` launcher) to use instead of the one on PATH
 *   INFRAON_E2E_DOWNLOAD=1 allow downloading VS Code when none is installed (never happens otherwise)
 *   INFRAON_E2E_GREP       regular expression: only run flows whose name matches
 *   INFRAON_E2E_TMP        parent folder for the temporary profile and workspace (default: the OS temp folder)
 *   INFRAON_E2E_KEEP=1     keep the temporary profile and workspace for debugging
 *   INFRAON_E2E_STRICT=1   count known failures as failures
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';
import { CdpClient } from './cdp';
import { FakeGateway } from './fakeGateway';
import { ENV, MODELS, RunResults } from './protocol';

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, '.e2e');
const SHOTS_DIR = path.join(OUT_DIR, 'screenshots');
const RESULTS = path.join(OUT_DIR, 'results.json');
/** Whole run, including VS Code start-up and shutdown. */
const WATCHDOG_MS = 285_000;
/** Time the suite may spend starting flows; leaves room for shutdown before the watchdog. */
const SUITE_BUDGET_MS = 255_000;

/* ------------------------------------------------------------ locating VS Code */

function fromLauncher(launcher: string): string | undefined {
  const real = fs.realpathSync(launcher);
  const bin = path.dirname(real);
  const candidates = process.platform === 'win32' ? [path.join(bin, '..', 'Code.exe'), path.join(bin, '..', 'Code - Insiders.exe')]
    : process.platform === 'darwin' ? [path.join(bin, '..', '..', '..', 'MacOS', 'Electron'), path.join(bin, '..', '..', '..', 'MacOS', 'Code')]
      : [path.join(bin, '..', 'code'), path.join(bin, '..', 'code-insiders')];
  return candidates.map((c) => path.resolve(c)).find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
}

function findOnPath(): string | undefined {
  const names = process.platform === 'win32' ? ['code.cmd'] : ['code'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (dir && fs.existsSync(p)) { const exe = fromLauncher(p); if (exe) { return exe; } }
    }
  }
  return undefined;
}

/** undefined means "let @vscode/test-electron download one" (only with INFRAON_E2E_DOWNLOAD=1). */
function resolveVsCode(): string | undefined {
  const override = process.env.INFRAON_E2E_CODE;
  if (override) {
    if (!fs.existsSync(override)) { throw new Error(`INFRAON_E2E_CODE does not exist: ${override}`); }
    return /\.(cmd|bat|sh)$/i.test(override) || path.basename(path.dirname(override)) === 'bin' ? (fromLauncher(override) ?? override) : override;
  }
  const found = findOnPath();
  if (found) { return found; }
  if (process.env.INFRAON_E2E_DOWNLOAD === '1') { return undefined; }
  throw new Error('VS Code was not found: the `code` command is not on PATH. Set INFRAON_E2E_CODE to Code.exe, or INFRAON_E2E_DOWNLOAD=1 to allow a download.');
}

/* ------------------------------------------------------------ isolated profile and workspace */

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function createWorkspace(dir: string): void {
  write(path.join(dir, 'README.md'), '# E2E fixture\n\nA small workspace used by the automated UI tests.\n');
  write(path.join(dir, 'CLAUDE.md'), '# Project rules\n\nThis file exists so the context popup can show a memory file.\n');
  write(path.join(dir, 'src', 'app.ts'), 'export const value = 1;\n');
  write(path.join(dir, 'notes.txt'), 'first line\nsecond line\n');
  write(path.join(dir, '.claude', 'skills', 'demo-skill', 'SKILL.md'), [
    '---', 'name: demo-skill', 'description: Demo skill for the automated UI tests. Use when the test suite asks for the demo skill.', '---',
    '# Goal', 'Say hello.', '', '# Steps', '1. Say hello.', '',
  ].join('\n'));
}

function writeUserSettings(userDataDir: string, gatewayUrl: string): void {
  write(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({
    'infraonAssistant.baseUrl': `${gatewayUrl}/v1`,
    'infraonAssistant.model': MODELS[0],
    'infraonAssistant.allowSelfSignedTls': true,
    'infraonAssistant.inlineCompletions.enabled': false,
    'infraonAssistant.autoApprove': false,
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.colorTheme': 'Default Dark Modern',
    'window.restoreWindows': 'none',
    'window.confirmBeforeClose': 'never',
    'files.hotExit': 'off',
    'git.enabled': false,
    'git.autoRepositoryDetection': false,
    'chat.disableAIFeatures': true,
    'http.proxySupport': 'off',
    'editor.minimap.enabled': false,
  }, null, 2));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
  });
}

/* ------------------------------------------------------------ process clean-up */

/**
 * Kills only processes whose command line contains this run's unique temporary folder name,
 * so a VS Code window the user has open can never match.
 */
function killStartedProcesses(marker: string): void {
  try {
    if (process.platform === 'win32') {
      const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${marker}') -and $_.ProcessId -ne $PID -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { $_.ProcessId }`;
      const pids = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30_000 }).split(/\s+/).filter(Boolean);
      for (const pid of pids) {
        try { execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', timeout: 15_000 }); } catch { /* already gone */ }
      }
    } else {
      const pids = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).split(/\s+/).filter((p) => p && Number(p) !== process.pid);
      for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ } }
    }
  } catch { /* nothing matched */ }
}

/** cmd.exe parses the launch line on Windows, so paths with spaces must arrive quoted. */
const quoted = (value: string): string => (process.platform === 'win32' && /\s/.test(value) ? `"${value}"` : value);

/* ------------------------------------------------------------ reporting */

function readResults(): RunResults | undefined {
  try { return JSON.parse(fs.readFileSync(RESULTS, 'utf8')); } catch { return undefined; }
}

function printSummary(r: RunResults): void {
  const mark: Record<string, string> = { passed: 'PASS', failed: 'FAIL', 'known-failure': 'KNOWN', 'unexpected-pass': 'XPASS', skipped: 'SKIP' };
  console.log('\n---------------------------------- E2E summary ----------------------------------');
  for (const s of r.testsuites) {
    console.log(`\n${s.name}`);
    for (const t of s.testcases) {
      console.log(`  ${(mark[t.status] ?? t.status).padEnd(5)} ${t.name} (${t.time.toFixed(1)}s)`);
      if (t.failure) { console.log(`        ${t.failure.message.split('\n').join('\n        ')}`); }
      if (t.knownFailure) { console.log(`        known bug: ${t.knownFailure}`); }
    }
  }
  console.log(`\n${r.tests} tests: ${r.passed} passed, ${r.failures} failed, ${r.knownFailures} known failures, ${r.skipped} skipped (${r.time.toFixed(1)}s)`);
  console.log(`Results:     ${RESULTS}\nScreenshots: ${SHOTS_DIR}`);
}

/* ------------------------------------------------------------ main */

async function main(): Promise<number> {
  const executable = resolveVsCode();
  console.log(`VS Code: ${executable ?? '(download requested by INFRAON_E2E_DOWNLOAD=1)'}`);

  // Never inherit a parent VS Code's session (for example when started from its integrated terminal).
  for (const k of Object.keys(process.env)) {
    if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('VSCODE_')) { delete process.env[k]; }
  }

  fs.rmSync(SHOTS_DIR, { recursive: true, force: true });
  fs.rmSync(RESULTS, { force: true });
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  const tmpParent = process.env.INFRAON_E2E_TMP || os.tmpdir();
  fs.mkdirSync(tmpParent, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpParent, 'infraon-e2e-'));
  const marker = path.basename(runDir);
  const userDataDir = path.join(runDir, 'user-data');
  const extensionsDir = path.join(runDir, 'extensions');
  const home = path.join(runDir, 'home');
  const workspace = path.join(runDir, 'workspace');
  for (const d of [extensionsDir, home]) { fs.mkdirSync(d, { recursive: true }); }
  createWorkspace(workspace);

  const gateway = new FakeGateway();
  let cdp: CdpClient | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let timedOut = false;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) { return; }
    cleaned = true;
    clearTimeout(watchdog);
    cdp?.close();
    killStartedProcesses(marker);
    await gateway.stop().catch(() => undefined);
    if (process.env.INFRAON_E2E_KEEP !== '1') {
      fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  };
  const onSignal = (): void => { void cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await gateway.start();
    writeUserSettings(userDataDir, gateway.url);
    const debugPort = await freePort();
    cdp = new CdpClient(debugPort);
    const client = cdp;
    gateway.onScreenshot = async (name) => {
      const file = path.join(SHOTS_DIR, `${name.replace(/[^\w.-]+/g, '_')}.png`);
      try { await client.screenshot(file); return { file }; } catch (e: any) { return { error: e.message ?? String(e) }; }
    };

    watchdog = setTimeout(() => {
      timedOut = true;
      console.error(`\nE2E watchdog: the run exceeded ${WATCHDOG_MS / 1000}s; stopping VS Code.`);
      killStartedProcesses(marker);
    }, WATCHDOG_MS);

    let launchError: unknown;
    try {
      await runTests({
        ...(executable ? { vscodeExecutablePath: executable } : {}),
        extensionDevelopmentPath: quoted(ROOT),
        extensionTestsPath: quoted(path.join(__dirname, 'suite', 'index.js')),
        launchArgs: [
          quoted(workspace),
          quoted(`--user-data-dir=${userDataDir}`),
          quoted(`--extensions-dir=${extensionsDir}`),
          `--remote-debugging-port=${debugPort}`,
          '--disable-extensions',
          '--disable-telemetry',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
          '--disable-background-timer-throttling',
          '--new-window',
        ],
        extensionTestsEnv: {
          [ENV.control]: gateway.url,
          [ENV.outDir]: OUT_DIR,
          [ENV.workspace]: workspace,
          [ENV.budgetMs]: String(SUITE_BUDGET_MS),
          ...(process.env.INFRAON_E2E_GREP ? { [ENV.grep]: process.env.INFRAON_E2E_GREP } : {}),
          ...(process.env.INFRAON_E2E_STRICT ? { [ENV.strict]: process.env.INFRAON_E2E_STRICT } : {}),
          // ~/.claude skills, ~/.vscode/argv.json and the like come from this empty home, not the user's.
          HOME: home, USERPROFILE: home,
          NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
        },
      });
    } catch (e) { launchError = e; }

    const results = readResults();
    if (results) { printSummary(results); }
    if (timedOut) { console.error('FAILED: the run hit the time limit.'); return 1; }
    if (!results) { console.error(`FAILED: no results were written. ${String(launchError ?? '')}`); return 1; }
    if (!results.complete) { console.error('FAILED: the suite did not finish.'); return 1; }
    if (results.failures > 0) { return 1; }
    if (launchError) { console.error(`FAILED: VS Code exited abnormally: ${String(launchError)}`); return 1; }
    return 0;
  } finally {
    await cleanup();
  }
}

main().then((code) => process.exit(code), (e) => {
  console.error(`E2E runner error: ${e?.stack ?? e}`);
  process.exit(2);
});
