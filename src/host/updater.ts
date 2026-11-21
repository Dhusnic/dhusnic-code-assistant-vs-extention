import * as vscode from 'vscode';
import { loadPolicy } from '../core/centralPolicy';
import { UPDATE_PUBLIC_KEYS } from '../core/updateKey';
import {
  checkForUpdate, compareVersions, defaultUpdateUrl, downloadUpdate, readInstallRecord, UpdateManifest, withInstallLock, withTimeout, writeInstallRecord,
} from '../core/updater';

const CHECK_EVERY_MS = 4 * 60 * 60_000;
const IDLE_POLL_MS = 60_000;
const MANDATORY_REPROMPT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** Background failures in a row (about 8 hours at the normal interval) before the user is told once. */
const FAILURES_BEFORE_WARNING = 3;

type Pending = Pick<UpdateManifest, 'version' | 'mandatory' | 'notes'>;

/**
 * Checks the company server for a newer build, installs it in the background after verifying its signature and hash,
 * and asks for a window reload. Never reloads by itself, and never while an agent is running.
 */
export class Updater implements vscode.Disposable {
  private timers = new Set<NodeJS.Timeout>();
  private running?: Promise<void>;
  /** A release installed in this profile but not loaded in this window yet. */
  private pending?: Pending;
  private prompting = false;
  /** Releases already offered in this window while automatic installation is off. */
  private offered = new Set<string>();
  private failures = 0;
  private warned = false;
  private disposed = false;
  private readonly log = vscode.window.createOutputChannel('Infraon Assistant Updates');

  constructor(private ctx: vscode.ExtensionContext, private isBusy: () => boolean) {}

  private get current(): string { return String(this.ctx.extension.packageJSON.version ?? '0.0.0'); }
  private get dir(): string { return vscode.Uri.joinPath(this.ctx.globalStorageUri, 'updates').fsPath; }

  /** Checks now, then every few hours. */
  start(): void {
    void this.check(false);
    const t = setInterval(() => { void this.check(false); }, CHECK_EVERY_MS);
    this.timers.add(t);
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers.clear();
    this.log.dispose();
  }

