import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CentralPolicy } from '../../core/centralPolicy';
import { LlmConfig, LlmFn, streamChat } from '../../core/llm';
import { inferRouting } from '../../core/modelRouting';
import { ocrImage } from '../../core/ocr';
import { WebCache } from '../../core/web/cache';
import { WebLibrary } from '../../core/web/library';
import { createHttpClient } from '../../core/web/net';
import { WebPolicy, WebQuota, resolveWebPolicy } from '../../core/web/policy';
import { SourceRegistry } from '../../core/web/sources';
import { createWebTools } from '../../core/web/tools';
import { HttpFetch, KeyLookup, SearchConfig, SearchProviderId } from '../../core/web/types';
import type { Tool } from '../../core/tool';

/** What the web service needs from the hub. */
export interface WebHost {
  ctx: vscode.ExtensionContext;
  cfg: vscode.WorkspaceConfiguration;
  policy: CentralPolicy;
  output: vscode.OutputChannel;
  models: string[];
  llmFor(sid: string): LlmFn;
  llmConfig(model?: string, prompt?: boolean): Promise<LlmConfig>;
  routeModel(task: 'summary' | 'vision', selected: string): string;
  routing: { vision?: string };
  defaultModel(): string;
}

export const KEY_PROVIDERS: Array<{ id: SearchProviderId | 'github' | 'nvd' | 'semanticscholar'; label: string; detail: string }> = [
  { id: 'brave', label: 'Brave Search API', detail: 'api.search.brave.com — X-Subscription-Token' },
  { id: 'tavily', label: 'Tavily', detail: 'api.tavily.com — research-oriented search' },
  { id: 'bing', label: 'Bing Web Search', detail: 'Azure Cognitive Services key' },
  { id: 'google', label: 'Google Programmable Search', detail: 'API key (also set Web › Search: Google Cx)' },
  { id: 'github', label: 'GitHub token', detail: 'Raises the GitHub API limit from 60 to 5000 requests/hour (read-only scope is enough)' },
  { id: 'semanticscholar', label: 'Semantic Scholar API key', detail: 'Optional: higher paper-search limits' },
  { id: 'nvd', label: 'NVD API key', detail: 'Optional: faster CVE lookups' },
];

const secretKey = (id: string) => `infraonAssistant.webKey.${id}`;
const SEARCH_COUNT_KEY = 'web.searchCount';

/** Internet access for the agents: one HTTP client, cache and library per window; sources, approvals and budgets per session. */
export class WebService implements vscode.Disposable {
  private client?: { sig: string; http: HttpFetch };
  readonly cache: WebCache;
  readonly library: WebLibrary;
  private sessions = new Map<string, { sources: SourceRegistry; approved: Set<string>; quota: WebQuota; tools?: { sig: string; list: Tool[] } }>();
  private keyCache = new Map<string, string | undefined>();

  constructor(private host: WebHost) {
    const dir = path.join(host.ctx.globalStorageUri.fsPath, 'web');
    this.cache = new WebCache(path.join(dir, 'cache'), { maxBytes: this.num('web.cacheMaxMB', 200, 10, 10_000) * 1024 * 1024, defaultTtlMs: this.ttlMinutes() * 60_000 });
    this.library = new WebLibrary(path.join(dir, 'library.jsonl'));
    host.ctx.subscriptions.push(host.ctx.secrets.onDidChange((e) => { if (e.key.startsWith('infraonAssistant.webKey.')) { this.keyCache.clear(); } }));
  }

  private num(key: string, def: number, min: number, max: number): number {
    const v = this.host.cfg.get<number>(key, def);
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def;
  }

  private ttlMinutes(): number { return this.num('web.cacheTtlMinutes', 15, 0, 10_080); }

  policy(): WebPolicy {
    const c = this.host.cfg;
    const inspect = c.inspect<string[]>('web.allowedDomains');
    const userAllowed = inspect?.workspaceFolderValue ?? inspect?.workspaceValue ?? inspect?.globalValue;
    const p = resolveWebPolicy({
      enabled: c.get('web.enabled', true), approval: c.get('web.approval', 'new-domains'),
      allowedDomains: userAllowed === undefined ? undefined : [...(c.get<string[]>('web.allowedDomains') ?? [])],
      askDomains: c.get('web.askDomains', []), blockedDomains: c.get('web.blockedDomains', []), allowPrivateHosts: c.get('web.allowPrivateHosts', []),
      allowDownloads: c.get('web.allowDownloads', true), maxDownloadMB: c.get('web.maxDownloadMB', 50), searchDailyLimit: c.get('web.searchDailyLimit', 200),
      maxRequestsPerSession: c.get('web.maxRequestsPerSession', 400), offline: c.get('web.offline', false), blockedQueryPatterns: c.get('web.blockedQueryPatterns', []),
    }, this.host.policy.web);
    // A self-hosted SearXNG is usually on the intranet: reaching it must not trip the private-address protection.
    const sx = this.searchConfig().searxngUrl;
    if (sx) { try { p.allowPrivateHosts = [...new Set([...p.allowPrivateHosts, new URL(sx).hostname.toLowerCase()])]; } catch { /* invalid URL: search reports it */ } }
    return p;
  }

