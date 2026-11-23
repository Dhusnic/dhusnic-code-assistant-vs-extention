import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Agent, CheckCommand, DELEGATION_TOOLS } from '../core/agent';
import { detectVerifyCommands } from '../core/verify';
import { parseSelfReviewSetting } from '../core/selfReview';
import { AgentType, BUILTIN_AGENT_TYPES, loadAgentTypes, toolsForType } from '../core/agentTypes';
import { NewSkill, Skill, addSkillFile, copySkill, createSkill, deleteSkill, findSkill, lintSkill, loadSkills, setModelInvocation, updateSkill } from '../core/skills';
import { CheckpointStore } from '../core/checkpoints';
import { CentralPolicy, clampMode, isMcpAllowed, isModelAllowed, loadPolicy } from '../core/centralPolicy';
import { MemoryCache, loadMemoryText } from '../core/memoryFiles';
import { ModelTask, RoutingConfig, routeModel } from '../core/modelRouting';
import { parseTeamSources, syncTeamSkills } from '../core/teamSkills';
import { FsToolsOptions, createFsTools } from '../core/fstools';
import { LlmConfig, LlmFn, listModels, streamChat, streamChatOnce } from '../core/llm';
import { ProbeState, healthView, probeModel, shouldProbe } from '../core/modelHealth';
import { SamplingOverride, resolveSampling, sanitizeOverride } from '../core/sampling';
import { McpManager, ServerStatus, mcpConfigHash, parseMcpConfig } from '../core/mcp';
import { filterFiles } from '../core/mentions';
import { Effort, Mode, isEffort, isMode } from '../core/policy';
import { AgentSettings, AgentSpec, AgentWorktreeRef, SessionManager } from '../core/runtime';
import { FileIndex, findRipgrep, ripgrepCandidates } from '../core/search';
import { DEFAULT_PROMPT_TOKENS, RepoMaps, repoMapTool } from '../core/repoMap';
import { SessionStore2, StoredSessionSummary } from '../core/store';
import { ScopeContext, SessionScope, workspaceKey } from '../core/workspaceScope';
import { UsageTracker } from '../core/usage';
import { DiffContentProvider } from './diffProvider';
import { SessionPanel } from './sessionPanel';
import { createVsCodeTools } from './vscodeTools';
import { createNavTools } from './navTools';
import { repoMapSymbolsFor } from './repoMapSymbols';
import { createEditDiagnostics } from './editDiagnostics';
import { ChangeJournal, isArtifactPath } from '../core/changeJournal';
import { fetchContextWindow } from '../core/modelInfo';
import { IgnoreMatcher, createIgnore } from '../core/glob';
import type { WorkspaceRoot } from '../core/tool';
import type { EditorHost } from './features/editorActions';
import { SafetyCenter } from './features/guard';
import { ServerRegistry } from './features/servers';
import { RemoteService } from './features/remote';
import { createNotifier } from './features/notifications';
import type { Scheduler } from './features/scheduler';
import { createTerminalRunner } from './features/terminalRunner';
import { WebService } from './features/web';
import { TestingService } from './features/testing';
import { semanticRankerFactory } from './features/semanticSearch';

export const PANEL_TYPE = 'infraonAssistant.session';
const OTHER_WORKSPACE = 'That session belongs to another workspace. Open it from the VS Code window of that folder.';

export interface SidebarSink { refresh(): void }

/** Extension-wide owner of sessions, agents, tools, storage and every open session tab. */
export class Hub {
  readonly store: SessionStore2;
  readonly manager: SessionManager;
  readonly usage: UsageTracker;
  readonly index: FileIndex;
  private fsOptions: FsToolsOptions;
  /** Repo maps per folder (system prompt section and the repo_map tool); the primary folder shares the file index. */
  private readonly repoMaps = new RepoMaps((root) => (root === this.root ? this.index : new FileIndex(root)), {
    symbolsFor: repoMapSymbolsFor(() => this.cfg.get<boolean>('repoMap.enabled', true) && this.cfg.get<boolean>('repoMap.useLanguageServer', true)),
  });
  private readonly repoMapTool = repoMapTool(this.repoMaps);
  private fsTools: ReturnType<typeof createFsTools>;
  private mcp: McpManager;
  private readonly editDiagnostics = createEditDiagnostics(() => this.cfg.get<boolean>('diagnosticsAfterEdit', true));
  private mcpLoaded = false;
  private mcpErrors: string[] = [];
  private panels = new Map<string, SessionPanel>();
  private refreshTimer?: NodeJS.Timeout;
  private storedCache?: { at: number; items: Array<StoredSessionSummary & { unassigned?: boolean }> };
  /** Limits every session list and session action to this window's workspace (repo). */
  readonly scope: SessionScope;
  sidebar?: SidebarSink & { post?(m: unknown): void };
  /** True when running inside the automated UI test harness. */
  readonly e2e: boolean;
  readonly output: vscode.OutputChannel;
  readonly webviewErrors: Array<{ where: string; message: string; at: number }> = [];
  private probes = new Map<string, (r: unknown) => void>();
  private probeSeq = 0;
  models: string[] = [];
  agentTypes: AgentType[] = BUILTIN_AGENT_TYPES;
  agentTypeErrors: string[] = [];
  skills: Skill[] = [];
  skillErrors: string[] = [];
  /** The gateway check (model list); llmInfo combines it with the model probe below for the sidebar. */
  health: { ok?: boolean; ms?: number; error?: string; at?: number } = {};
  private modelProbe: ProbeState = { inFlight: false };
  policy: CentralPolicy = {};
  readonly policyReady: Promise<void>;
  readonly safety: SafetyCenter;
  readonly remote: RemoteService;
  readonly web: WebService;
  readonly testing: TestingService;
  private terminal = createTerminalRunner();
  private memoryCache = new MemoryCache();
  private notifier: ReturnType<typeof createNotifier>;
  private scheduler?: Promise<Scheduler>;

