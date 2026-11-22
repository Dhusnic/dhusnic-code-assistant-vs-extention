import * as vscode from 'vscode';
import * as path from 'path';
import { BrowserSession } from '../../core/testing/browser';
import { findBrowser, launchBrowser } from '../../core/testing/cdp';
import { DbConnection, validateConnections } from '../../core/testing/db';
import { createTestingTools } from '../../core/testing/tools';
import type { Tool } from '../../core/tool';

export interface TestingHost {
  ctx: vscode.ExtensionContext;
  cfg: vscode.WorkspaceConfiguration;
  output: vscode.OutputChannel;
  addKnownSecret(value: string, kind: string): void;
  vision(): ((dataUrl: string, question: string, signal: AbortSignal) => Promise<string>) | undefined;
}

const secretKey = (name: string) => `infraonAssistant.testingDb.${name}`;

/** Browser, API and database testing for the agents: one browser per chat session, closed when idle. */
export class TestingService implements vscode.Disposable {
  private browsers = new Map<string, { session?: BrowserSession; starting?: Promise<BrowserSession> }>();
  private toolCache = new Map<string, Tool[]>();
  private timer: NodeJS.Timeout;
  private warned = new Set<string>();

  constructor(private host: TestingHost) {
    this.timer = setInterval(() => void this.closeIdle(), 60_000);
    host.ctx.subscriptions.push(this);
    void this.preloadSecrets();
  }

  private get cfg() { return this.host.cfg; }
  enabled(): boolean { return this.cfg.get<boolean>('testing.enabled', true); }

  databases(): DbConnection[] {
    const { connections, errors } = validateConnections(this.cfg.get('testing.databases', []));
    for (const e of errors) { if (!this.warned.has(e)) { this.warned.add(e); this.host.output.appendLine(`[testing] ${e}`); } }
    return connections;
  }

  /** The URL the session's browser is on (the guard checks where typed secrets would go). */
  currentUrl(sid: string): string | undefined {
    const b = this.browsers.get(sid)?.session;
    return b && !b.closed ? b.url : undefined;
  }

  tools(sid: string): Tool[] {
    if (!this.enabled()) { return []; }
    const cached = this.toolCache.get(sid);
    if (cached) { return cached; }
    const list = createTestingTools({
      browser: (create) => this.browser(sid, create),
      closeBrowser: () => this.close(sid),
      artifactsDir: (root) => path.join(root, this.cfg.get<string>('testing.reportsFolder', 'test-reports'), 'screenshots'),
      databases: () => this.databases(),
      dbPassword: (name) => Promise.resolve(this.host.ctx.secrets.get(secretKey(name))),
      // Resolved per call, so a vision model configured later is used without a reload.
      vision: () => this.host.vision(),
      defaults: () => ({ timeoutSec: this.num('testing.timeoutSeconds', 30, 1, 600), ignoreHttpsErrors: this.cfg.get<boolean>('testing.ignoreHttpsErrors', false) }),
    });
    this.toolCache.set(sid, list);
    return list;
  }

  private num(key: string, def: number, min: number, max: number): number {
    const v = this.cfg.get<number>(key, def);
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def;
  }

  private async browser(sid: string, create: boolean): Promise<BrowserSession | undefined> {
    const slot = this.browsers.get(sid) ?? {};
    this.browsers.set(sid, slot);
    if (slot.session && !slot.session.closed) { slot.session.lastUsed = Date.now(); return slot.session; }
    slot.session = undefined;
    if (!create) { return undefined; }
    if (!slot.starting) {
      slot.starting = this.launch().then((s) => { slot.session = s; return s; }).finally(() => { slot.starting = undefined; });
    }
    return slot.starting;
  }

  private async launch(): Promise<BrowserSession> {
    const configured = this.cfg.get<string>('testing.browserPath', '').trim();
    const exe = findBrowser(configured || undefined);
    if (!exe) {
      throw new Error(configured
        ? `The browser in the setting infraonAssistant.testing.browserPath was not found: ${configured}`
        : 'No Chrome, Edge or Chromium was found on this machine. Install one, or set infraonAssistant.testing.browserPath to its executable.');
    }
    const headless = this.cfg.get<boolean>('testing.headless', true);
    this.host.output.appendLine(`[testing] starting ${path.basename(exe)}${headless ? ' (headless)' : ''}`);
    const b = await launchBrowser({ executable: exe, headless, width: 1366, height: 800, ignoreHttpsErrors: this.cfg.get<boolean>('testing.ignoreHttpsErrors', false) });
    return BrowserSession.start(b, { slowMs: this.num('testing.slowRequestMs', 3000, 100, 600_000) });
  }

  async close(sid: string): Promise<boolean> {
    const slot = this.browsers.get(sid);
    this.browsers.delete(sid);
    const s = slot?.session ?? (slot?.starting ? await slot.starting.catch(() => undefined) : undefined);
    if (!s) { return false; }
    await s.close().catch(() => undefined);
    return true;
  }

  /** A deleted chat: its browser and its sub-agents' browsers go too. */
  async closeSession(sid: string): Promise<void> {
    const keys = new Set([...this.browsers.keys(), ...this.toolCache.keys()].filter((k) => k === sid || k.startsWith(`${sid}#`)));
    for (const k of keys) { this.toolCache.delete(k); await this.close(k); }
  }

  private async closeIdle(): Promise<void> {
    const limit = this.num('testing.browserIdleMinutes', 10, 1, 1440) * 60_000;
    for (const [sid, slot] of this.browsers) {
      if (slot.session && (slot.session.closed || Date.now() - slot.session.lastUsed > limit)) { await this.close(sid); }
    }
  }

  /** Saved database passwords are masked in everything sent to the model, from the first message on. */
  private async preloadSecrets(): Promise<void> {
    for (const c of this.databases()) {
      const p = await this.host.ctx.secrets.get(secretKey(c.name));
      if (p && p.length >= 4) { this.host.addKnownSecret(p, 'database_password'); }
    }
  }

  async setDatabasePassword(): Promise<void> {
    const dbs = this.databases().filter((d) => d.type !== 'sqlite');
    if (!dbs.length) {
      const open = await vscode.window.showInformationMessage('No server databases are configured yet. Add one to the setting "infraonAssistant.testing.databases" first.', 'Open Settings');
      if (open) { void vscode.commands.executeCommand('workbench.action.openSettingsJson'); }
      return;
    }
    const pick = await vscode.window.showQuickPick(await Promise.all(dbs.map(async (d) => ({ label: d.name, description: `${d.type} · ${d.user ?? ''}@${d.host ?? 'localhost'}${d.database ? `/${d.database}` : ''}`, detail: (await this.host.ctx.secrets.get(secretKey(d.name))) ? 'password saved' : 'no password saved' }))), { placeHolder: 'Which database? The password is kept in VS Code\'s encrypted secret storage.' });
    if (!pick) { return; }
    const value = await vscode.window.showInputBox({ prompt: `Password for ${pick.label} — leave empty to remove the saved password. Use a read-only database user.`, password: true, ignoreFocusOut: true });
    if (value === undefined) { return; }
    if (value) { await this.host.ctx.secrets.store(secretKey(pick.label), value); this.host.addKnownSecret(value, 'database_password'); }
    else { await this.host.ctx.secrets.delete(secretKey(pick.label)); }
    void vscode.window.showInformationMessage(value ? `Password for ${pick.label} saved.` : `Password for ${pick.label} removed.`);
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const sid of [...this.browsers.keys()]) { void this.close(sid); }
  }
}
