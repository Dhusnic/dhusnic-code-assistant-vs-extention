/**
 * Ghost-text provider: turns VS Code inline-completion requests into CompletionEngine calls (core/completion.ts).
 *
 * Design:
 * - Debounce and cancellation: each request waits `inlineCompletions.debounceMs`, then gives up if VS Code has
 *   cancelled it (the user kept typing); the cancellation token aborts the HTTP request. At most one model request
 *   per surviving request (plus a single chat request the first time a gateway turns out not to support FIM).
 * - Config: the API key from SecretStorage (never prompts), the central policy (base URL, allowed models, routing),
 *   then the `completion` route of modelRouting with `inlineCompletions.model` as the selection. `inlineCompletions.mode`
 *   (auto | fim | chat) is read on every request.
 * - Context: after the debounce, open editor tabs (most recently used first, tracked here from active-editor changes)
 *   and a reader for workspace files (open documents first, then disk, briefly cached) are handed to
 *   core/completionContext.gatherContext, which picks relevant tab windows and imported signatures within its
 *   budget. Collection is time-boxed so a slow disk never delays the suggestion.
 * - Secrets: with `redactSecrets` on, chat messages and the raw FIM prompt are masked with a SecretVault before they
 *   leave, and a suggestion that contains a placeholder is never shown.
 */
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { COMPLETION_MODES, CompletionEngine, CompletionMode, shouldTrigger } from '../core/completion';
import { OpenFile, MAX_TAB_FILES, gatherContext, isSensitivePath } from '../core/completionContext';
import { CentralPolicy, isModelAllowed, loadPolicy } from '../core/centralPolicy';
import { LlmConfig, LlmFn, TextCompleteFn, completeText, streamChat } from '../core/llm';
import { routeModel } from '../core/modelRouting';
import { SecretVault, redactMessages } from '../core/redact';

const MAX_DOC_CHARS = 400_000;
const MAX_CONTEXT_FILE_BYTES = 300_000;
const CONTEXT_TIMEOUT_MS = 250;
const READ_CACHE_MS = 10_000;
const MRU_SIZE = 50;