  private later(fn: () => void, ms: number): void {
    if (this.disposed) { return; }
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  /**
   * One check at a time. A manual check that arrives during an automatic one waits for it and then runs itself, so
   * the command always reports a result.
   */
  async check(manual: boolean): Promise<void> {
    while (this.running) {
      const inFlight = this.running;
      await inFlight.catch(() => undefined);
      if (!manual) { return; }
    }
    this.running = this.run(manual).finally(() => { this.running = undefined; });
    return this.running;
  }

  /**
   * Settings that decide where the extension connects come from the user's own settings only: a repository's
   * workspace settings must not be able to point the updater at another server.
   */
  private userSetting<T>(key: string, fallback: T): T {
    const i = vscode.workspace.getConfiguration('infraonAssistant').inspect<T>(key);
    return i?.globalValue ?? i?.defaultValue ?? fallback;
  }

  private async run(manual: boolean): Promise<void> {
    try {
      const { policy } = await loadPolicy({ url: this.userSetting('policyUrl', '') || undefined, cacheFile: vscode.Uri.joinPath(this.ctx.globalStorageUri, 'policy-cache.json').fsPath });
      if (policy.disableAutoUpdate === true) {
        if (manual) { void vscode.window.showInformationMessage('Infraon Assistant: updates are turned off by your organization\'s policy.'); }
        return;
      }
      // Another window of this profile may already have installed a newer release.
      const record = await readInstallRecord(this.dir);
      if (record && compareVersions(record.version, this.current) > 0 && !this.pending) { this.pending = { version: record.version, mandatory: false }; }
      if (this.pending) { this.promptReload(this.pending); return; }

      const baseUrl = policy.baseUrl ?? this.userSetting('baseUrl', '');
      const manifestUrl = policy.updateUrl ?? (this.userSetting('updateUrl', '').trim() || defaultUpdateUrl(baseUrl));
      if (!manifestUrl) { throw new Error('no update URL: set infraonAssistant.baseUrl or infraonAssistant.updateUrl in your user settings'); }
      const allowSelfSigned = policy.allowSelfSignedTls ?? this.userSetting('allowSelfSignedTls', true);

      this.log.appendLine(`[${new Date().toISOString()}] checking ${manifestUrl} (installed ${this.current})`);
      const result = await checkForUpdate({ manifestUrl, currentVersion: this.current, vscodeVersion: vscode.version, publicKeysPem: UPDATE_PUBLIC_KEYS, allowSelfSigned });
      this.failures = 0;
      if (result.kind === 'unpublished') {
        this.log.appendLine('  no release is published on the server yet');
        if (manual) { void vscode.window.showInformationMessage(`Infraon Assistant ${this.current}: no update is published on the server yet.`); }
        return;
      }
      if (result.kind === 'current') {
        this.log.appendLine(`  up to date (server has ${result.latest})`);
        if (manual) { void vscode.window.showInformationMessage(`Infraon Assistant ${this.current} is the latest version.`); }
        return;
      }
      const m = result.manifest;
      if (result.kind === 'incompatible') {
        this.log.appendLine(`  ${m.version} needs VS Code ${m.minVscode}; this is ${vscode.version}`);
        if (manual || (m.mandatory && !this.offered.has(m.version))) {
          this.offered.add(m.version);
          void vscode.window.showWarningMessage(`Infraon Assistant ${m.version} needs VS Code ${m.minVscode} or newer (you have ${vscode.version}). Update VS Code to get it.`);
        }
        return;
      }
      // With automatic installation off, a release is still announced: once per window, or whenever asked.
      if (!this.userSetting('autoUpdate', true) && !m.mandatory) {
        if (!manual && this.offered.has(m.version)) { return; }
        this.offered.add(m.version);
        const pick = await vscode.window.showInformationMessage(`Infraon Assistant ${m.version} is available (you have ${this.current}).${m.notes ? ` ${m.notes}` : ''}`, 'Install', 'Later');
        if (pick !== 'Install') { return; }
      }
      await this.install(m, allowSelfSigned, manual);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      this.log.appendLine(`  failed: ${msg}`);
      const showLog = (p: string | undefined) => { if (p) { this.log.show(); } };
      if (manual) {
        void vscode.window.showErrorMessage(`Infraon Assistant update check failed: ${msg}`, 'Show Log').then(showLog);
      } else if (++this.failures >= FAILURES_BEFORE_WARNING && !this.warned) {
        this.warned = true;                                           // once per window: a long outage must not nag
        void vscode.window.showWarningMessage(`Infraon Assistant could not check for updates ${this.failures} times in a row: ${msg}`, 'Show Log').then(showLog);
      }
    }
  }

  private async install(m: UpdateManifest, allowSelfSigned: boolean, manual: boolean): Promise<void> {
    // undefined: another window holds the lock. { pending: undefined }: nothing newer than this window to load.
    const work = () => withInstallLock(this.dir, async (): Promise<{ pending?: Pending }> => {
      // Inside the lock: a window that installed the same or a newer release first wins.
      const record = await readInstallRecord(this.dir);
      if (record && compareVersions(record.version, m.version) >= 0) {
        this.log.appendLine(`  ${record.version} was already installed by another window`);
        if (compareVersions(record.version, this.current) <= 0) { return {}; }
        return { pending: record.version === m.version ? { version: m.version, mandatory: m.mandatory, notes: m.notes } : { version: record.version, mandatory: false } };
      }
      this.log.appendLine(`  downloading ${m.url}`);
      const file = await downloadUpdate(m, { dir: this.dir, allowSelfSigned });
      this.log.appendLine(`  verified, installing ${file}`);
      await withTimeout(vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file)), INSTALL_TIMEOUT_MS, 'VS Code did not finish installing the update in 5 minutes');
      await writeInstallRecord(this.dir, m.version);
      return { pending: { version: m.version, mandatory: m.mandatory, notes: m.notes } };
    });
    const res = manual
      ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing Infraon Assistant ${m.version}…` }, work)
      : await work();
    if (!res) {
      this.log.appendLine('  another window is installing the update; this window will check again later');
      if (manual) { void vscode.window.showInformationMessage('Infraon Assistant: another VS Code window is installing the update right now. Try again in a minute.'); }
      return;
    }
    if (!res.pending) { return; }
    this.log.appendLine(`  installed ${res.pending.version}; reload pending`);
    this.pending = res.pending;
    this.promptReload(res.pending);
  }

  /** Waits until no agent is running, then asks for a reload; checks again when the user answers. */
  private promptReload(p: Pending): void {
    if (this.prompting) { return; }
    this.prompting = true;
    const ask = async (): Promise<void> => {
      if (this.disposed) { this.prompting = false; return; }
      if (this.isBusy()) { this.later(() => { void ask(); }, IDLE_POLL_MS); return; }
      const notes = p.notes ? ` ${p.notes}` : '';
      const text = p.mandatory
        ? `Infraon Assistant ${p.version} is a required update and has been installed. Reload the window to start using it.${notes}`
        : `Infraon Assistant ${p.version} has been installed. Reload the window to use it.${notes}`;
      const pick = await vscode.window.showInformationMessage(text, { modal: p.mandatory }, 'Reload Now', ...(p.mandatory ? [] : ['Later']));
      if (pick === 'Reload Now') {
        // An agent may have started while the prompt was open: never cut it off.
        if (this.isBusy()) {
          void vscode.window.showInformationMessage('Infraon Assistant: an agent is running. The window reloads to finish the update as soon as it is done.');
          const whenIdle = () => { if (this.isBusy()) { this.later(whenIdle, IDLE_POLL_MS / 6); } else { void vscode.commands.executeCommand('workbench.action.reloadWindow'); } };
          this.later(whenIdle, IDLE_POLL_MS / 6);
          return;
        }
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
        return;
      }
      this.prompting = false;
      // A required update comes back shortly after being dismissed.
      if (p.mandatory) { this.later(() => this.promptReload(p), MANDATORY_REPROMPT_MS); }
    };
    void ask().catch(() => { this.prompting = false; });
  }
}