  searchConfig(): SearchConfig {
    const c = this.host.cfg;
    return { provider: c.get<SearchConfig['provider']>('web.search.provider', 'auto'), searxngUrl: c.get<string>('web.search.searxngUrl', '') || undefined, googleCx: c.get<string>('web.search.googleCx', '') || undefined };
  }

  /** The HTTP client, rebuilt when proxy or TLS settings change. */
  private http(): HttpFetch {
    const c = this.host.cfg;
    const proxy = c.get<string>('web.proxy', '') || process.env.HTTPS_PROXY || process.env.https_proxy || '';
    const noProxy = [...c.get<string[]>('web.noProxy', []), ...(process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',')].map((s) => s.trim()).filter(Boolean);
    const caFile = c.get<string>('web.extraCaFile', '');
    const allowSelfSigned = c.get<boolean>('web.allowSelfSignedTls', false);
    const sig = JSON.stringify([proxy, noProxy, caFile, allowSelfSigned]);
    if (this.client?.sig === sig) { return this.client.http; }
    let extraCaPem: string | undefined;
    if (caFile) {
      try { extraCaPem = require('fs').readFileSync(caFile, 'utf8'); } catch (e: any) { this.host.output.appendLine(`[web] could not read Web: Extra CA File ${caFile}: ${e.message ?? e}`); }
    }
    const version = String(this.host.ctx.extension?.packageJSON?.version ?? '');
    const http = createHttpClient({ userAgent: `Mozilla/5.0 (compatible; InfraonCodeAssistant/${version || '1'}; +research-agent)`, proxy: proxy || undefined, noProxy, allowSelfSigned, extraCaPem, perHostRps: 4 });
    this.client = { sig, http };
    return http;
  }

  readonly keys: KeyLookup = async (id) => {
    if (this.keyCache.has(id)) { return this.keyCache.get(id); }
    const v = (await this.host.ctx.secrets.get(secretKey(id)))?.trim() || undefined;
    this.keyCache.set(id, v);
    return v;
  };

  private session(sid: string) {
    let s = this.sessions.get(sid);
    if (!s) {
      const sources = new SourceRegistry(path.join(this.host.ctx.globalStorageUri.fsPath, 'web', 'sources', `${sid.replace(/[^\w-]/g, '_')}.json`));
      const state = this.host.ctx.globalState;
      const quota = new WebQuota(() => this.policy(), { get: () => state.get(SEARCH_COUNT_KEY, { day: '', count: 0 }), set: (v) => { void state.update(SEARCH_COUNT_KEY, v); } });
      s = { sources, approved: new Set<string>(), quota };
      this.sessions.set(sid, s);
      // A reopened session gets its sources back with the same numbers, so earlier citations stay valid.
      void sources.restore().catch(() => undefined);
    }
    return s;
  }

  sources(sid: string): SourceRegistry { return this.session(sid).sources; }
  approved(sid: string): Set<string> { return this.session(sid).approved; }

  /** The web tools of one session (empty when web access is off). */
  tools(sid: string): Tool[] {
    const p = this.policy();
    if (!p.enabled) { return []; }
    const s = this.session(sid);
    const research = this.host.cfg.get<boolean>('web.researchTools', true);
    const sig = String(research);
    if (s.tools?.sig === sig) { return s.tools.list; }
    const list = createWebTools({
      http: (url, o) => this.http()(url, o), cache: this.cache, library: this.library, sources: s.sources,
      policy: () => this.policy(), search: () => this.searchConfig(), keys: this.keys, quota: s.quota, approvedSites: s.approved,
      cacheTtlMinutes: () => this.ttlMinutes(), researchTools: () => research,
      summarize: (system, user, signal) => this.summarize(sid, system, user, signal),
      ocr: (buf, ext) => ocrImage(this.host.ctx.extensionUri.fsPath, buf, ext),
      // Resolved per call, so a vision model chosen later (routing settings) is used without a reload.
      vision: (dataUrl, q, signal) => this.describeImage(dataUrl, q, signal),
    });
    s.tools = { sig, list };
    return list;
  }

  private async summarize(sid: string, system: string, user: string, signal: AbortSignal): Promise<string> {
    const model = this.host.routeModel('summary', this.host.defaultModel());
    const cfg = { ...(await this.host.llmConfig(model, false)), temperature: 0, maxTokens: 2048 };
    const r = await this.host.llmFor(sid)(cfg, [{ role: 'system', content: system }, { role: 'user', content: user }], [], () => undefined, signal);
    return r.content;
  }

