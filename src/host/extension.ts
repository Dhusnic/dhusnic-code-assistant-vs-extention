import * as vscode from 'vscode';
import type { Hub } from './hub';
import type { SidebarView } from './sidebarView';
import type { InlineCompletionProvider } from './completions';
import type { Updater } from './updater';

/**
 * Activation must stay tiny: this file statically imports only `vscode`. Everything else (the hub, agents, search,
 * LLM client, webviews) is loaded the first time the user actually needs it.
 */

const PANEL_TYPE = 'infraonAssistant.session';
const KEY_SECRET = 'infraonAssistant.apiKey';

/** View ids used by earlier versions of this extension. */
export const LEGACY_VIEW_IDS = ['infraonAssistant.chat'];

interface Core { hub: Hub; sidebar: SidebarView }
let core: Promise<Core> | undefined;
let loaded: Core | undefined;

function staleViewNotice(view: vscode.WebviewView): void {
  view.webview.options = { enableScripts: false, enableCommandUris: ['workbench.action.reloadWindow'] };
  view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"></head>
<body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px;line-height:1.5">
<p><b>Infraon Assistant was updated.</b></p>
<p>This panel belongs to the previous version. Reload the window to open the new session manager.</p>
<p><a href="command:workbench.action.reloadWindow" style="display:inline-block;padding:4px 12px;border-radius:3px;text-decoration:none;background:var(--vscode-button-background);color:var(--vscode-button-foreground)">Reload window</a></p>
</body></html>`;
}

/** Loads the hub once, on first real use. */
function getCore(context: vscode.ExtensionContext): Promise<Core> {
  core ??= (async () => {
    const [{ Hub }, { SidebarView }, { DIFF_SCHEME, DiffContentProvider }] = await Promise.all([import('./hub'), import('./sidebarView'), import('./diffProvider')]);
    const diffs = new DiffContentProvider();
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffs));
    const hub = new Hub(context, diffs);
    loaded = { hub, sidebar: new SidebarView(hub) };
    return loaded;
  })();
  return core;
}

/** Ghost-text provider that loads the completion engine on the first request, and never while completions are off. */
class LazyCompletions implements vscode.InlineCompletionItemProvider {
  private real?: Promise<InlineCompletionProvider>;
  constructor(private context: vscode.ExtensionContext) {}
  async provideInlineCompletionItems(doc: vscode.TextDocument, pos: vscode.Position, ctx: vscode.InlineCompletionContext, token: vscode.CancellationToken) {
    if (!completionsEnabled()) { return undefined; }
    this.real ??= import('./completions').then((m) => new m.InlineCompletionProvider(this.context));
    return (await this.real).provideInlineCompletionItems(doc, pos, ctx, token);
  }
}

const completionSettings = () => vscode.workspace.getConfiguration('infraonAssistant.inlineCompletions');
const completionsEnabled = () => completionSettings().get<boolean>('enabled', true);

export function activate(context: vscode.ExtensionContext): void {
  const hub = () => getCore(context).then((c) => c.hub);
  const workbench = () => import('./features/workbench');

  // This module is small: its providers and commands load the LLM and hub only when they are used.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  (require('./features/editorActions') as typeof import('./features/editorActions')).registerEditorActions(context, async () => (await hub()).editorHost());

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'infraonAssistant.toggleInlineCompletions';
  const refreshStatus = () => {
    const on = completionsEnabled();
    status.text = on ? '$(sparkle) Infraon' : '$(circle-slash) Infraon';
    status.tooltip = `Inline completions: ${on ? 'on' : 'off'} (click to toggle)`;
    status.show();
  };
  refreshStatus();
  void importInstallerKey(context);

  context.subscriptions.push(
    status,
    vscode.window.registerWebviewViewProvider('infraonAssistant.sessions', {
      resolveWebviewView: async (view, ctx, token) => { (await getCore(context)).sidebar.resolveWebviewView(view); void ctx; void token; },
    }, { webviewOptions: { retainContextWhenHidden: true } }),
    // VS Code can hot-restart the extension host after an update without reloading the window; the window then
    // still shows views from the previous manifest. Answer those ids so they never spin forever.
    ...LEGACY_VIEW_IDS.map((id) => vscode.window.registerWebviewViewProvider(id, { resolveWebviewView: (v) => staleViewNotice(v) })),
    vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, {
      deserializeWebviewPanel: async (panel, state) => (await hub()).restorePanel(panel, (state as { sessionId?: string } | undefined)?.sessionId),
    }),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, new LazyCompletions(context)),
    vscode.commands.registerCommand('infraonAssistant.newSession', async () => (await hub()).newSession()),
    vscode.commands.registerCommand('infraonAssistant.newChat', async () => (await hub()).newSession()),
    vscode.commands.registerCommand('infraonAssistant.setApiKey', async () => {
      const key = await vscode.window.showInputBox({ prompt: 'Company LLM API key', password: true, ignoreFocusOut: true });
      if (key) { await context.secrets.store(KEY_SECRET, key); vscode.window.showInformationMessage('API key saved.'); }
    }),
    vscode.commands.registerCommand('infraonAssistant.toggleInlineCompletions', async () => {
      await completionSettings().update('enabled', !completionsEnabled(), vscode.ConfigurationTarget.Global);
      refreshStatus();
    }),
    vscode.commands.registerCommand('infraonAssistant.explainSelection', async () => selectionPrompt(await hub(), 'Explain this code')),
    vscode.commands.registerCommand('infraonAssistant.fixSelection', async () => selectionPrompt(await hub(), 'Find and fix problems in this code, and apply the fix')),
    vscode.commands.registerCommand('infraonAssistant.searchSessions', async () => (await workbench()).searchPicker(await hub())),
    vscode.commands.registerCommand('infraonAssistant.editMemory', async () => (await workbench()).editMemory(await hub())),
    vscode.commands.registerCommand('infraonAssistant.openPermissions', async () => (await workbench()).editPermissions(await hub())),
    vscode.commands.registerCommand('infraonAssistant.forgetHostKey', async () => (await hub()).remote.forgetHostKey()),
    vscode.commands.registerCommand('infraonAssistant.setWebApiKey', async () => (await hub()).web.setKey()),
    vscode.commands.registerCommand('infraonAssistant.clearWebCache', async () => { void vscode.window.showInformationMessage(await (await hub()).web.clearCache()); }),
    vscode.commands.registerCommand('infraonAssistant.manageSchedules', async () => (await (await hub()).getScheduler()).manage()),
    vscode.commands.registerCommand('infraonAssistant.manageServers', async () => {
      await vscode.commands.executeCommand('infraonAssistant.sessions.focus');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('infraonAssistant.inlineCompletions')) { refreshStatus(); } }),
  );
  // Self-update: the updater module loads 30 s after start-up (or on the command), never during activation.
  let updater: Updater | undefined;
  const getUpdater = async (): Promise<Updater> => {
    if (!updater) {
      const { Updater: U } = await import('./updater');
      updater ??= new U(context, agentsBusy);
      context.subscriptions.push(updater);
    }
    return updater;
  };
  if (context.extensionMode !== vscode.ExtensionMode.Test) {
    const updateTimer = setTimeout(() => { getUpdater().then((u) => u.start(), () => undefined); }, 30_000);
    updateTimer.unref?.();
    context.subscriptions.push({ dispose: () => clearTimeout(updateTimer) });
  }
  context.subscriptions.push(vscode.commands.registerCommand('infraonAssistant.checkForUpdates', async () => (await getUpdater()).check(true)));
  // The scheduler loads only in workspaces that actually have scheduled tasks.
  if (context.storageUri) {
    const timer = setTimeout(() => {
      void vscode.workspace.fs.stat(vscode.Uri.joinPath(context.storageUri!, 'schedules.json')).then(() => hub().then((h) => h.getScheduler()), () => undefined);
    }, 5000);
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }
  // Test-only API for the automated UI suite; never registered in normal use.
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(vscode.commands.registerCommand('infraonAssistant._test', () => getCore(context)));
  }
}

/**
 * The Windows installer cannot write VS Code's encrypted secret store, so it leaves the key in
 * %USERPROFILE%\.infraon-assistant\setup.json. The first activation moves it into SecretStorage and deletes the file.
 * A saved key is kept unless the installer was run with -ResetKey (`replace: true`), so a stale file never overwrites it.
 */
async function importInstallerKey(context: vscode.ExtensionContext): Promise<void> {
  try {
    const fs = require('fs') as typeof import('fs');
    const file = (require('path') as typeof import('path')).join((require('os') as typeof import('os')).homedir(), '.infraon-assistant', 'setup.json');
    if (!fs.existsSync(file)) { return; }
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { apiKey?: string; replace?: boolean };
    const had = !!(await context.secrets.get(KEY_SECRET));
    if (data.apiKey?.trim() && (!had || data.replace === true)) {
      await context.secrets.store(KEY_SECRET, data.apiKey.trim());
      void vscode.window.showInformationMessage(had ? 'Infraon Assistant: your API key was replaced by the installer.' : 'Infraon Assistant is ready: your API key was configured by the installer.');
    }
    fs.rmSync(file, { force: true });
  } catch { /* leave the file; "Set API Key" still works */ }
}

/** True while any agent is running or waiting; an update's reload prompt waits for it. False before the hub loads. */
function agentsBusy(): boolean {
  return !!loaded?.hub.manager.snapshot().some((s) => s.agents.some((a) => a.status === 'running' || a.status === 'waiting' || a.status === 'queued'));
}

/** Starts a new session tab with the selected code as its first message. */
async function selectionPrompt(h: Hub, instruction: string): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { return; }
  const file = vscode.workspace.asRelativePath(ed.document.uri, false);
  const sel = ed.selection;
  const s = h.manager.newSession();
  await h.openSession(s.id);
  void h.manager.send(s.id, 'a1', `${instruction}.\nFile: ${file} (lines ${sel.start.line + 1}-${sel.end.line + 1})\n\`\`\`\n${ed.document.getText(sel)}\n\`\`\``).catch(() => undefined);
}

/** Saves every session before VS Code shuts the extension host down; running agents reopen as "interrupted". */
export async function deactivate(): Promise<void> {
  await loaded?.hub.shutdown();
}
