import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { randomBytes } from 'crypto';
import { buildSidebarHtml } from '../core/html';
import type { Hub, SidebarSink } from './hub';
import { FieldError, LinuxInput, checkLinux, validateServerName } from './features/servers';
import type { SshTarget } from '../core/ssh';

/** Activity-bar view: LLM status and usage, and the session manager (all sessions, live agent activity). */
export class SidebarView implements vscode.WebviewViewProvider, SidebarSink {
  private view?: vscode.WebviewView;
  private healthTimer?: NodeJS.Timeout;

  constructor(private hub: Hub) {
    hub.sidebar = this;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.hub.media] };
    void this.render(view.webview);
    view.webview.onDidReceiveMessage((m) => void this.onMessage(m).catch((e) => void vscode.window.showErrorMessage(e.message ?? String(e))));
    view.onDidChangeVisibility(() => { if (view.visible) { this.refresh(); } });
    clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => { if (view.visible) { void this.hub.checkHealth(); } }, 60_000);
    view.onDidDispose(() => clearInterval(this.healthTimer));
  }

  private async render(w: vscode.Webview): Promise<void> {
    const u = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.hub.media, f)).toString();
    w.html = buildSidebarHtml({
      nonce: randomBytes(16).toString('hex'), cspSource: w.cspSource,
      logoSvg: await fs.readFile(vscode.Uri.joinPath(this.hub.media, 'logo.svg').fsPath, 'utf8'),
      cssUri: u('chat.css'), jsUri: u('sidebar.js'), mdUri: u('md.js'), probeUri: u('probe.js'),
    });
  }

  post(m: unknown): void { void this.view?.webview.postMessage(m); }

  refresh(): void {
    if (!this.view?.visible) { return; }
    void Promise.all([
      this.hub.sessionsView(),
      this.hub.servers.linuxList(),
    ]).then(([sessions, linuxServers]) => {
      const mcpServers = this.hub.servers.mcpList();
      void this.view?.webview.postMessage({ 
        type: 'data', 
        llm: this.hub.llmInfo(), 
        sessions, 
        mcpServers, 
        linuxServers: linuxServers.map((s) => ({ ...s, connected: this.hub.remote.isConnected(s.name) })), 
        skills: this.hub.skillViews(), 
        skillErrors: this.hub.skillErrors.length, 
        e2e: this.hub.e2e 
      });
    });
  }

  private static envOf(m: any): Record<string, string> {
    const env: Record<string, string> = {};
    for (const row of Array.isArray(m.env) ? m.env : []) { const k = String(row?.[0] ?? '').trim(); if (k) { env[k] = String(row?.[1] ?? ''); } }
    return env;
  }

  /** The Linux fields of a saveServer / testServer message. */
  private static linuxInput(m: any, env: Record<string, string>): LinuxInput {
    return {
      name: String(m.name ?? '').trim(), host: String(m.host ?? '').trim(), port: Number(m.port), user: String(m.user ?? '').trim(),
      auth: m.auth === 'key' ? 'key' : 'password', password: m.password ? String(m.password) : undefined, key: m.key ? String(m.key) : undefined,
      passphrase: m.passphrase ? String(m.passphrase) : undefined, env,
      notes: typeof m.notes === 'string' ? m.notes : undefined,
    };
  }

  /** Validates and saves a server from the dialog, then tells the dialog whether to close. */
  private async saveServer(m: any): Promise<void> {
    const original = typeof m.original === 'string' && m.original ? m.original : undefined;
    const env = SidebarView.envOf(m);
    try {
      if (m.kind === 'linux') {
        await this.hub.servers.saveLinux(original, SidebarView.linuxInput(m, env));
      } else {
        await this.hub.servers.saveMcp(original, { name: String(m.name ?? '').trim(), commandLine: String(m.commandLine ?? ''), env });
      }
      this.post({ type: 'serverResult', ok: true });
      this.refresh();
    } catch (e: any) { this.post({ type: 'serverResult', ok: false, error: e.message ?? String(e), field: e instanceof FieldError ? e.field : undefined }); }
  }

  /**
   * Tries an SSH connection with the dialog's details without saving them. When editing, an empty credential or
   * environment value falls back to the saved one; stored credentials never go back to the webview.
   */
  private async testServer(m: any): Promise<void> {
    try {
      if (m.kind !== 'linux') { throw new Error('Only Linux servers can be tested.'); }
      const requested = typeof m.original === 'string' && m.original ? m.original : undefined;
      const original = requested && this.hub.servers.linuxSync().some((s) => s.name === requested) ? requested : undefined;
      if (requested && !original) { throw new Error(`The server "${requested}" no longer exists.`); }
      const input = SidebarView.linuxInput(m, SidebarView.envOf(m));
      const err = checkLinux(input, !original);
      if (err) { throw err; }
      const saved = original ? await this.hub.servers.credentials(original) : {};
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(input.env)) { env[k] = v || saved.env?.[k] || ''; }
      const newKey = input.key?.trim() ? input.key : undefined;
      const target: SshTarget = {
        name: input.name, host: input.host, port: input.port, user: input.user, env,
        password: input.auth === 'password' ? (input.password || saved.password) : undefined,
        privateKey: input.auth === 'key' ? (newKey ?? saved.key) : undefined,
        // A newly pasted key never inherits the passphrase of the saved one.
        passphrase: input.auth === 'key' ? (input.passphrase || (newKey ? undefined : saved.passphrase)) : undefined,
      };
      if (input.auth === 'password' && !target.password) { throw new FieldError('password', 'Enter the password.'); }
      if (input.auth === 'key' && !target.privateKey) { throw new FieldError('key', 'Paste the private key.'); }
      const text = await this.hub.remote.test(target);
      this.post({ type: 'serverTest', ok: true, text: text || `Connected to ${input.user}@${input.host}.` });
    } catch (e: any) { this.post({ type: 'serverTest', ok: false, text: e?.message ?? String(e), field: e instanceof FieldError ? e.field : undefined }); }
  }

  private async onMessage(m: any): Promise<void> {
    const hub = this.hub;
    switch (m.type) {
      case '__probeResult': hub.resolveProbe(m.id, m.result); return;
      case '__error': hub.logWebviewError('sidebar', m); return;
      case 'ready': this.refresh(); void hub.checkHealth(); void hub.ensureMcp(); break;
      case 'refresh': await hub.checkHealth(true); this.refresh(); break;
      case 'newSession': await hub.newSession(); break;
      case 'openSession': await hub.openSession(String(m.id)); break;
      case 'deleteSession': await hub.deleteSession(String(m.id)); break;
      case 'renameSession': await hub.renameSession(String(m.id)); break;
      case 'stopAgent': hub.manager.stop(String(m.sid), String(m.aid)); break;
      case 'stopSession': hub.manager.stopAll(String(m.id)); break;
      case 'setModel': if (typeof m.value === 'string') { hub.setDefaults({ model: m.value }); this.refresh(); } break;
      case 'openSettings': await vscode.commands.executeCommand('workbench.action.openSettings', 'infraonAssistant'); break;
      case 'setApiKey': await vscode.commands.executeCommand('infraonAssistant.setApiKey'); await hub.checkHealth(); break;
      case 'openSkill': await hub.openSkill(String(m.name)); break;
      case 'runSkill': await hub.newSession(`/${String(m.name)} `); break;
      case 'deepSearch': (await import('./features/workbench')).searchPicker(hub, String(m.q ?? '')); break;
      case 'manageSkills': await hub.openSkillsManager(m.view === 'new' ? 'new' : 'list'); break;
      case 'verify': {
        void this.view?.webview.postMessage({ type: 'verifying' });
        const r = await hub.verifyStorage();
        void this.view?.webview.postMessage({ type: 'verifyResult', ...r });
        break;
      }
      case 'saveServer': await this.saveServer(m); break;
      case 'testServer': await this.testServer(m); break;
      case 'deleteServer': {
        const kind = m.kind === 'linux' ? 'linux' : 'mcp', name = String(m.name ?? '');
        const ok = await vscode.window.showWarningMessage(`Delete the ${kind === 'linux' ? 'Linux' : 'MCP'} server "${name}"${kind === 'linux' ? ' and its stored credentials' : ''}?`, { modal: true }, 'Delete');
        if (ok === 'Delete') { await hub.servers.remove(kind, name); this.refresh(); }
        break;
      }
      case 'cloneServer': {
        const kind = m.kind === 'linux' ? 'linux' : 'mcp', name = String(m.name ?? '');
        const newName = await vscode.window.showInputBox({ prompt: `Name for the copy of "${name}"`, value: `${name}-copy`, validateInput: (x) => validateServerName(kind, x.trim()) });
        if (!newName?.trim()) { break; }
        try { await hub.servers.clone(kind, name, newName.trim()); this.refresh(); } catch (e: any) { void vscode.window.showErrorMessage(e.message ?? String(e)); }
        break;
      }
    }
  }
}