  constructor(readonly ctx: vscode.ExtensionContext, readonly diffs: DiffContentProvider) {
    this.e2e = ctx.extensionMode === vscode.ExtensionMode.Test;
    this.output = vscode.window.createOutputChannel('Infraon Assistant');
    ctx.subscriptions.push(this.output);
    this.index = new FileIndex(this.root);
    this.safety = new SafetyCenter(this);
    this.notifier = createNotifier({ openSession: (id) => this.openSession(id), isPanelVisible: (sid) => !!this.panels.get(sid)?.panel.visible });
    ctx.subscriptions.push(this.terminal, this.notifier);
    this.remote = new RemoteService({ ctx, servers: this.servers, addKnownSecret: (v, k) => this.safety.addKnownSecret(v, k), onStatus: () => this.scheduleRefresh() });
    this.safety.remoteResolve = (server) => this.remote.resolveName(server);
    this.safety.workspaceRoots = () => this.workspaceRoots().map((r) => r.path);
    ctx.subscriptions.push(this.remote);
    // Saved server passwords are masked from the first message on, even before the agent connects.
    void this.remote.preloadSecrets();
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getters below need the hub, not the options object
    const hub = this;
    this.web = new WebService({
      ctx, output: this.output,
      get cfg() { return hub.cfg; }, get policy() { return hub.policy; }, get models() { return hub.models; }, get routing() { return hub.routing; },
      llmFor: (sid) => this.llmFor(sid), llmConfig: (m, p) => this.llmConfig(m, p), routeModel: (t, s) => this.routeModel(t, s),
      defaultModel: () => this.defaults().model,
    });
    this.safety.web = { policy: () => this.web.policy(), approved: (sid) => this.web.approved(sid) };
    ctx.subscriptions.push(this.web);
    this.testing = new TestingService({
      ctx, output: this.output, get cfg() { return hub.cfg; },
      addKnownSecret: (v, k) => this.safety.addKnownSecret(v, k),
      vision: () => (this.web.visionModel() ? (dataUrl, q, signal) => this.web.describeImage(dataUrl, q, signal) : undefined),
    });
    this.safety.testing = { currentUrl: (sid) => this.testing.currentUrl(sid) };
    this.policyReady = loadPolicy({ url: this.cfg.get<string>('policyUrl', '') || undefined, cacheFile: path.join(ctx.globalStorageUri.fsPath, 'policy-cache.json') }).then((r) => {
      this.policy = r.policy;
      for (const e of r.errors) { this.output.appendLine(`[policy] ${e}`); }
      void this.loadSkills();
      this.scheduleRefresh();
    });
    this.fsOptions = { index: this.index, semantic: semanticRankerFactory(this) };
    this.fsTools = createFsTools(this.fsOptions);
    const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
    watcher.onDidCreate(() => this.index.invalidate());
    watcher.onDidDelete(() => this.index.invalidate());
    this.watchChanges();
    this.mcp = new McpManager(this.root);
    ctx.subscriptions.push(watcher, { dispose: () => this.mcp.stopAll() }, vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('infraonAssistant.searchEngine') || e.affectsConfiguration('infraonAssistant.ripgrepPath')) { void this.initSearch(); }
      if (e.affectsConfiguration('infraonAssistant.mcpServers') && this.mcpLoaded) { void this.loadMcp(); }
      if (e.affectsConfiguration('infraonAssistant')) { this.scheduleRefresh(); }
    }));
    void this.initSearch();
    void this.loadAgentTypes();
    void this.loadSkills();
    const skillWatcher = vscode.workspace.createFileSystemWatcher('**/.{claude,infraon}/{skills/**/SKILL.md,commands/*.md}');
    for (const ev of [skillWatcher.onDidCreate, skillWatcher.onDidChange, skillWatcher.onDidDelete]) { ev(() => void this.loadSkills()); }
    ctx.subscriptions.push(skillWatcher);
    const agentWatcher = vscode.workspace.createFileSystemWatcher('**/.{claude,infraon}/agents/*.md');
    for (const ev of [agentWatcher.onDidCreate, agentWatcher.onDidChange, agentWatcher.onDidDelete]) { ev(() => void this.loadAgentTypes()); }
    ctx.subscriptions.push(agentWatcher);

    this.store = new SessionStore2(path.join(ctx.globalStorageUri.fsPath, 'sessions'));
    this.scope = new SessionScope(this.store, () => this.scopeContext(), path.join(ctx.globalStorageUri.fsPath, 'checkpoints'));
    ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { this.storedCache = undefined; this.scheduleRefresh(); }));
    this.usage = new UsageTracker(ctx.globalState.get('usage', {}), (d) => { void ctx.globalState.update('usage', d); });
    this.manager = new SessionManager({
      store: this.store,
      createAgent: (sid, aid, spec) => this.createAgent(sid, aid, spec),
      agentTypes: () => this.agentTypes,
      defaults: () => this.defaults(),
      onEvent: (sid, aid, ev) => this.panels.get(sid)?.onAgentEvent(aid, ev),
      onChange: () => this.scheduleRefresh(),
      maxConcurrent: () => this.cfg.get<number>('maxConcurrentAgents', 4),
      describeTool: (n, a) => this.describeTool(n, a),
      prepareWorktree: (sid, aid, type) => this.prepareWorktree(sid, aid, type),
      subagentModel: (selected) => this.routeModel('subagent', selected),
      workspace: () => this.scopeContext().key,
    });
  }

  /** The primary workspace folder (the first); other folders of a multi-root workspace are reached through workspaceRoots. */
  get root(): string { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(); }

  /** This window's workspace identity: the saved .code-workspace file, else the first folder (= root), else "no folder". */
  scopeContext(): ScopeContext {
    const id = (u: vscode.Uri) => (u.scheme === 'file' ? u.fsPath : u.toString());
    const file = vscode.workspace.workspaceFile;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => id(f.uri));
    return {
      key: workspaceKey({ workspaceFile: file && file.scheme !== 'untitled' ? id(file) : undefined, folders }),
      roots: folders, ignore: [this.ctx.globalStorageUri.fsPath],
    };
  }
  get cfg(): vscode.WorkspaceConfiguration { return vscode.workspace.getConfiguration('infraonAssistant'); }
  get media(): vscode.Uri { return vscode.Uri.joinPath(this.ctx.extensionUri, 'media'); }

  /* ------------------------------------------------------------ agents */

  /** Agent types: built-ins, then ~/.claude|.infraon/agents, then the workspace's (later wins), like Claude Code. */
  async loadAgentTypes(): Promise<void> {
    const home = os.homedir();
    const r = await loadAgentTypes([
      { dir: path.join(home, '.claude', 'agents'), source: 'user' }, { dir: path.join(home, '.infraon', 'agents'), source: 'user' },
      { dir: path.join(this.root, '.claude', 'agents'), source: 'project' }, { dir: path.join(this.root, '.infraon', 'agents'), source: 'project' },
    ]);
    this.agentTypes = r.types;
    this.agentTypeErrors = r.errors;
    this.scheduleRefresh();
  }

  /** Skills: personal (~/.claude, ~/.infraon) first, then the workspace's — project skills win on name clashes. */
  async loadSkills(): Promise<void> {
    const home = os.homedir();
    const r = await loadSkills([
      { base: path.join(home, '.claude'), source: 'user' }, { base: path.join(home, '.infraon'), source: 'user' },
      ...this.teamSkillBases.map((base) => ({ base, source: 'user' as const })),
      { base: path.join(this.root, '.claude'), source: 'project' }, { base: path.join(this.root, '.infraon'), source: 'project' },
    ]);
    void this.syncTeamSkills();
    this.skills = r.skills;
    this.skillErrors = r.errors;
    this.scheduleRefresh();
    for (const fn of this.skillListeners) { fn(); }
  }

  readonly skillListeners = new Set<() => void>();
  private teamSkillBases: string[] = [];
  private teamSync?: Promise<void>;

  /** Refreshes shared skill libraries in the background; never delays the skills already on disk. */
  private syncTeamSkills(): Promise<void> {
    const { sources, errors } = parseTeamSources([...this.cfg.get<unknown[]>('teamSkills', []), ...(this.policy.teamSkills ?? [])]);
    for (const e of errors) { this.output.appendLine(`[team skills] ${e}`); }
    if (!sources.length) { return Promise.resolve(); }
    this.teamSync ??= syncTeamSkills(sources, path.join(this.ctx.globalStorageUri.fsPath, 'team-skills')).then((r) => {
      for (const e of r.errors) { this.output.appendLine(`[team skills] ${e}`); }
      const bases = r.skillBases.map((b) => b.base);
      const changed = bases.join('|') !== this.teamSkillBases.join('|') || r.updated.length > 0;
      this.teamSkillBases = bases;
      if (changed) { void this.loadSkills(); }
    });
    return this.teamSync;
  }

  skillBase(scope: 'project' | 'personal'): string {
    return scope === 'personal' ? path.join(os.homedir(), '.claude') : path.join(this.root, '.claude');
  }

  async createSkill(scope: 'project' | 'personal', input: NewSkill): Promise<string> {
    const file = await createSkill(this.skillBase(scope), input);
    await this.loadSkills();
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    return file;
  }

  async toggleSkill(name: string, enabled: boolean): Promise<void> {
    const s = findSkill(this.skills, name);
    if (!s) { throw new Error(`Skill "${name}" not found.`); }
    await setModelInvocation(s, enabled);
    await this.loadSkills();
  }

  async removeSkill(name: string): Promise<boolean> {
    const s = findSkill(this.skills, name);
    if (!s) { return false; }
    const what = s.kind === 'skill' ? `the folder ${path.basename(s.dir)} with its ${s.files.length + 1} file(s)` : path.basename(s.file);
    const ok = await vscode.window.showWarningMessage(`Delete the ${s.source === 'user' ? 'personal' : 'project'} skill "/${s.name}"? This removes ${what}.`, { modal: true }, 'Delete');
    if (ok !== 'Delete') { return false; }
    await deleteSkill(s);
    await this.loadSkills();
    return true;
  }

  async openSkill(name: string, reveal = false): Promise<void> {
    const s = findSkill(this.skills, name);
    if (!s) { return; }
    if (reveal) { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(s.file)); return; }
    await vscode.window.showTextDocument(vscode.Uri.file(s.file), { preview: false });
  }

  private skill(name: string): Skill {
    const s = findSkill(this.skills, name);
    if (!s) { throw new Error(`Skill "${name}" not found (it may have been renamed or deleted).`); }
    return s;
  }

  /** Everything the edit form needs. */
  skillDetail(name: string) {
    const s = this.skill(name);
    return {
      name: s.name, description: s.description, instructions: s.body, argumentHint: s.argumentHint ?? '', allowedTools: s.allowedTools ?? [],
      modelInvocable: s.modelInvocable, userInvocable: s.userInvocable, source: s.source, kind: s.kind, files: s.files,
      path: path.relative(s.source === 'project' ? this.root : os.homedir(), s.file).split(path.sep).join('/'),
    };
  }

  lintDraft(draft: Partial<NewSkill>, originalName?: string) { return lintSkill(draft, this.skills, originalName); }

  async editSkill(originalName: string, input: NewSkill): Promise<void> {
    const file = await updateSkill(this.skill(originalName), input);
    await this.loadSkills();
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true, preserveFocus: true });
  }

  async duplicateSkill(name: string, scope: 'project' | 'personal', newName?: string): Promise<string> {
    const file = await copySkill(this.skill(name), this.skillBase(scope), newName || undefined);
    await this.loadSkills();
    return file;
  }

  async addFileToSkill(name: string, rel: string, content: string): Promise<void> {
    const abs = await addSkillFile(this.skill(name), rel, content);
    await this.loadSkills();
    await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true, preserveFocus: true });
  }

  skillViews() {
    return this.skills.map((s) => ({
      issues: s.kind === 'skill' ? lintSkill({ name: s.name, description: s.description, instructions: s.body, argumentHint: s.argumentHint, allowedTools: s.allowedTools, modelInvocable: s.modelInvocable, userInvocable: s.userInvocable }, [], s.name).filter((x) => x.level !== 'tip').length : 0,
      name: s.name, description: s.description, source: s.source, kind: s.kind, argumentHint: s.argumentHint,
      allowedTools: s.allowedTools ?? [], modelInvocable: s.modelInvocable, userInvocable: s.userInvocable,
      files: s.files.length, path: path.relative(s.source === 'project' ? this.root : os.homedir(), s.file).split(path.sep).join('/'),
    }));
  }

  /** Every tool an agent of session `sid` can use (web tools keep their sources and approvals per session). */
  /** browserKey: whose test browser the testing tools drive (each sub-agent gets its own, so parallel testers do not collide). */
  private allTools(sid = '_shared', browserKey = sid) { return [...this.fsTools, ...this.repoMapTools(), ...createVsCodeTools(), ...createNavTools(), ...(this.cfg.get<boolean>('visibleTerminal', true) ? this.terminal.tools() : []), ...this.remote.tools(), ...this.web.tools(sid), ...this.testing.tools(browserKey), ...this.mcp.tools()]; }

  checkpointsFor(sid: string, aid: string): CheckpointStore { return new CheckpointStore(path.join(this.ctx.globalStorageUri.fsPath, 'checkpoints', sid, aid)); }

  /** The LLM client for a session: usage is counted and secrets are masked before anything leaves this machine. */
  llmFor(sid: string): LlmFn { return this.safety.wrapLlm(sid, this.usage.wrap(streamChat, sid)); }

  get routing(): RoutingConfig { return { ...this.cfg.get<RoutingConfig>('modelRouting', {}), ...this.policy.routing }; }
  routeModel(task: ModelTask, selected: string): string { return routeModel(task, this.routing, { selected, available: this.models }); }

  private async prepareWorktree(sid: string, aid: string, type: AgentType): Promise<AgentWorktreeRef | undefined> {
    if (type.readOnly || !this.cfg.get<boolean>('agentWorktrees', false)) { return undefined; }
    const git = await import('../core/git');
    if (!await git.isGitRepo(this.root)) { return undefined; }
    try {
      return await git.createAgentWorktree(this.root, path.join(this.ctx.globalStorageUri.fsPath, 'worktrees'), sid, aid, { timeoutMs: 120000 });
    } catch (e: any) {
      this.output.appendLine(`[worktree] ${e.message ?? e}; the agent will work in the main workspace.`);
      return undefined;
    }
  }

  /** What the editor's quick fixes and inline edit need. Masked secrets are put back before the edit is shown. */
  editorHost(): EditorHost {
    const sid = 'editor';
    const llm = this.llmFor(sid);
    return {
      root: this.root, llmConfig: () => this.llmConfig(),
      llm: async (cfg, messages, tools, onToken, signal, onToolProgress, onEvent) => { const r = await llm(cfg, messages, tools, onToken, signal, onToolProgress, onEvent); return { ...r, content: this.safety.vault(sid).restore(r.content) }; },
      startSession: async (prompt) => { const s = this.manager.newSession(); await this.openSession(s.id); void this.manager.send(s.id, s.main().id, prompt).catch(() => undefined); },
    };
  }

  getScheduler(): Promise<Scheduler> {
    this.scheduler ??= import('./features/scheduler').then(async ({ Scheduler }) => {
      const dir = (this.ctx.storageUri ?? this.ctx.globalStorageUri).fsPath;
      await fs.mkdir(dir, { recursive: true });
      const s = new Scheduler(this, dir);
      this.ctx.subscriptions.push(s);
      await s.start();
      return s;
    });
    return this.scheduler;
  }

  /** Runs one scheduled task in its own session tab and resolves when the agent finishes. */
  async runScheduled(name: string, prompt: string, mode: Mode): Promise<void> {
    const s = this.manager.newSession({ mode: clampMode(this.policy, mode) });
    this.manager.rename(s.id, `Scheduled: ${name}`);
    await this.openSession(s.id);
    await this.manager.send(s.id, s.main().id, prompt);
    if (s.main().status === 'error') { throw new Error(s.main().error ?? 'The scheduled task failed.'); }
  }

  /** Commands that check the project after the agent changes code: the user's setting, else INFRAON.md, else detected. */
  private async projectChecks(root: string): Promise<CheckCommand[]> {
    if (!this.cfg.get<boolean>('autoVerify', true)) { return []; }
    const custom = (this.cfg.get<unknown[]>('verifyCommands', []) ?? []).filter((c): c is string => typeof c === 'string' && !!c.trim());
    if (custom.length) { return custom.map((command) => ({ name: 'verify', command: command.trim(), timeoutSeconds: 600 })); }
    return detectVerifyCommands(root);
  }

  /** Every file change in the workspace, from any source, so the agents' checks also cover commands and sub-agents. */
  private readonly journal = new ChangeJournal();
  private readonly gitignores = new Map<string, IgnoreMatcher | undefined>();

  private watchChanges(): void {
    const loadIgnore = async (root: string) => {
      try { this.gitignores.set(root, createIgnore((await fs.readFile(path.join(root, '.gitignore'), 'utf8')).split('\n'))); } catch { this.gitignores.set(root, undefined); }
    };
    for (const f of vscode.workspace.workspaceFolders ?? []) { void loadIgnore(f.uri.fsPath); }
    const w = vscode.workspace.createFileSystemWatcher('**/*');
    const on = (uri: vscode.Uri) => {
      if (uri.scheme !== 'file') { return; }
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) { return; }
      const root = folder.uri.fsPath;
      const rel = path.relative(root, uri.fsPath);
      if (rel === '.gitignore') { void loadIgnore(root); }
      if (!rel || rel.startsWith('..') || isArtifactPath(rel, this.gitignores.get(root))) { return; }
      this.journal.record(uri.fsPath);
    };
    w.onDidChange(on); w.onDidCreate(on); w.onDidDelete(on);
    this.ctx.subscriptions.push(w);
  }

  /** Context window per model, as the gateway reports it (undefined: not reported). */
  private readonly contextWindows = new Map<string, number | undefined>();
  private lastModel?: string;

  /** The context window to plan for: the user's setting when set explicitly, else what the gateway reports, else 256k. */
  contextWindow(): number {
    const set = this.cfg.inspect<number>('contextWindow');
    const explicit = set?.workspaceFolderValue ?? set?.workspaceValue ?? set?.globalValue;
    if (typeof explicit === 'number' && explicit > 0) { return explicit; }
    const reported = this.lastModel ? this.contextWindows.get(this.lastModel) : undefined;
    return reported ?? this.cfg.get<number>('contextWindow', 262144);
  }

  private repoMapTools() { return this.cfg.get<boolean>('repoMap.enabled', true) ? [this.repoMapTool] : []; }

  /** The repo map for the system prompt; '' when turned off or not built within the time box (it is ready next turn). */
  private repoMapSection(root: string): Promise<string> | string {
    if (!vscode.workspace.workspaceFolders?.length || !this.cfg.get<boolean>('repoMap.enabled', true)) { return ''; }
    return this.repoMaps.promptSection(root, { budgetTokens: this.cfg.get<number>('repoMap.maxTokens', DEFAULT_PROMPT_TOKENS) });
  }

  /** All workspace folders (multi-root workspaces have several). */
  workspaceRoots(): WorkspaceRoot[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath }));
  }

  /** Main agents can delegate (agent / send_message); sub-agents get their type's tools and prompt and cannot. */
  private createAgent(sid: string, aid: string, spec: AgentSpec = { role: 'main' }): Agent {
    const checkpoints = this.checkpointsFor(sid, aid);
    const sub = spec.role === 'sub' ? spec.type : undefined;
    const root = (spec.role === 'sub' && spec.root) || this.root;
    return new Agent({
      subagent: !!sub,
      extraSystem: sub?.prompt,
      skills: () => this.skills,
      agentTypes: () => this.agentTypes,
      spawn: sub ? undefined : (req) => this.manager.spawn(sid, aid, req),
      sendToAgent: sub ? undefined : (to, message) => this.manager.message(sid, to, message),
      root,
      guard: this.safety.guardFor(sid, aid, root, !!sub),
      llm: this.llmFor(sid),
      getConfig: (o) => this.llmConfig(o.model),
      tools: () => (sub ? toolsForType(this.allTools(sid, `${sid}#${aid}`), sub, DELEGATION_TOOLS) : this.allTools(sid)),
      memory: () => this.loadMemory(),
      checks: sub ? undefined : () => this.projectChecks(root),
      repoMap: () => this.repoMapSection(root),
      // An agent in its own worktree works outside the workspace: workspace changes and folders are not its own.
      fileChanges: root === this.root ? this.journal : undefined,
      roots: root === this.root ? () => this.workspaceRoots() : undefined,
      diagnostics: this.editDiagnostics,
      limits: () => ({ maxIterations: this.cfg.get<number>('maxIterations', 1200), maxTokens: this.cfg.get<number>('maxOutputTokens', 0) }),
      snapshot: (turn, abs) => checkpoints.snapshot(turn, abs),
      restore: (turn) => checkpoints.restore(turn),
      selfReview: sub ? undefined : () => parseSelfReviewSetting(this.cfg.get<string>('selfReview', 'high')),
      original: (turn, abs) => checkpoints.originalIn(turn, abs),
      contextLimit: () => this.contextWindow(),
      compactRatio: () => this.cfg.get<number>('autoCompactThreshold', 0.75),
      activeFile: () => {
        const ed = vscode.window.activeTextEditor;
        return ed && ed.document.uri.scheme === 'file' ? path.relative(this.root, ed.document.uri.fsPath) : undefined;
      },
    });
  }

  defaults(): AgentSettings {
    const m = this.ctx.globalState.get('mode'), e = this.ctx.globalState.get('effort');
    return {
      mode: clampMode(this.policy, isMode(m) ? m : 'ask'), effort: isEffort(e) ? e : 'medium',
      model: this.allowedModel(this.ctx.globalState.get<string>('model') || this.policy.defaultModel || this.cfg.get<string>('model', '')),
    };
  }

  /** The model to use: the requested one, or the policy's choice when the policy does not allow it. */
  private allowedModel(model: string): string {
    if (isModelAllowed(this.policy, model)) { return model; }
    return this.policy.defaultModel ?? this.policy.allowedModels?.find((m) => !m.includes('*')) ?? model;
  }

  setDefaults(p: Partial<{ mode: Mode; effort: Effort; model: string }>): void {
    for (const [k, v] of Object.entries(p)) { if (v !== undefined) { void this.ctx.globalState.update(k, v); } }
  }

  describeTool(name: string, args: any): string {
    if (name === 'agent') { return `Agent (${String(args?.subagent_type || 'general-purpose')}): ${String(args?.description ?? 'task')}${args?.run_in_background ? ' · background' : ''}`; }
    if (name === 'todo_write') { return 'Updated the task list'; }
    if (name === 'ask_user_question') { const n = Array.isArray(args?.questions) ? args.questions.length : 0; return `Asked you ${n} question${n === 1 ? '' : 's'}`; }
    if (name === 'send_message') { return `Message → ${String(args?.to ?? '?')}`; }
    if (name === 'task') { return `Sub-agent: ${String(args?.description ?? 'task')}`; }
    if (name === 'exit_plan_mode') { return 'Plan proposed'; }
    const t = this.allTools().find((x) => x.spec.function.name === name);
    try { return t ? t.describe(args) : name; } catch { return name; }
  }

  async llmConfig(model?: string, prompt = true): Promise<LlmConfig> {
    await this.policyReady;
    let apiKey = await this.ctx.secrets.get('infraonAssistant.apiKey');
    if (!apiKey && prompt) {
      apiKey = await vscode.window.showInputBox({ prompt: 'Company LLM API key', password: true, ignoreFocusOut: true });
      if (apiKey) { await this.ctx.secrets.store('infraonAssistant.apiKey', apiKey); }
    }
    if (!apiKey) { throw new Error('No API key set. Run "Infraon Assistant: Set API Key".'); }
    const chosen = this.allowedModel(model || this.defaults().model);
    if (!isModelAllowed(this.policy, chosen)) { throw new Error(`Your organization's policy does not allow the model "${chosen}".`); }
    const idle = this.cfg.get<number>('llmIdleTimeoutSeconds', 180);
    const { temperature, sampling } = resolveSampling(chosen, this.samplingOverride());
    const cfg: LlmConfig = {
      baseUrl: this.policy.baseUrl ?? this.cfg.get('baseUrl', ''), model: chosen, apiKey, temperature, sampling,
      allowSelfSigned: this.policy.allowSelfSignedTls ?? this.cfg.get('allowSelfSignedTls', true),
      idleTimeoutMs: idle > 0 ? idle * 1000 : undefined,
    };
    // Ask the gateway once per model how big its context window really is (vLLM reports max_model_len).
    if (!this.contextWindows.has(chosen)) {
      this.contextWindows.set(chosen, await fetchContextWindow(cfg, chosen));
      const w = this.contextWindows.get(chosen);
      this.output.appendLine(`[llm] ${chosen}: context window ${w ? `${w} tokens (reported by the gateway)` : 'not reported; using the Context Window setting'}`);
    }
    this.lastModel = chosen;
    return cfg;
  }

  /**
   * The user's explicit sampling values: the Sampling object, over a Temperature the user actually set (its default
   * must not hide the model's recommended temperature). Everything else comes from the model's profile.
   */
  private samplingOverride(): SamplingOverride {
    const t = this.cfg.inspect<number>('temperature');
    const temperature = t?.workspaceFolderValue ?? t?.workspaceValue ?? t?.globalValue;
    return { ...sanitizeOverride({ temperature }), ...sanitizeOverride(this.cfg.get('sampling')) };
  }

  /** The project memory file in use (CLAUDE.md, INFRAON.md or AGENTS.md), shown in the context popup. */
  memoryFile?: { name: string; chars: number };

  private async loadMemory(): Promise<string> {
    const ed = vscode.window.activeTextEditor;
    const rel = ed?.document.uri.scheme === 'file' ? path.relative(this.root, ed.document.uri.fsPath).split(path.sep).join('/') : undefined;
    const { text, files } = await loadMemoryText(this.root, os.homedir(), { activeFile: rel && !rel.startsWith('..') ? rel : undefined, cache: this.memoryCache });
    const used = files.filter((f) => f.exists && !f.omitted);
    this.memoryFile = used.length ? { name: used.map((f) => f.rel).join(', '), chars: text.length } : undefined;
    return text;
  }

  /** Token cost of each MCP server's tool definitions. */
  mcpBreakdown(): Array<{ server: string; tools: number; tokens: number }> {
    const by = new Map<string, { tools: number; chars: number }>();
    for (const t of this.mcp.tools()) {
      const server = t.spec.function.name.split('__')[1] ?? 'mcp';
      const e = by.get(server) ?? { tools: 0, chars: 0 };
      e.tools++; e.chars += JSON.stringify(t.spec).length;
      by.set(server, e);
    }
    return [...by.entries()].map(([server, e]) => ({ server, tools: e.tools, tokens: Math.ceil(e.chars / 3.5) }));
  }

  /* ------------------------------------------------------------ tabs */

  /** Opens a new session tab; `prefill` is placed in its input box (e.g. a handoff summary). */
  async newSession(prefill?: string, skillsView?: 'list' | 'new' | 'ai'): Promise<void> {
    const s = this.manager.newSession();
    this.openPanel(s.id, prefill, skillsView);
  }

  /** Opens the skills manager in the most recent session tab (or a new one). */
  async openSkillsManager(view: 'list' | 'new' | 'ai' = 'list'): Promise<void> {
    const panel = [...this.panels.values()].pop();
    if (panel) { panel.panel.reveal(); panel.showSkills(view); return; }
    await this.newSession(undefined, view);
  }

  async openSession(sid: string): Promise<void> {
    if (this.panels.has(sid)) { this.panels.get(sid)!.panel.reveal(); return; }
    if (!(await this.inScope(sid))) { void vscode.window.showErrorMessage(OTHER_WORKSPACE); return; }
    const s = await this.manager.open(sid);
    if (!s) { void vscode.window.showErrorMessage('That session could not be loaded. Try "Check storage" in the Infraon sidebar.'); return; }
    this.openPanel(sid);
  }

  private openPanel(sid: string, prefill?: string, skillsView?: 'list' | 'new' | 'ai'): void {
    const panel = vscode.window.createWebviewPanel(PANEL_TYPE, this.titleOf(sid), { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.media],
    });
    this.panels.set(sid, new SessionPanel(this, panel, sid, prefill, skillsView));
    this.scheduleRefresh();
  }

  /** Called by the panel serializer after VS Code restarts. */
  /**
   * Whether this window may open or change the session: it is live here, or stored for this workspace. A legacy session
   * nobody could attribute is claimed by this workspace on the way through, so it stops showing up in other windows.
   */
  async inScope(sid: string): Promise<boolean> {
    if (this.manager.sessions.has(sid)) { return true; }
    const o = await this.scope.ownership(sid).catch(() => 'other' as const);
    if (o === 'unassigned') { await this.scope.claim(sid); this.storedCache = undefined; }
    return o !== 'other';
  }

  async restorePanel(panel: vscode.WebviewPanel, sid: unknown): Promise<void> {
    const s = typeof sid === 'string' && await this.inScope(sid) ? await this.manager.open(sid).catch(() => undefined) : undefined;
    if (!s || this.panels.has(s.id)) { panel.dispose(); return; }
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.media] };
    this.panels.set(s.id, new SessionPanel(this, panel, s.id));
    this.scheduleRefresh();
  }

  panelClosed(sid: string): void {
    this.panels.delete(sid);
    // Agents keep running in the background; the session is unloaded only when idle.
    void this.manager.close(sid).catch(() => undefined);
    this.storedCache = undefined;
    this.scheduleRefresh();
  }

  titleOf(sid: string): string {
    return this.manager.sessions.get(sid)?.title || 'New session';
  }

  isOpen(sid: string): boolean { return this.panels.has(sid); }

  /* ------------------------------------------------------------ session manager data */

  scheduleRefresh(): void {
    if (this.refreshTimer) { return; }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.sidebar?.refresh();
      for (const p of this.panels.values()) { p.refreshAgents(); }
      this.notifier.update(this.manager.snapshot());
    }, 200);
  }

  /** Stored sessions of this window's workspace only (plus legacy ones nobody can attribute, flagged `unassigned`). */
  async storedSessions(maxAgeMs = 3000): Promise<Array<StoredSessionSummary & { unassigned?: boolean }>> {
    if (!this.storedCache || Date.now() - this.storedCache.at > maxAgeMs) {
      const all = await this.store.list().catch(() => []);
      const live = all.filter((s) => this.manager.sessions.has(s.id));
      const scoped = await this.scope.filter(all.filter((s) => !this.manager.sessions.has(s.id))).catch(() => []);
      this.storedCache = { at: Date.now(), items: [...live, ...scoped].sort((a, b) => b.updatedAt - a.updatedAt) };
    }
    return this.storedCache.items;
  }

  async sessionsView() {
    const live = new Map(this.manager.snapshot().map((s) => [s.id, s]));
    const stored = await this.storedSessions();
    const rows = stored.map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, agentCount: s.agents, turns: s.turns, interrupted: s.interrupted, live: live.get(s.id), unassigned: !!s.unassigned && !live.has(s.id) }));
    for (const s of live.values()) {
      if (!stored.some((x) => x.id === s.id)) { rows.push({ id: s.id, title: s.title, updatedAt: s.updatedAt, agentCount: s.agents.length, turns: 0, interrupted: false, live: s, unassigned: false }); }
    }
    return rows.map((r) => {
      const ls = r.live;
      const agents = ls?.agents ?? [];
      const status = agents.some((a) => a.status === 'waiting') ? 'waiting'
        : agents.some((a) => a.status === 'running' || a.status === 'queued') ? 'running'
          : agents.some((a) => a.status === 'error') ? 'error'
            : (agents.some((a) => a.status === 'interrupted') || (!ls && r.interrupted)) ? 'interrupted' : 'idle';
      return {
        id: r.id, title: ls?.title || r.title || 'New session', updatedAt: Math.max(r.updatedAt, ls?.updatedAt ?? 0),
        agentCount: ls ? agents.length : r.agentCount, turns: ls ? agents.reduce((n, a) => n + a.turns, 0) : r.turns,
        status, open: this.panels.has(r.id), agents, tokens: this.usage.session(r.id), unassigned: r.unassigned,
      };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  llmInfo() {
    let host = this.cfg.get<string>('baseUrl', '');
    try { host = new URL(host).host; } catch { /* keep raw */ }
    const running = this.manager.snapshot().flatMap((s) => s.agents).filter((a) => a.status === 'running' || a.status === 'waiting').length;
    return {
      endpoint: host, model: this.defaults().model, models: this.models, health: healthView(this.health, this.modelProbe, this.defaults().model, this.probeMinutes() > 0),
      contextWindow: this.cfg.get<number>('contextWindow', 131072), running, queued: this.manager.snapshot().flatMap((s) => s.agents).filter((a) => a.status === 'queued').length,
      maxConcurrent: this.cfg.get<number>('maxConcurrentAgents', 4), usage: this.usage.summary(),
      mcp: this.mcp.status().map((s) => ({ name: s.name, status: s.status, tools: s.tools })),
    };
  }

  /**
   * Checks the gateway (model list), then probes the selected model when one is due (see modelHealth.ts) without
   * waiting for it. `force` is the sidebar's refresh button: probe now unless a probe is already running.
   */
  async checkHealth(force = false): Promise<void> {
    const t0 = Date.now();
    try {
      this.models = (await listModels(await this.llmConfig(undefined, false))).filter((m) => isModelAllowed(this.policy, m));
      this.health = { ok: true, ms: Date.now() - t0, at: Date.now() };
      const d = this.defaults();
      if (this.models.length && !this.models.includes(d.model)) { this.setDefaults({ model: this.models[0] }); }
    } catch (e: any) {
      this.health = { ok: false, ms: Date.now() - t0, error: e.message ?? String(e), at: Date.now() };
    }
    this.scheduleRefresh();
    if (this.health.ok) { void this.checkModel(force); }
  }

  /** infraonAssistant.modelProbeMinutes; 0 = off. Off in the UI tests, which count the fake gateway's chat requests. */
  private probeMinutes(): number {
    const m = this.cfg.get<number>('modelProbeMinutes', 5);
    return this.e2e || !(m > 0) ? 0 : m;
  }

  private async checkModel(force: boolean): Promise<void> {
    const model = this.defaults().model;
    if (!shouldProbe(this.modelProbe, model, Date.now(), { force, intervalMs: this.probeMinutes() * 60_000 })) { return; }
    this.modelProbe.inFlight = true;
    this.scheduleRefresh();
    try {
      // The bare streaming call: no retries, no usage count, no sampling extras (probeModel strips them).
      this.modelProbe.last = await probeModel(streamChatOnce, await this.llmConfig(model, false));
      if (!this.modelProbe.last.ok) { this.output.appendLine(`[health] ${model} did not answer the probe: ${this.modelProbe.last.error}`); }
    } catch (e: any) {
      this.output.appendLine(`[health] model probe skipped: ${e.message ?? e}`);
    } finally {
      this.modelProbe.inFlight = false;
      this.scheduleRefresh();
    }
  }

  async deleteSession(sid: string): Promise<void> {
    if (!(await this.inScope(sid))) { void vscode.window.showErrorMessage(OTHER_WORKSPACE); return; }
    const title =(await this.sessionsView()).find((s) => s.id === sid)?.title ?? 'this session';
    const ok = await vscode.window.showWarningMessage(`Delete "${title}"? Its agents are stopped and its history is removed.`, { modal: true }, 'Delete');
    if (ok !== 'Delete') { return; }
    this.panels.get(sid)?.panel.dispose();
    await this.manager.deleteSession(sid);
    await fs.rm(path.join(this.ctx.globalStorageUri.fsPath, 'checkpoints', sid), { recursive: true, force: true });
    this.safety.forget(sid);
    await this.testing.closeSession(sid);
    this.storedCache = undefined;
    this.scheduleRefresh();
  }

  async renameSession(sid: string): Promise<void> {
    if (!(await this.inScope(sid))) { void vscode.window.showErrorMessage(OTHER_WORKSPACE); return; }
    const s =this.manager.sessions.get(sid) ?? await this.manager.open(sid);
    if (!s) { return; }
    const title = await vscode.window.showInputBox({ prompt: 'Session name', value: s.title });
    if (title === undefined) { return; }
    this.manager.rename(sid, title);
    this.panels.get(sid)?.refreshAgents();
    this.storedCache = undefined;
    if (!this.panels.has(sid)) { await this.manager.close(sid).catch(() => undefined); }
    this.scheduleRefresh();
  }

  async verifyStorage(): Promise<{ selfTest: { ok: boolean; ms: number; detail: string }; items: Awaited<ReturnType<SessionStore2['verify']>> }> {
    await this.manager.shutdown();
    const selfTest = await this.store.selfTest();
    const all = await this.store.verify(true);
    // Every session is checked and repaired, but only this workspace's are reported by title.
    const items: typeof all = [];
    for (const it of all) { if ((await this.scope.ownership(it.id).catch(() => 'other')) !== 'other') { items.push(it); } }
    this.storedCache = undefined;
    this.scheduleRefresh();
    return { selfTest, items };
  }

  /* ------------------------------------------------------------ search, files, MCP */

  private async initSearch(): Promise<void> {
    this.fsOptions.prefer = this.cfg.get<'auto' | 'ripgrep' | 'builtin'>('searchEngine', 'auto');
    this.fsOptions.rgPath = await findRipgrep(ripgrepCandidates(vscode.env.appRoot), this.cfg.get<string>('ripgrepPath', '') || undefined);
  }

  async files(query: string): Promise<string[]> {
    const open = new Set(
      vscode.window.tabGroups.all.flatMap((g) => g.tabs)
        .map((t) => (t.input as { uri?: vscode.Uri } | undefined)?.uri?.fsPath)
        .filter((f): f is string => !!f).map((f) => path.relative(this.root, f).split(path.sep).join('/')),
    );
    return filterFiles(await this.index.files(), query, 12, open);
  }

  async ensureMcp(): Promise<void> { if (!this.mcpLoaded) { await this.loadMcp(); } }

  async loadMcp(): Promise<void> {
    this.mcpLoaded = true;
    await this.policyReady;
    const fromSettings = parseMcpConfig(this.cfg.get('mcpServers'));
    const errors = [...fromSettings.errors];
    const servers = { ...fromSettings.servers };
    let fromFile: ReturnType<typeof parseMcpConfig> = { servers: {}, errors: [] };
    try {
      fromFile = parseMcpConfig(JSON.parse(await fs.readFile(path.join(this.root, '.mcp.json'), 'utf8')));
    } catch (e: any) { if (e.code !== 'ENOENT') { errors.push(`.mcp.json: ${e.message}`); } }
    errors.push(...fromFile.errors);
    const approved = new Set(this.ctx.workspaceState.get<string[]>('approvedMcp', []));
    for (const [name, c] of Object.entries(fromFile.servers)) {
      const key = `${name}:${mcpConfigHash(name, c)}`;
      if (!c.disabled && !approved.has(key)) {
        const pick = await vscode.window.showWarningMessage(
          `The workspace file .mcp.json wants to start the MCP server "${name}":\n${c.command} ${(c.args ?? []).join(' ')}\nOnly allow this if you trust the repository.`,
          { modal: true }, 'Allow');
        if (pick !== 'Allow') { errors.push(`${name}: not approved, skipped`); continue; }
        approved.add(key);
        await this.ctx.workspaceState.update('approvedMcp', [...approved]);
      }
      servers[name] = c;
    }
    for (const name of Object.keys(servers)) {
      if (!isMcpAllowed(this.policy, name)) { delete servers[name]; errors.push(`${name}: blocked by your organization's policy`); }
    }
    this.mcpErrors = errors;
    await this.mcp.reload(servers);
    this.scheduleRefresh();
  }

  mcpReport(): string {
    const status: ServerStatus[] = this.mcp.status();
    if (!status.length && !this.mcpErrors.length) {
      return 'No MCP servers configured. Add them in settings (infraonAssistant.mcpServers) or a .mcp.json file in the workspace.';
    }
    const lines = status.map((s) => (s.status === 'connected'
      ? `✓ ${s.name} — ${s.tools} tool${s.tools === 1 ? '' : 's'}`
      : s.status === 'disabled' ? `○ ${s.name} (disabled)` : `✕ ${s.name} — ${s.error}`));
    return [...lines, ...this.mcpErrors.map((e) => `! ${e}`)].join('\n');
  }

  async shutdown(): Promise<void> { await this.manager.shutdown(); await this.safety.flush(); }

  /* ------------------------------------------------------------ diagnostics & UI test harness */

  logWebviewError(where: string, m: { message?: string; source?: string; line?: number; col?: number }): void {
    const message = `${m.message ?? 'script error'}${m.source ? ` (${m.source.split('/').pop()}:${m.line ?? '?'}:${m.col ?? '?'})` : ''}`;
    this.webviewErrors.push({ where, message, at: Date.now() });
    if (this.webviewErrors.length > 200) { this.webviewErrors.shift(); }
    this.output.appendLine(`[${new Date().toISOString()}] UI error in ${where}: ${message}`);
  }

  resolveProbe(id: string, result: unknown): void {
    const r = this.probes.get(id);
    if (r) { this.probes.delete(id); r(result); }
  }

  /** Sends a probe to the sidebar or a session tab and waits for the answer (UI tests only). */
  probe(target: 'sidebar' | string, msg: Record<string, unknown>, timeoutMs = 5000): Promise<any> {
    const id = `p${++this.probeSeq}`;
    const sink = target === 'sidebar' ? this.sidebar : this.panels.get(target);
    if (!sink?.post) { return Promise.reject(new Error(`no webview for ${target}`)); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.probes.delete(id); reject(new Error(`probe timed out: ${JSON.stringify(msg)}`)); }, timeoutMs);
      this.probes.set(id, (r) => { clearTimeout(timer); resolve(r); });
      sink.post!({ type: '__probe', id, ...msg });
    });
  }

  openPanelIds(): string[] { return [...this.panels.keys()]; }

  /* ------------------------------------------------------------ servers (sidebar) */

  private serverRegistry?: ServerRegistry;
  get servers(): ServerRegistry {
    this.serverRegistry ??= new ServerRegistry(this.ctx, () => this.loadMcp(), (name) => this.mcp.status().find((s) => s.name === name)?.status);
    return this.serverRegistry;
  }

  async deleteSecret(key: string): Promise<void> {
    await this.ctx.secrets.delete(key);
  }
}
