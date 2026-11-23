/**
 * Wires the optional hybrid ranking of search_code (core/hybridSearch.ts) to VS Code.
 *
 * - Model: infraonAssistant.embeddingModel. Empty (the default) keeps search_code BM25-only and sends nothing;
 *   "auto" picks an embedding model from the /models list the hub already fetched; any other value is the model id.
 *   The model must pass the central policy's model allow-list like any chat model.
 * - Endpoint and credentials: the hub's llmConfig() (policy/setting baseUrl, the API key from SecretStorage, the TLS
 *   setting), so embeddings go only to the company gateway. llmConfig is asked never to prompt: no key, no hybrid.
 * - Secrets: chunk text is masked with the same detectors and known secrets as chat when redactSecrets is on
 *   (SafetyCenter.redacting), through a vault reserved for the search index.
 * - Storage: vectors persist in the extension's per-workspace storage (context.storageUri, falling back to
 *   globalStorage), never inside the workspace.
 * Every ranker is disposed with the extension, which stops its background embedding.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { CentralPolicy, isModelAllowed } from '../../core/centralPolicy';
import { Embedder, embed, resolveEmbeddingModel } from '../../core/embeddings';
import { HybridRanker } from '../../core/hybridSearch';
import { LlmConfig } from '../../core/llm';
import type { SafetyCenter } from './guard';

export interface SemanticSearchHost {
  ctx: vscode.ExtensionContext;
  cfg: vscode.WorkspaceConfiguration;
  policy: CentralPolicy;
  models: string[];
  output: vscode.OutputChannel;
  safety: SafetyCenter;
  llmConfig(model?: string, prompt?: boolean): Promise<LlmConfig>;
}

const VAULT_ID = 'search-index';

/** A factory for FsToolsOptions.semantic: one HybridRanker per workspace folder. */
export function semanticRankerFactory(host: SemanticSearchHost): (root: string) => HybridRanker {
  const embedder = async (): Promise<Embedder | undefined> => {
    const model = resolveEmbeddingModel(host.cfg.get<string>('embeddingModel', ''), host.models);
    if (!model || !isModelAllowed(host.policy, model)) { return undefined; }
    let cfg: LlmConfig;
    try { cfg = await host.llmConfig(undefined, false); } catch { return undefined; }
    if (!cfg.baseUrl) { return undefined; }
    return { model, embed: (inputs, signal) => embed(cfg, model, inputs, signal) };
  };
  return (root) => {
    const ranker = new HybridRanker(root, {
      embedder,
      redact: (text) => (host.safety.redacting ? host.safety.vault(VAULT_ID).redact(text).text : text),
      storeDir: path.join((host.ctx.storageUri ?? host.ctx.globalStorageUri).fsPath, 'search-vectors'),
      log: (m) => host.output.appendLine(`[search] ${m}`),
    });
    host.ctx.subscriptions.push({ dispose: () => ranker.dispose() });
    return ranker;
  };
}
