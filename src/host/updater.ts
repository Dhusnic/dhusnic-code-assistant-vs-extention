import * as vscode from 'vscode';
import { loadPolicy } from '../core/centralPolicy';
import { UPDATE_PUBLIC_KEY } from '../core/updateKey';
import { checkForUpdate, defaultUpdateUrl, downloadUpdate, sameOrigin, UpdateManifest } from '../core/updater';

const CHECK_EVERY_MS = 4 * 60 * 60_000;
const IDLE_POLL_MS = 60_000;
const KEY_SECRET = 'infraonAssistant.apiKey';

/**
 * Checks the company server for a newer build, installs it in the background after verifying its signature and hash,
 * and asks for a window reload. Never reloads by itself, and never prompts while an agent is running.
 */
export class Updater implements vscode.Disposable {
  private timers: NodeJS.Timeout[] = [];
  private running?: Promise<void>;
  /** Version installed in this window but not yet loaded (needs a reload). */
  private pending?: UpdateManifest;
  private prompting = false;
  private readonly log = vscode.window.createOutputChannel('Infraon Assistant Updates');

  constructor(private ctx: vscode.ExtensionContext, private isBusy: () => boolean) {}

  private get current(): string { return String(this.ctx.extension.packageJSON.version ?? '0.0.0'); }

  /** Checks now, then every few hours. */
  start(): void {
    void this.check(false);
    this.timers.push(setInterval(() => { void this.check(false); }, CHECK_EVERY_MS));
  }

  dispose(): void {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
    this.log.dispose();
  }

  /** One check at a time; a manual check during an automatic one waits for it and reports its outcome. */
  check(manual: boolean): Promise<void> {
    this.running ??= this.run(manual).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async run(manual: boolean): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('infraonAssistant');
    try {
      const { policy } = await loadPolicy({ url: cfg.get<string>('policyUrl', '') || undefined, cacheFile: vscode.Uri.joinPath(this.ctx.globalStorageUri, 'policy-cache.json').fsPath });
      if (policy.disableAutoUpdate === true) {
        if (manual) { void vscode.window.showInformationMessage('Infraon Assistant: updates are turned off by your organization\'s policy.'); }
        return;
      }
      if (this.pending) { this.promptReload(this.pending); return; }
      const auto = cfg.get<boolean>('autoUpdate', true);
      if (!auto && !manual) { return; }

      const baseUrl = policy.baseUrl ?? cfg.get<string>('baseUrl', '');
      const manifestUrl = policy.updateUrl ?? (cfg.get<string>('updateUrl', '').trim() || defaultUpdateUrl(baseUrl));
      if (!manifestUrl) { throw new Error('no update URL: set infraonAssistant.baseUrl or infraonAssistant.updateUrl'); }
      const allowSelfSigned = policy.allowSelfSignedTls ?? cfg.get<boolean>('allowSelfSignedTls', true);
      // The API key belongs to the gateway; it is sent only when the update server is that same host.
      const apiKey = sameOrigin(manifestUrl, baseUrl) ? await this.ctx.secrets.get(KEY_SECRET) : undefined;

      this.log.appendLine(`[${new Date().toISOString()}] checking ${manifestUrl} (installed ${this.current})`);
      const result = await checkForUpdate({ manifestUrl, currentVersion: this.current, vscodeVersion: vscode.version, publicKeyPem: UPDATE_PUBLIC_KEY, allowSelfSigned, apiKey });
      if (result.kind === 'current') {
        this.log.appendLine(`  up to date (server has ${result.latest})`);
        if (manual) { void vscode.window.showInformationMessage(`Infraon Assistant ${this.current} is the latest version.`); }
        return;
      }
      const m = result.manifest;
      if (result.kind === 'incompatible') {
        this.log.appendLine(`  ${m.version} needs VS Code ${m.minVscode}; this is ${vscode.version}`);
        if (manual || m.mandatory) { void vscode.window.showWarningMessage(`Infraon Assistant ${m.version} needs VS Code ${m.minVscode} or newer (you have ${vscode.version}). Update VS Code to get it.`); }
        return;
      }
      if (!auto) {
        const pick = await vscode.window.showInformationMessage(`Infraon Assistant ${m.version} is available (you have ${this.current}).`, 'Install', 'Later');
        if (pick !== 'Install') { return; }
      }
      await this.install(m, allowSelfSigned, apiKey, manual);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      this.log.appendLine(`  failed: ${msg}`);
      if (manual) { void vscode.window.showErrorMessage(`Infraon Assistant update check failed: ${msg}`, 'Show Log').then((p) => { if (p) { this.log.show(); } }); }
    }
  }

  private async install(m: UpdateManifest, allowSelfSigned: boolean, apiKey: string | undefined, manual: boolean): Promise<void> {
    const work = async () => {
      this.log.appendLine(`  downloading ${m.url}`);
      const file = await downloadUpdate(m, { dir: vscode.Uri.joinPath(this.ctx.globalStorageUri, 'updates').fsPath, allowSelfSigned, apiKey });
      this.log.appendLine(`  verified, installing ${file}`);
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
    };
    if (manual) {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing Infraon Assistant ${m.version}…` }, work);
    } else {
      await work();
    }
    this.log.appendLine(`  installed ${m.version}; reload pending`);
    this.pending = m;
    this.promptReload(m);
  }

  /** Waits until no agent is running, then asks for a reload. */
  private promptReload(m: UpdateManifest): void {
    if (this.prompting) { return; }
    this.prompting = true;
    const ask = async () => {
      if (this.isBusy()) { this.timers.push(setTimeout(() => { void ask(); }, IDLE_POLL_MS)); return; }
      try {
        const notes = m.notes ? ` ${m.notes}` : '';
        const text = m.mandatory
          ? `Infraon Assistant ${m.version} is a required update and has been installed. Reload the window to start using it.${notes}`
          : `Infraon Assistant ${m.version} has been installed. Reload the window to use it.${notes}`;
        const pick = await vscode.window.showInformationMessage(text, { modal: m.mandatory }, 'Reload Now', ...(m.mandatory ? [] : ['Later']));
        if (pick === 'Reload Now') { await vscode.commands.executeCommand('workbench.action.reloadWindow'); }
      } finally { this.prompting = false; }
    };
    void ask();
  }
}