const posix = (p: string): string => p.replace(/\\/g, '/');
const samePath = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private engine: CompletionEngine;
  private vault = new SecretVault();
  private policy?: Promise<CentralPolicy>;
  /** Document URIs, most recently active first. */
  private mru: string[] = [];
  private readCache = new Map<string, { at: number; text?: string }>();

  constructor(private ctx: vscode.ExtensionContext) {
    const masked: LlmFn = (cfg, messages, tools, onToken, signal) => streamChat(cfg, this.redacting ? redactMessages(messages, this.vault) : messages, tools, onToken, signal);
    const maskedText: TextCompleteFn = (cfg, req, signal) => completeText(cfg, this.redacting ? { ...req, prompt: this.vault.redact(req.prompt).text } : req, signal);
    this.engine = new CompletionEngine(masked, () => this.config(), { completeText: maskedText, mode: () => this.mode });
    const touch = (e?: vscode.TextEditor) => {
      if (!e) { return; }
      const k = e.document.uri.toString();
      this.mru = [k, ...this.mru.filter((u) => u !== k)].slice(0, MRU_SIZE);
    };
    for (const e of vscode.window.visibleTextEditors) { touch(e); }
    touch(vscode.window.activeTextEditor);
    ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(touch));
  }

  private get redacting(): boolean { return vscode.workspace.getConfiguration('infraonAssistant').get<boolean>('redactSecrets', true); }

  private get settings() { return vscode.workspace.getConfiguration('infraonAssistant.inlineCompletions'); }
  get enabled(): boolean { return this.settings.get<boolean>('enabled', true); }
  private get mode(): CompletionMode {
    const m = this.settings.get<string>('mode', 'auto') as CompletionMode;
    return COMPLETION_MODES.includes(m) ? m : 'auto';
  }

  /** Never prompts for a key: if none is stored, completions simply stay quiet. */
  private async config(): Promise<LlmConfig | undefined> {
    const apiKey = await this.ctx.secrets.get('infraonAssistant.apiKey');
    if (!apiKey) { return undefined; }
    const c = vscode.workspace.getConfiguration('infraonAssistant');
    this.policy ??= loadPolicy({ url: c.get<string>('policyUrl', '') || undefined, cacheFile: `${this.ctx.globalStorageUri.fsPath}/policy-cache.json` }).then((r) => r.policy);
    const policy = await this.policy;
    const selected = this.settings.get<string>('model', '') || this.ctx.globalState.get<string>('model') || policy.defaultModel || c.get<string>('model', '');
    const model = routeModel('completion', { ...c.get('modelRouting', {}), ...policy.routing }, { selected });
    if (!isModelAllowed(policy, model)) { return undefined; }
    return {
      baseUrl: policy.baseUrl ?? c.get('baseUrl', ''), apiKey, model, temperature: 0.1, allowSelfSigned: policy.allowSelfSignedTls ?? c.get('allowSelfSignedTls', true),
      maxTokens: this.settings.get<number>('maxTokens', 128),
    };
  }

  /** A workspace file's text: the open document if there is one (unsaved edits included), else the disk, cached briefly. */
  private async readWorkspaceFile(root: string, rel: string): Promise<string | undefined> {
    const abs = path.join(root, rel);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, abs));
    if (open) { return open.getText(); }
    const now = Date.now();
    const hit = this.readCache.get(abs);
    if (hit && now - hit.at < READ_CACHE_MS) { return hit.text; }
    let text: string | undefined;
    try {
      const st = await fs.stat(abs);
      if (st.isFile() && st.size <= MAX_CONTEXT_FILE_BYTES) { text = await fs.readFile(abs, 'utf8'); }
    } catch { text = undefined; }
    if (this.readCache.size > 500) { this.readCache.clear(); }
    this.readCache.set(abs, { at: now, text });
    return text;
  }

  /** Other open text tabs, most recently used first (unknown recency: active tabs, then tab order). */
  private async openFiles(current: vscode.Uri): Promise<OpenFile[]> {
    const seen = new Set<string>([current.toString()]);
    const tabs: { uri: vscode.Uri; active: boolean }[] = [];
    for (const g of vscode.window.tabGroups.all) {
      for (const t of g.tabs) {
        if (!(t.input instanceof vscode.TabInputText)) { continue; }
        const uri = t.input.uri;
        if ((uri.scheme !== 'file' && uri.scheme !== 'untitled') || seen.has(uri.toString())) { continue; }
        seen.add(uri.toString());
        tabs.push({ uri, active: t.isActive });
      }
    }
    const rank = (x: { uri: vscode.Uri; active: boolean }) => { const i = this.mru.indexOf(x.uri.toString()); return i >= 0 ? i : x.active ? MRU_SIZE : MRU_SIZE + 1; };
    tabs.sort((a, b) => rank(a) - rank(b));
    const out: OpenFile[] = [];
    for (const { uri } of tabs.slice(0, MAX_TAB_FILES * 2)) {
      const rel = posix(vscode.workspace.asRelativePath(uri, false));
      if (isSensitivePath(rel)) { continue; }
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      let text: string | undefined;
      if (doc) { text = doc.getText(); } else if (uri.scheme === 'file') {
        try { const st = await fs.stat(uri.fsPath); if (st.size <= MAX_CONTEXT_FILE_BYTES) { text = await fs.readFile(uri.fsPath, 'utf8'); } } catch { /* closed or unreadable */ }
      }
      if (text && text.length <= MAX_DOC_CHARS) { out.push({ path: rel, language: doc?.languageId ?? '', text }); }
    }
    return out;
  }

  async provideInlineCompletionItems(
    doc: vscode.TextDocument, pos: vscode.Position, _ctx: vscode.InlineCompletionContext, token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!this.enabled || (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') || doc.getText().length > MAX_DOC_CHARS) { return undefined; }
    const prefix = doc.getText(new vscode.Range(new vscode.Position(0, 0), pos));
    const lineSuffix = doc.lineAt(pos.line).text.slice(pos.character);
    if (!shouldTrigger(prefix, lineSuffix)) { return undefined; }
    const suffix = doc.getText(new vscode.Range(pos, doc.lineAt(doc.lineCount - 1).range.end));

    await new Promise((r) => setTimeout(r, this.settings.get<number>('debounceMs', 450)));
    if (token.isCancellationRequested) { return undefined; }

    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri) ?? vscode.workspace.workspaceFolders?.[0];
    const root = folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
    const file = root && doc.uri.scheme === 'file' ? posix(path.relative(root, doc.uri.fsPath)) : path.basename(doc.fileName);
    const context = await this.collectContext(doc, file, prefix, suffix, root);
    if (token.isCancellationRequested) { return undefined; }
    const text = await this.engine.complete({ prefix, suffix, language: doc.languageId, file, repo: folder?.name, context }, ac.signal);
    if (!text || token.isCancellationRequested || text.includes('‹secret:')) { return undefined; }
    return [new vscode.InlineCompletionItem(text, new vscode.Range(pos, pos))];
  }

  /** Context from other files, or none if it is not ready within CONTEXT_TIMEOUT_MS. Never throws. */
  private async collectContext(doc: vscode.TextDocument, file: string, prefix: string, suffix: string, root: string | undefined) {
    const work = (async () => gatherContext({
      file, language: doc.languageId, prefix, suffix, text: doc.getText(),
      openFiles: await this.openFiles(doc.uri),
      read: async (rel) => (root && !file.startsWith('..') ? this.readWorkspaceFile(root, rel) : undefined),
    }))().catch(() => []);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<[]>((r) => { timer = setTimeout(() => r([]), CONTEXT_TIMEOUT_MS); });
    try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
  }
}
