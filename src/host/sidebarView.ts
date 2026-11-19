import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { randomBytes } from 'crypto';
import { buildSidebarHtml } from '../core/html';
import type { Hub, SidebarSink } from './hub';

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
    void this.hub.sessionsView().then((sessions) => {
      void this.view?.webview.postMessage({ type: 'data', llm: this.hub.llmInfo(), sessions, skills: this.hub.skillViews(), skillErrors: this.hub.skillErrors.length, e2e: this.hub.e2e });
    });
  }

  private async onMessage(m: any): Promise<void> {
    const hub = this.hub;
    switch (m.type) {
      case '__probeResult': hub.resolveProbe(m.id, m.result); return;
      case '__error': hub.logWebviewError('sidebar', m); return;
      case 'ready': this.refresh(); void hub.checkHealth(); void hub.ensureMcp(); break;
      case 'refresh': await hub.checkHealth(); this.refresh(); break;
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
    }
  }
}
