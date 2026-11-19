import * as vscode from 'vscode';
import * as path from 'path';
import { CompletionEngine, shouldTrigger } from '../core/completion';
import { CentralPolicy, isModelAllowed, loadPolicy } from '../core/centralPolicy';
import { LlmConfig, LlmFn, streamChat } from '../core/llm';
import { routeModel } from '../core/modelRouting';
import { SecretVault, redactMessages } from '../core/redact';

const MAX_DOC_CHARS = 400_000;

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private engine: CompletionEngine;
  private vault = new SecretVault();
  private policy?: Promise<CentralPolicy>;

  constructor(private ctx: vscode.ExtensionContext) {
    const masked: LlmFn = (cfg, messages, tools, onToken, signal) => streamChat(cfg, this.redacting ? redactMessages(messages, this.vault) : messages, tools, onToken, signal);
    this.engine = new CompletionEngine(masked, () => this.config());
  }

  private get redacting(): boolean { return vscode.workspace.getConfiguration('infraonAssistant').get<boolean>('redactSecrets', true); }

  private get settings() { return vscode.workspace.getConfiguration('infraonAssistant.inlineCompletions'); }
  get enabled(): boolean { return this.settings.get<boolean>('enabled', true); }

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
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const file = root ? path.relative(root, doc.uri.fsPath) : path.basename(doc.fileName);
    const text = await this.engine.complete({ prefix, suffix, language: doc.languageId, file }, ac.signal);
    if (!text || token.isCancellationRequested || text.includes('\u2039secret:')) { return undefined; }
    return [new vscode.InlineCompletionItem(text, new vscode.Range(pos, pos))];
  }
}