  /** A vision model, when the routing names one or one of the gateway's models is recognisably multimodal. */
  visionModel(): string | undefined {
    return this.host.routing.vision || inferRouting(this.host.models).vision;
  }

  async describeImage(dataUrl: string, question: string, signal: AbortSignal): Promise<string> {
    const model = this.visionModel();
    if (!model) { return ''; }
    const cfg = { ...(await this.host.llmConfig(model, false)), temperature: 0, maxTokens: 1500 };
    // OpenAI-style multimodal content: the image goes to the company gateway only, never to a third party.
    const content = [{ type: 'text', text: question }, { type: 'image_url', image_url: { url: dataUrl } }] as unknown as string;
    const r = await streamChat(cfg, [{ role: 'user', content }], [], () => undefined, signal);
    return r.content;
  }

  /* ------------------------------------------------------------------ commands */

  async setKey(): Promise<void> {
    const pick = await vscode.window.showQuickPick(await Promise.all(KEY_PROVIDERS.map(async (p) => ({ label: p.label, description: (await this.keys(p.id)) ? 'set' : '', detail: p.detail, id: p.id }))), { placeHolder: 'Which key do you want to set? Keys are kept in VS Code\'s secret storage.' });
    if (!pick) { return; }
    const value = await vscode.window.showInputBox({ prompt: `${pick.label} — leave empty to remove the saved key`, password: true, ignoreFocusOut: true });
    if (value === undefined) { return; }
    if (value.trim()) { await this.host.ctx.secrets.store(secretKey(pick.id), value.trim()); } else { await this.host.ctx.secrets.delete(secretKey(pick.id)); }
    this.keyCache.clear();
    void vscode.window.showInformationMessage(value.trim() ? `${pick.label} saved.` : `${pick.label} removed.`);
  }

  async clearCache(): Promise<string> {
    const before = await this.cache.stats();
    await this.cache.clear();
    await this.library.clear();
    return `Cleared the web cache (${before.entries} pages, ${(before.bytes / 1024 / 1024).toFixed(1)} MB) and the offline library.`;
  }

  async status(sid: string): Promise<string> {
    const p = this.policy();
    const sc = this.searchConfig();
    const keys = await Promise.all(KEY_PROVIDERS.map(async (k) => `${k.label}: ${(await this.keys(k.id)) ? 'set' : '—'}`));
    const stats = await this.cache.stats().catch(() => ({ entries: 0, bytes: 0 }));
    const s = this.session(sid);
    const provider = sc.provider === 'auto' ? `auto (${sc.searxngUrl ? 'SearXNG' : (await this.firstKeyed()) ?? 'DuckDuckGo, no key needed — set an API key for reliable results'})` : sc.provider;
    return [
      `Web access: ${p.enabled ? (p.offline ? 'offline mode (cache and library only)' : 'on') : 'off'}${this.host.policy.web ? ' · organization policy applies' : ''}`,
      `Approval: ${p.approval === 'new-domains' ? 'ask for each new site (allowed domains never ask)' : p.approval === 'always' ? 'ask for every request' : 'never ask'} · approved this session: ${[...s.approved].join(', ') || 'none'}`,
      `Search: ${provider}${sc.searxngUrl ? ` · SearXNG ${sc.searxngUrl}` : ''}`,
      `Keys: ${keys.join(' · ')}`,
      `Vision model for images: ${this.visionModel() ?? 'none (images are read with OCR)'}`,
      `Cache: ${stats.entries} pages, ${(stats.bytes / 1024 / 1024).toFixed(1)} MB · offline library: ${await this.library.size()} documents`,
      `This session: ${s.quota.used}/${p.maxRequestsPerSession} requests · ${s.sources.size} sources`,
      `Blocked domains: ${p.blockedDomains.join(', ') || 'none'}${p.onlyDomains ? ` · only allowed: ${p.onlyDomains.join(', ')}` : ''}`,
      '',
      'Use /web key to set a search API key or GitHub token, /web clear-cache to empty the cache, /sources to list what was read.',
    ].join('\n');
  }

  private async firstKeyed(): Promise<string | undefined> {
    for (const id of ['brave', 'tavily', 'bing', 'google'] as const) { if (await this.keys(id)) { return id; } }
    return undefined;
  }

  /** Writes the session's sources as Markdown into the workspace and returns the file. */
  async saveSources(sid: string, root: string): Promise<string> {
    const file = path.join(root, 'research', `sources-${new Date().toISOString().slice(0, 10)}-${sid.slice(-6)}.md`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `# Sources\n\n${this.sources(sid).toMarkdown().split('\n').map((l) => (l.startsWith('[') ? `- ${l}` : l)).join('\n')}\n`);
    return file;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.sources.save()));
    await this.library.flush();
  }
}
