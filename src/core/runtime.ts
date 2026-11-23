import { randomBytes } from 'crypto';
import { Agent, AgentUi, SpawnRequest, SpawnResult } from './agent';
import { AgentType, BUILTIN_AGENT_TYPES, DEFAULT_AGENT_TYPE, findAgentType } from './agentTypes';
import { ChatMessage, ToolCallProgress } from './llm';
import { diffText } from './diff';
import { Effort, Mode } from './policy';
import { historyToUi, titleFrom } from './sessions';
import { AgentRecord, Bookmark, SCHEMA_VERSION, SessionMeta, SessionStore2, StoredStatus, repairTurnStarts, summaryOf } from './store';
import { ApprovalPreview } from './tool';
import { Answers, UserQuestion, sanitizeAnswers, summarizeAnswers } from './questions';
import { TodoItem, attachAction, finishAction, mergeTodos } from './todos';

/**
 * Runs many sessions, each with many agents, concurrently. Every agent keeps a transcript log of UI events so
 * the chat view can switch between agents at any time (even mid-run) and replay exactly what happened.
 *
 * The activity line says what an agent is doing. Until the first byte of a model reply arrives it reads "Waiting for
 * the model…", and after WAIT_NOTICE_MS of silence it counts the seconds, so a stuck gateway is not mistaken for a
 * model that is thinking. Tokens and tool-call progress then take over the line.
 */

export type UiEvent = { type: string; [k: string]: any };
export interface AgentSettings { mode: Mode; effort: Effort; model: string }

/** Event types that form the visible transcript; everything else (start/end/usage…) is transient. */
const LOGGED = new Set(['userMsg', 'token', 'assistantText', 'toolStart', 'toolEnd', 'toolProgress', 'approve', 'planApprove', 'question', 'approvalDone', 'info', 'agentLink', 'todos']);
const BUSY: StoredStatus[] = ['queued', 'running', 'waiting'];

export interface SubtaskView { id: string; title: string; last: string; done: boolean; ok?: boolean }
export interface AgentView {
  id: string; sessionId: string; name: string; status: StoredStatus; activity: string;
  startedAt?: number; updatedAt: number; turns: number; mode: Mode; effort: Effort; model: string;
  contextUsed: number; contextLimit: number; error?: string; subtasks: SubtaskView[];
  role: 'main' | 'sub'; parentId?: string; type?: string; description?: string; background?: boolean;
  outcome?: 'completed' | 'failed' | 'cancelled'; resultPreview?: string;
  /** The user stopped this agent's latest run. */
  cancelled?: boolean;
  /** Tokens this agent has consumed across all its runs (prompt + completion). */
  tokens: number;
  /** Time spent in finished runs; add now - startedAt while one is running. */
  runMs: number;
}
export type AgentRole = 'main' | 'sub';
/** What kind of Agent the host should build: the main conversation, or a sub-agent of a given type. */
export type AgentSpec = { role: 'main' } | { role: 'sub'; type: AgentType; root?: string };
/** A git worktree an editing sub-agent works in, so parallel agents cannot overwrite each other. */
export interface AgentWorktreeRef { path: string; branch: string; base: string }
export interface InboxItem { id: string; description: string; outcome?: string; text: string }
/** A user message waiting for a busy agent's next step. */
export interface QueuedMessage { id: string; prompt: string; display: string; files: string[]; thumbs: string[] }
export interface SessionView { id: string; title: string; createdAt: number; updatedAt: number; agents: AgentView[] }

export class AgentRuntime {
  status: StoredStatus = 'idle';
  activity = 'Idle';
  startedAt?: number;
  error?: string;
  log: UiEvent[] = [];
  pending = new Map<string, { kind: 'approve' | 'plan' | 'question'; resolve: (v: any) => void; questions?: UserQuestion[] }>();
  previews = new Map<string, ApprovalPreview>();
  subtasks = new Map<string, SubtaskView>();
  usage = { used: 0, limit: 0 };
  run?: Promise<void>;
  cancelQueued?: () => void;
  saveTimer?: NodeJS.Timeout;
  /** Counts the seconds while a model call has not sent its first byte (see SessionManager.waitForModel). */
  waitTimer?: NodeJS.Timeout;
  role: AgentRole = 'main';
  parentId?: string;
  type?: string;
  description?: string;
  background?: boolean;
  parentToolId?: string;
  outcome?: 'completed' | 'failed' | 'cancelled';
  result?: string;
  cancelled = false;
  /** Notifications from finished background sub-agents, delivered as the next turn. */
  inbox: InboxItem[] = [];
  /** Messages the user sent while this agent was working; handed to the model at its next step. */
  userQueue: QueuedMessage[] = [];
  bookmarks: Bookmark[] = [];
  todos: TodoItem[] = [];
  worktree?: AgentWorktreeRef;
  /** Tokens consumed across all runs (prompt + completion), for monitoring. */
  tokens = 0;
  /** Wall time of finished runs. */
  runMs = 0;

  constructor(
    readonly sessionId: string, readonly id: string, public name: string,
    public settings: AgentSettings, readonly agent: Agent,
    readonly createdAt = Date.now(), public updatedAt = Date.now(),
  ) {
    agent.pendingInput = () => this.userQueue.splice(0).map((q) => ({ text: q.prompt, display: q.display, files: q.files, thumbs: q.thumbs }));
    // A running turn follows the mode the user selects now, not a copy taken when the turn started.
    agent.liveMode = () => this.settings.mode;
  }

  get busy(): boolean { return BUSY.includes(this.status); }

  record(): AgentRecord {
    const { history, turnStarts } = this.agent.exportState();
    return {
      v: SCHEMA_VERSION, id: this.id, sessionId: this.sessionId, name: this.name, createdAt: this.createdAt, updatedAt: this.updatedAt,
      status: this.status, error: this.error, ...this.settings, history: [...history], turnStarts: [...turnStarts],
      role: this.role, parentId: this.parentId, type: this.type, description: this.description, background: this.background,
      outcome: this.outcome, result: this.result, parentToolId: this.parentToolId, bookmarks: [...this.bookmarks],
      todos: JSON.parse(JSON.stringify(this.todos)), worktree: this.worktree,
      stats: { tokens: this.tokens, runMs: this.runMs },
    };
  }

  view(): AgentView {
    return {
      id: this.id, sessionId: this.sessionId, name: this.name, status: this.status, activity: this.activity,
      startedAt: this.startedAt, updatedAt: this.updatedAt, turns: this.agent.turnCount, ...this.settings,
      contextUsed: this.usage.used, contextLimit: this.usage.limit, error: this.error, subtasks: [...this.subtasks.values()],
      role: this.role, parentId: this.parentId, type: this.type, description: this.description, background: this.background,
      outcome: this.outcome, resultPreview: this.result?.slice(0, 240), cancelled: this.cancelled,
      tokens: this.tokens, runMs: this.runMs,
    };
  }
}

export class SessionRuntime {
  agents = new Map<string, AgentRuntime>();
  persisted = false;
  /** Agent ids handed out while their worktree is being prepared. */
  private reserved = new Set<string>();
  /** The workspace (repo) this session belongs to; saved in its meta so other windows do not list it. */
  workspace?: string;
  constructor(readonly id: string, public title: string, readonly createdAt = Date.now(), public updatedAt = Date.now()) {}

  reserveAgentId(): string { const id = this.nextAgentId(); this.reserved.add(id); return id; }
  releaseAgentId(id: string): void { this.reserved.delete(id); }

  meta(): SessionMeta {
    return {
      v: SCHEMA_VERSION, id: this.id, title: this.title, createdAt: this.createdAt, updatedAt: this.updatedAt, agents: [...this.agents.values()].map((a) => summaryOf(a.record())),
      ...(this.workspace !== undefined ? { workspace: this.workspace } : {}),
    };
  }
  /** The session's main conversation (Claude-style: exactly one per session). */
  main(): AgentRuntime {
    const all = [...this.agents.values()];
    return all.find((a) => a.role === 'main') ?? all[0];
  }

  nextAgentId(): string {
    let n = 1;
    while (this.agents.has(`a${n}`) || this.reserved.has(`a${n}`)) { n++; }
    return `a${n}`;
  }
}

export interface ManagerDeps {
  store: SessionStore2;
  createAgent(sessionId: string, agentId: string, spec?: AgentSpec): Agent;
  /** Sub-agent types (built-ins + custom definitions). */
  agentTypes?(): AgentType[];
  defaults(): AgentSettings;
  /** Live UI event for one agent (the host forwards it to the view if that agent is on screen). */
  onEvent?(sessionId: string, agentId: string, ev: UiEvent): void;
  /** Something in the activity snapshot changed. */
  onChange?(): void;
  maxConcurrent?(): number;
  describeTool?(name: string, args: any): string;
  /** Gives an editing sub-agent its own worktree; undefined means it works in the main workspace. */
  prepareWorktree?(sessionId: string, agentId: string, type: AgentType): Promise<AgentWorktreeRef | undefined>;
  /** The model sub-agents use when their type does not name one. */
  subagentModel?(selected: string): string;
  newSessionId?(): string;
  /** The current window's workspace key (see workspaceKey); recorded on every session this manager creates or opens. */
  workspace?(): string;
  saveThrottleMs?: number;
  /** Tests: silence before the wait shows its seconds (default WAIT_NOTICE_MS), and how often it updates (WAIT_TICK_MS). */
  waitNoticeMs?: number;
  waitTickMs?: number;
}

export const WAITING_LABEL = 'Waiting for the model…';
/** After this long without a first byte, the activity line counts the seconds. */
export const WAIT_NOTICE_MS = 30_000;
export const WAIT_TICK_MS = 5_000;

/** Status-line text while a model call has not answered yet, e.g. "Waiting for the model… no response for 45 s". */
export function waitingLabel(waitedMs: number, noticeMs = WAIT_NOTICE_MS): string {
  return waitedMs < noticeMs ? WAITING_LABEL : `${WAITING_LABEL} no response for ${Math.round(waitedMs / 1000)} s`;
}

/** Status-line text while the model is still writing a tool call, e.g. "Writing index.html… 14.2 KB". */
export function toolWritingLabel(p: ToolCallProgress): string {
  const file = p.path ? p.path.split(/[\\/]/).filter(Boolean).pop() : undefined;
  const size = p.chars < 1024 ? `${p.chars} B` : `${(p.chars / 1024).toFixed(1)} KB`;
  const verb = p.name === 'write_file' ? 'Writing' : p.name === 'edit_file' || p.name === 'multi_edit' ? 'Editing' : '';
  return verb && file ? `${verb} ${file}… ${size}` : `Preparing ${p.name}… ${size}`;
}

export function newSessionId(): string {
  return `${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
}

export class SessionManager {
  readonly sessions = new Map<string, SessionRuntime>();
  private runningCount = 0;
  private queue: Array<{ rt: AgentRuntime; go: () => void }> = [];
  private queuedSeq = 0;

  constructor(private deps: ManagerDeps) {}

  /* ------------------------------------------------------------ sessions & agents */

  newSession(settings?: Partial<AgentSettings>): SessionRuntime {
    const s = new SessionRuntime((this.deps.newSessionId ?? newSessionId)(), '');
    s.workspace = this.deps.workspace?.();
    this.sessions.set(s.id, s);
    this.addAgentTo(s, settings);
    this.changed();
    return s;
  }

  /**
   * Adds an agent to a session. With `forkFrom`, the new agent starts with a copy of that agent's conversation
   * (and transcript); from then on the two are independent. Agents never share context otherwise.
   */
  addAgent(sid: string, settings?: Partial<AgentSettings>, name?: string, forkFrom?: string): AgentRuntime {
    const s = this.session(sid);
    const src = forkFrom ? this.agent(sid, forkFrom) : undefined;
    if (src?.busy) { throw new Error(`Wait for ${src.name} to finish (or stop it) before forking it.`); }
    const rt = this.addAgentTo(s, settings ?? (src ? { ...src.settings } : undefined), name ?? (src ? `${src.name} (fork)` : undefined));
    if (src) {
      rt.agent.loadState(JSON.parse(JSON.stringify(src.agent.exportState())));
      rt.log = JSON.parse(JSON.stringify(src.log));
      rt.log.push({ type: 'info', text: `Forked from ${src.name}: this agent starts with a copy of its conversation and continues independently. Restoring a message from before the fork rewinds the conversation only, not files.` });
      const u = rt.agent.contextUsage();
      rt.usage = { used: u.used, limit: u.limit };
    }
    void this.persist(rt);
    this.changed();
    return rt;
  }

  private addAgentTo(s: SessionRuntime, settings?: Partial<AgentSettings>, name?: string): AgentRuntime {
    const aid = s.nextAgentId();
    const isMain = s.agents.size === 0;
    const type = isMain ? undefined : (findAgentType(this.types(), DEFAULT_AGENT_TYPE) ?? BUILTIN_AGENT_TYPES[0]);
    const rt = new AgentRuntime(s.id, aid, name ?? (isMain ? 'Main' : `Agent ${aid.slice(1)}`), { ...this.deps.defaults(), ...settings }, this.deps.createAgent(s.id, aid, type ? { role: 'sub', type } : { role: 'main' }));
    if (!isMain) { Object.assign(rt, { role: 'sub', parentId: s.main().id, type: type!.name, description: rt.name, background: true }); }
    s.agents.set(aid, rt);
    return rt;
  }

  session(sid: string): SessionRuntime {
    const s = this.sessions.get(sid);
    if (!s) { throw new Error(`Session ${sid} is not open.`); }
    return s;
  }

  agent(sid: string, aid: string): AgentRuntime {
    const rt = this.session(sid).agents.get(aid);
    if (!rt) { throw new Error(`Agent ${aid} not found in session ${sid}.`); }
    return rt;
  }

  /** Opens a stored session (or returns it if already open). */
  async open(sid: string): Promise<SessionRuntime | undefined> {
    const live = this.sessions.get(sid);
    if (live) { return live; }
    const loaded = await this.deps.store.loadSession(sid);
    if (!loaded) { return undefined; }
    const s = new SessionRuntime(sid, loaded.meta.title, loaded.meta.createdAt, loaded.meta.updatedAt);
    // A legacy session (no workspace recorded) is claimed by the window that opens it; a recorded one keeps its own.
    s.workspace = loaded.meta.workspace ?? this.deps.workspace?.();
    s.persisted = true;
    const types = this.types();
    loaded.agents.forEach((rec, i) => { if (!rec.role) { rec.role = i === 0 ? 'main' : 'sub'; } });
    const mainId = (loaded.agents.find((r) => r.role === 'main') ?? loaded.agents[0])?.id;
    for (const rec of loaded.agents) {
      const subType = rec.role === 'sub' ? (findAgentType(types, rec.type) ?? findAgentType(types, DEFAULT_AGENT_TYPE) ?? BUILTIN_AGENT_TYPES[0]) : undefined;
      const agent = this.deps.createAgent(sid, rec.id, subType ? { role: 'sub', type: subType, root: rec.worktree?.path } : { role: 'main' });
      agent.loadState({ history: rec.history, turnStarts: rec.turnStarts });
      const rt = new AgentRuntime(sid, rec.id, rec.name, { mode: rec.mode as Mode, effort: rec.effort as Effort, model: rec.model }, agent, rec.createdAt, rec.updatedAt);
      rt.status = rec.status === 'interrupted' || rec.status === 'error' ? rec.status : 'idle';
      rt.role = rec.role ?? 'main';
      rt.worktree = rec.worktree;
      rt.tokens = finiteOr0(rec.stats?.tokens);
      rt.runMs = finiteOr0(rec.stats?.runMs);
      rt.todos = Array.isArray(rec.todos) ? rec.todos.map((t) => ({ ...t, actions: Array.isArray(t.actions) ? t.actions : [] })) : [];
      rt.bookmarks = Array.isArray(rec.bookmarks) ? rec.bookmarks.filter((b) => b && Number.isInteger(b.turn) && typeof b.hash === 'string') : [];
      if (rt.role === 'sub') {
        Object.assign(rt, { parentId: rec.parentId ?? mainId, type: subType?.name, description: rec.description ?? rec.name, background: rec.background,
          parentToolId: rec.parentToolId, outcome: rec.outcome ?? (rec.status === 'interrupted' ? 'cancelled' : undefined), result: rec.result });
      }
      rt.error = rec.error;
      rt.activity = rt.status === 'interrupted' ? 'Interrupted (VS Code closed while it was working)' : rt.status === 'error' ? `Error: ${rec.error ?? 'unknown'}` : 'Idle';
      rt.log = transcriptFromHistory(agent, this.deps.describeTool);
      if (rt.todos.length) { rt.log.push({ type: 'todos', items: JSON.parse(JSON.stringify(rt.todos)) }); }
      if (rt.status === 'interrupted') { rt.log.push({ type: 'info', text: 'This agent was interrupted because VS Code closed while it was working. Send a message to continue.' }); }
      const u = agent.contextUsage();
      rt.usage = { used: u.used, limit: u.limit };
      s.agents.set(rec.id, rt);
    }
    if (loaded.warnings.length && s.agents.size) {
      [...s.agents.values()][0].log.push({ type: 'info', text: `Storage: ${loaded.warnings.join('; ')}`, error: true });
    }
    if (!s.agents.size) { this.addAgentTo(s); }
    s.main().role = 'main';
    this.sessions.set(sid, s);
    this.changed();
    return s;
  }

  /** Unloads a session from memory (it stays on disk). Refuses while any of its agents are working. */
  async close(sid: string): Promise<void> {
    const s = this.sessions.get(sid);
    if (!s) { return; }
    if ([...s.agents.values()].some((a) => a.busy)) { throw new Error('Stop the running agents in this session first.'); }
    await this.flushSession(s);
    this.sessions.delete(sid);
    this.changed();
  }

  async removeAgent(sid: string, aid: string): Promise<void> {
    const s = this.session(sid);
    const rt = this.agent(sid, aid);
    if (rt.busy) { throw new Error('Stop this agent before removing it.'); }
    if (rt.role === 'main' || s.agents.size === 1) { throw new Error('The main conversation cannot be removed (a session needs at least one agent).'); }
    clearTimeout(rt.saveTimer);
    s.agents.delete(aid);
    if (s.persisted) { await this.deps.store.deleteAgent(sid, aid); await this.deps.store.saveMeta(s.meta()); }
    this.changed();
  }

  async deleteSession(sid: string): Promise<void> {
    const s = this.sessions.get(sid);
    if (s) {
      for (const rt of s.agents.values()) { this.stop(sid, rt.id); clearTimeout(rt.saveTimer); }
      await Promise.all([...s.agents.values()].map((rt) => rt.run?.catch(() => undefined)));
      this.sessions.delete(sid);
    }
    await this.deps.store.deleteSession(sid);
    this.changed();
  }

  rename(sid: string, title: string, aid?: string): void {
    const s = this.session(sid);
    if (aid) { this.agent(sid, aid).name = title.trim() || this.agent(sid, aid).name; } else { s.title = title.trim(); }
    s.updatedAt = Date.now();
    if (s.persisted || aid) { void this.persistMeta(s); }
    this.changed();
  }

  setSettings(sid: string, aid: string, patch: Partial<AgentSettings>): void {
    const rt = this.agent(sid, aid);
    const before = rt.settings.mode;
    rt.settings = { ...rt.settings, ...patch };
    if (rt.settings.mode !== before) { this.modeSwitched(rt); }
    this.changed();
  }

  /**
   * A mode change takes effect at once: the running turn's next tool calls use it, approvals already waiting are judged
   * again under it, and the main conversation's sub-agents follow it the same way.
   */
  private modeSwitched(rt: AgentRuntime): void {
    rt.agent.reconsiderApprovals();
    if (rt.role !== 'main') { return; }
    for (const sub of this.sessions.get(rt.sessionId)?.agents.values() ?? []) {
      if (sub.role !== 'sub' || sub.parentId !== rt.id || sub.settings.mode === rt.settings.mode) { continue; }
      sub.settings = { ...sub.settings, mode: rt.settings.mode };
      this.emit(sub, { type: 'agentSettings', settings: { ...sub.settings } });
      sub.agent.reconsiderApprovals();
    }
  }

  /* ------------------------------------------------------------ running */

  /** Starts a turn. Resolves when the turn ends (completed, failed, or cancelled). */
  send(sid: string, aid: string, prompt: string, opts: { display?: string; files?: string[]; thumbs?: string[]; noQueue?: boolean; notification?: Array<{ id: string; description: string; outcome?: string }> } = {}): Promise<void> {
    const s = this.session(sid);
    const rt = this.agent(sid, aid);
    if (rt.busy) { return Promise.reject(new Error(`${rt.name} is already working. Wait for it, stop it, or start another agent.`)); }
    const display = opts.display ?? prompt;
    if (!s.title) { s.title = titleFrom(display); }
    const turn = rt.agent.turnCount;
    rt.error = undefined;
    rt.cancelled = false;
    // Marked busy synchronously so a second send in the same tick (e.g. a double click) is refused.
    this.setStatus(rt, 'queued', 'Starting…');
    this.emit(rt, { type: 'userMsg', text: display, turn, files: opts.files ?? [], ...(opts.thumbs?.length ? { thumbs: opts.thumbs } : {}), ...(opts.notification ? { notification: opts.notification } : {}) });
    rt.run = this.runTurn(rt, prompt, display, turn, !opts.noQueue);
    return rt.run;
  }

  /**
   * Sends a message, or queues it if the agent is busy (Claude-style): a queued message is handed to the
   * model with its next call, in the same turn. Returns 'queued' or the started turn.
   */
  sendOrQueue(sid: string, aid: string, prompt: string, opts: { display?: string; files?: string[]; thumbs?: string[] } = {}): { queued: true; id: string } | { queued: false; run: Promise<void> } {
    const rt = this.agent(sid, aid);
    if (!rt.busy) { return { queued: false, run: this.send(sid, aid, prompt, opts) }; }
    const item: QueuedMessage = { id: `q${++this.queuedSeq}`, prompt, display: opts.display ?? prompt, files: opts.files ?? [], thumbs: opts.thumbs ?? [] };
    rt.userQueue.push(item);
    this.emitQueue(rt);
    this.changed();
    return { queued: true, id: item.id };
  }

  /** Takes a queued message back (to edit or drop it) before the agent sees it. */
  unqueue(sid: string, aid: string, id: string): QueuedMessage | undefined {
    const rt = this.agent(sid, aid);
    const i = rt.userQueue.findIndex((q) => q.id === id);
    if (i < 0) { return undefined; }
    const [item] = rt.userQueue.splice(i, 1);
    this.emitQueue(rt);
    return item;
  }

  queued(sid: string, aid: string): Array<{ id: string; display: string }> {
    return this.agent(sid, aid).userQueue.map((q) => ({ id: q.id, display: q.display }));
  }

  private emitQueue(rt: AgentRuntime): void { this.emit(rt, { type: 'queue', items: rt.userQueue.map((q) => ({ id: q.id, display: q.display })) }); }

  private async runTurn(rt: AgentRuntime, prompt: string, display: string, turn: number, queued = true): Promise<void> {
    try {
      if (queued) { await this.acquire(rt); }
    } catch {
      truncateLog(rt, turn);
      this.emit(rt, { type: 'rewound', turn, files: 0, note: 'Cancelled before it started.' });
      this.setStatus(rt, 'idle', 'Idle');
      this.emit(rt, { type: 'end' });
      return;
    }
    rt.startedAt = Date.now();
    this.setStatus(rt, 'running', 'Thinking…');
    this.emit(rt, { type: 'start' });
    try {
      await rt.agent.send(prompt, { ...rt.settings }, this.uiFor(rt), display);
      this.setStatus(rt, 'idle', 'Idle');
    } catch (e: any) {
      rt.error = e.message ?? String(e);
      this.emit(rt, { type: 'info', text: `Error: ${rt.error}`, error: true });
      this.setStatus(rt, 'error', `Error: ${rt.error}`);
    } finally {
      this.stopWaiting(rt);
      if (queued) { this.release(); }
      if (rt.role === 'sub') { this.settleSub(rt); }
      for (const [id, p] of rt.pending) { p.resolve(p.kind === 'approve' ? false : null); this.emit(rt, { type: 'approvalDone', id, label: 'cancelled' }); }
      rt.pending.clear();
      for (const t of rt.subtasks.values()) { if (!t.done) { t.done = true; t.ok = false; } }
      if (rt.startedAt) { rt.runMs += Date.now() - rt.startedAt; }
      rt.startedAt = undefined;
      this.emit(rt, { type: 'end' });
      await this.persist(rt);
      this.changed();
      if (rt.role === 'main') { setTimeout(() => { if (!this.drainQueue(rt)) { this.drainInbox(rt); } }, 0); }
    }
  }

  /** A message queued after the agent's last model call becomes the next turn. */
  private drainQueue(rt: AgentRuntime): boolean {
    if (rt.busy || !rt.userQueue.length || !this.sessions.get(rt.sessionId)?.agents.has(rt.id)) { return false; }
    const items = rt.userQueue.splice(0);
    this.emitQueue(rt);
    const prompt = items.length > 1 ? items.map((q) => q.prompt).join('\n\n') : items[0].prompt;
    void this.send(rt.sessionId, rt.id, prompt, { display: items.map((q) => q.display).join('\n\n'), files: items.flatMap((q) => q.files), thumbs: items.flatMap((q) => q.thumbs) }).catch(() => undefined);
    return true;
  }

  /** Stops one agent (whether queued, running, or waiting for approval). */
  stop(sid: string, aid: string): void {
    const rt = this.agent(sid, aid);
    rt.cancelled = true;
    // Like Claude Code: stopping hands queued messages back to the composer instead of sending them.
    if (rt.userQueue.length) {
      const back = rt.userQueue.splice(0).map((q) => q.display);
      this.emitQueue(rt);
      this.emit(rt, { type: 'queueReturned', texts: back });
    }
    if (rt.status === 'queued') { rt.cancelQueued?.(); return; }
    rt.agent.cancel();
    for (const [id, p] of rt.pending) { p.resolve(p.kind === 'approve' ? false : null); this.emit(rt, { type: 'approvalDone', id, label: 'cancelled' }); }
    rt.pending.clear();
  }

  stopAll(sid?: string): void {
    for (const s of this.sessions.values()) {
      if (sid && s.id !== sid) { continue; }
      for (const rt of s.agents.values()) { if (rt.busy) { this.stop(s.id, rt.id); } }
    }
  }

  /** Answers a pending approval or plan prompt. Returns false if it was no longer pending. */
  resolveApproval(sid: string, aid: string, id: string, value: boolean | Mode | null, setMode?: Mode): boolean {
    const rt = this.agent(sid, aid);
    const p = rt.pending.get(id);
    if (!p || p.kind === 'question') { return false; }
    rt.pending.delete(id);
    const switched = !!setMode && setMode !== rt.settings.mode;
    if (setMode) { rt.settings.mode = setMode; this.emit(rt, { type: 'agentSettings', settings: { ...rt.settings } }); }
    const label = p.kind === 'approve'
      ? (value ? `allowed${setMode ? ` (${setMode} on)` : ''}` : 'denied')
      : (value ? `approved (${value})` : 'keep planning');
    this.emit(rt, { type: 'approvalDone', id, label });
    if (!rt.pending.size) { this.setStatus(rt, 'running', 'Thinking…'); }
    p.resolve(value);
    // "Allow and switch mode": other waiting approvals (and sub-agents) follow the new mode too.
    if (switched) { this.modeSwitched(rt); }
    return true;
  }

  /** Answers clarifying questions (null = skipped). Unknown labels are dropped; returns false if no longer pending. */
  resolveQuestion(sid: string, aid: string, id: string, raw: unknown): boolean {
    const rt = this.agent(sid, aid);
    const p = rt.pending.get(id);
    if (!p || p.kind !== 'question' || !p.questions) { return false; }
    rt.pending.delete(id);
    let answers: Answers | null = raw === null ? null : sanitizeAnswers(p.questions, raw);
    if (answers && !Object.keys(answers).length) { answers = null; }
    this.emit(rt, { type: 'approvalDone', id, label: answers ? `answered — ${summarizeAnswers(p.questions, answers)}` : 'skipped' });
    if (!rt.pending.size) { this.setStatus(rt, 'running', 'Thinking…'); }
    p.resolve(answers);
    return true;
  }

  async rewind(sid: string, aid: string, turn: number): Promise<number> {
    const rt = this.agent(sid, aid);
    if (rt.busy) { this.stop(sid, aid); await rt.run?.catch(() => undefined); }
    const files = await rt.agent.rewind(turn);
    truncateLog(rt, turn);
    rt.bookmarks = rt.bookmarks.filter((b) => b.turn < turn);
    rt.log.push({ type: 'info', text: `Rewound to before this message. ${files.length} file${files.length === 1 ? '' : 's'} restored.` });
    this.deps.onEvent?.(sid, aid, { type: 'rewound', turn, files: files.length });
    await this.persist(rt);
    this.changed();
    return files.length;
  }

  async compact(sid: string, aid: string): Promise<void> {
    const rt = this.agent(sid, aid);
    if (rt.busy) {
      // Mid-turn the history is in use: the turn compacts itself before its next model call.
      rt.agent.requestCompact();
      this.uiFor(rt).info("Compaction requested: it runs before the agent's next model call.");
      return;
    }
    await rt.agent.compact({ ...rt.settings }, this.uiFor(rt), true);
    await this.persist(rt);
  }

  /* ------------------------------------------------------------ sub-agents (Claude-style) */

  private types(): AgentType[] { return this.deps.agentTypes?.() ?? BUILTIN_AGENT_TYPES; }

  /**
   * Launches a sub-agent of `req.type` for the agent `parentId`. Foreground: resolves with its report (stopping the
   * parent stops it). Background: resolves at once; the parent is notified when it finishes.
   */
  async spawn(sid: string, parentId: string, req: Omit<SpawnRequest, 'parentToolId' | 'settings' | 'signal' | 'history'> & Partial<SpawnRequest>): Promise<SpawnResult> {
    const s = this.session(sid);
    const parent = this.agent(sid, parentId);
    const types = this.types();
    const type = findAgentType(types, req.type);
    if (!type) { return { ok: false, text: `ERROR: unknown agent type "${req.type}". Available types: ${types.map((t) => t.name).join(', ')}.` }; }
    const aid = s.reserveAgentId();
    const base = req.settings ?? parent.settings;
    const settings: AgentSettings = { mode: base.mode, effort: type.effort ?? base.effort, model: type.model ?? this.deps.subagentModel?.(base.model) ?? base.model };
    let worktree: AgentWorktreeRef | undefined;
    let rt: AgentRuntime;
    try {
      worktree = await this.deps.prepareWorktree?.(sid, aid, type);
      rt = new AgentRuntime(sid, aid, req.description, settings, this.deps.createAgent(sid, aid, { role: 'sub', type, root: worktree?.path }));
    } finally { s.releaseAgentId(aid); }
    Object.assign(rt, { role: 'sub', parentId, type: type.name, description: req.description, background: req.background, parentToolId: req.parentToolId, worktree });
    if (type.forkContext) {
      const hist = forkableHistory(req.history ?? parent.agent.history, req.parentToolId);
      rt.agent.loadState({ history: hist, turnStarts: repairTurnStarts(hist, []).turnStarts });
      rt.log = transcriptFromHistory(rt.agent, this.deps.describeTool);
      rt.log.push({ type: 'info', text: `Forked from ${parent.name}: started with a copy of its conversation; it continues independently.` });
    }
    s.agents.set(aid, rt);
    if (req.parentToolId) { parent.subtasks.delete(req.parentToolId); this.emit(parent, { type: 'agentLink', toolId: req.parentToolId, agentId: aid }); }
    this.changed();
    const run = this.send(sid, aid, req.prompt, { display: req.prompt, noQueue: !req.background });
    if (req.background) {
      void run.catch(() => undefined).then(() => this.notifyParent(rt));
      return { ok: true, agentId: aid, text: `Launched ${type.name} agent "${req.description}" (id ${aid}) in the background. You will be notified automatically when it finishes. Do not wait or poll for it: continue with other work, or end your turn.` };
    }
    const onAbort = () => { if (rt.busy) { this.stop(sid, aid); } };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    try { await run.catch(() => undefined); } finally { req.signal?.removeEventListener('abort', onAbort); }
    if (req.signal?.aborted) { throw new Error('Cancelled'); }
    return this.subResult(rt);
  }

  /** A sub-agent the user starts from the UI: runs in the background and reports to the main conversation. */
  spawnFromUser(sid: string, type: string, prompt: string): Promise<SpawnResult> {
    const s = this.session(sid);
    const main = s.main();
    const description = titleFrom(prompt, 48);
    return this.spawn(sid, main.id, { description, prompt, type, background: true }).then((r) => {
      if (r.ok && r.agentId) { this.emit(main, { type: 'info', text: `Started ${type} agent “${description}” in the background (${r.agentId}). Its report will be delivered to this conversation.`, agentId: r.agentId }); }
      return r;
    });
  }

  /** send_message: continue an existing sub-agent in the background; the parent is notified when it replies. */
  async message(sid: string, to: string, text: string): Promise<SpawnResult> {
    const s = this.sessions.get(sid);
    const rt = s?.agents.get(to);
    if (!s || !rt || rt.role !== 'sub') {
      const known = s ? [...s.agents.values()].filter((a) => a.role === 'sub').map((a) => `${a.id} (${a.description})`).join(', ') : '';
      return { ok: false, text: `ERROR: no sub-agent "${to}" in this session.${known ? ` Known agents: ${known}.` : ''}` };
    }
    if (rt.busy) { return { ok: false, text: `ERROR: agent ${to} is still working; you will be notified when it finishes.` }; }
    rt.background = true;
    void this.send(sid, to, text).catch(() => undefined).then(() => this.notifyParent(rt));
    return { ok: true, agentId: to, text: `Message sent to agent ${to} ("${rt.description}"). It continues in the background; you will be notified when it replies.` };
  }

  private settleSub(rt: AgentRuntime): void {
    const last = rt.agent.history[rt.agent.history.length - 1];
    const report = last?.role === 'assistant' && last.content ? last.content.trim() : '';
    rt.result = report || undefined;
    rt.outcome = rt.status === 'error' ? 'failed' : rt.cancelled ? 'cancelled' : report ? 'completed' : 'failed';
  }

  private subResult(rt: AgentRuntime): SpawnResult {
    const where = rt.worktree ? `\n\nThis agent worked on branch ${rt.worktree.branch}. Its changes are not in the main workspace until the user merges them from the Changes panel.` : '';
    if (rt.outcome === 'completed') { return { ok: true, agentId: rt.id, text: `${rt.result}${where}\n\n(agent id ${rt.id}; use send_message to follow up)`, ...this.changedBy(rt) }; }
    if (rt.outcome === 'cancelled') { return { ok: false, agentId: rt.id, text: `Agent ${rt.id} ("${rt.description}") was stopped by the user before it finished.`, ...this.changedBy(rt) }; }
    return { ok: false, agentId: rt.id, text: `ERROR: agent ${rt.id} ("${rt.description}") failed: ${rt.error ?? 'it finished without a final report (it may have hit its step limit). Try a narrower task.'}`, ...this.changedBy(rt) };
  }

  /** Files a sub-agent changed in the shared workspace (a worktree agent's changes arrive only when merged). */
  private changedBy(rt: AgentRuntime): { changed?: string[] } {
    return !rt.worktree && rt.agent.lastChanged.length ? { changed: [...rt.agent.lastChanged] } : {};
  }

  private notifyParent(sub: AgentRuntime): void {
    const s = this.sessions.get(sub.sessionId);
    const parent = sub.parentId ? s?.agents.get(sub.parentId) : undefined;
    if (!parent) { return; }
    // Even a failed or stopped agent may have changed files: the parent's next turn checks them.
    const changed = this.changedBy(sub).changed;
    if (changed) { parent.agent.markExternalChanges(changed); }
    const r = this.subResult(sub);
    parent.inbox.push({
      id: sub.id, description: sub.description ?? sub.name, outcome: sub.outcome,
      text: `<agent-notification>\n<agent-id>${sub.id}</agent-id>\n<type>${sub.type}</type>\n<description>${sub.description}</description>\n<status>${sub.outcome}</status>\n<result>\n${r.text}\n</result>\n</agent-notification>`,
    });
    this.changed();
    this.drainInbox(parent);
  }

  /** Delivers queued notifications as a new turn once the parent is free (Claude-style task notifications). */
  private drainInbox(parent: AgentRuntime): void {
    if (parent.busy || !parent.inbox.length || !this.sessions.get(parent.sessionId)?.agents.has(parent.id)) { return; }
    const items = parent.inbox.splice(0);
    const many = items.length > 1;
    const prompt = `${items.map((i) => i.text).join('\n\n')}\n\nThe background agent${many ? 's' : ''} above finished. Use ${many ? 'their results' : 'its result'} to continue the user's request, or report what ${many ? 'they' : 'it'} found.`;
    const display = `🔔 ${items.map((i) => `Agent “${i.description}” ${i.outcome ?? 'finished'}`).join(' · ')}`;
    void this.send(parent.sessionId, parent.id, prompt, { display, notification: items.map(({ id, description, outcome }) => ({ id, description, outcome })) }).catch(() => undefined);
  }

  /** Mirrors a sub-agent's tool activity into the parent's agent-tool card. */
  private forwardToParent(sub: AgentRuntime, detail: string): void {
    if (sub.role !== 'sub' || !sub.parentToolId || !sub.parentId) { return; }
    const parent = this.sessions.get(sub.sessionId)?.agents.get(sub.parentId);
    if (parent) { this.emit(parent, { type: 'toolProgress', id: sub.parentToolId, text: detail }); }
  }

  /* ------------------------------------------------------------ bookmarks */

  setBookmark(sid: string, aid: string, b: { turn: number; hash: string; preview: string }, on: boolean): Bookmark[] {
    const rt = this.agent(sid, aid);
    rt.bookmarks = rt.bookmarks.filter((x) => !(x.turn === b.turn && x.hash === b.hash));
    if (on) { rt.bookmarks.push({ turn: b.turn, hash: String(b.hash).slice(0, 32), preview: String(b.preview).slice(0, 160), at: Date.now() }); }
    void this.persist(rt);
    return rt.bookmarks;
  }

  /** Every bookmark in a session, newest first, with the agent it belongs to. */
  bookmarks(sid: string): Array<Bookmark & { agentId: string; agentName: string }> {
    return [...this.session(sid).agents.values()]
      .flatMap((a) => a.bookmarks.map((b) => ({ ...b, agentId: a.id, agentName: a.role === 'main' ? 'Main' : (a.description ?? a.name) })))
      .sort((x, y) => y.at - x.at);
  }

  /* ------------------------------------------------------------ views */

  snapshot(): SessionView[] {
    return [...this.sessions.values()]
      .map((s) => ({ id: s.id, title: s.title || 'New chat', createdAt: s.createdAt, updatedAt: s.updatedAt, agents: [...s.agents.values()].map((a) => a.view()) }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  transcript(sid: string, aid: string): { events: UiEvent[]; view: AgentView; queue: Array<{ id: string; display: string }> } {
    const rt = this.agent(sid, aid);
    return { events: rt.log, view: rt.view(), queue: this.queued(sid, aid) };
  }

  preview(sid: string, aid: string, id: string): ApprovalPreview | undefined {
    return this.sessions.get(sid)?.agents.get(aid)?.previews.get(id);
  }

  get running(): number { return this.runningCount; }

  /** Saves everything (agents still working are stored as "running" and come back as "interrupted"). */
  async shutdown(): Promise<void> {
    for (const s of this.sessions.values()) { await this.flushSession(s); }
    await this.deps.store.flush();
  }

  /* ------------------------------------------------------------ internals */

  private async flushSession(s: SessionRuntime): Promise<void> {
    for (const rt of s.agents.values()) { clearTimeout(rt.saveTimer); rt.saveTimer = undefined; }
    if (![...s.agents.values()].some((a) => a.agent.turnCount > 0)) { return; }
    for (const rt of s.agents.values()) { await this.deps.store.saveAgent(rt.record()); }
    await this.persistMeta(s);
  }

  private uiFor(rt: AgentRuntime): AgentUi {
    return {
      token: (t) => { this.stopWaiting(rt); if (rt.activity !== 'Writing response…') { this.setStatus(rt, rt.status, 'Writing response…'); } this.emit(rt, { type: 'token', text: t }); },
      // Status line only (not logged): toolStart replaces it with the call's own detail once the call is complete.
      toolWriting: (p) => { this.stopWaiting(rt); this.setStatus(rt, rt.status, toolWritingLabel(p)); },
      modelCall: (phase) => {
        if (phase === 'waiting') { this.waitForModel(rt); return; }
        const waiting = !!rt.waitTimer;
        this.stopWaiting(rt);
        // First byte: the model is working (perhaps only reasoning so far) until text or a tool call shows up.
        if (phase === 'receiving' && waiting && rt.activity.startsWith(WAITING_LABEL)) { this.setStatus(rt, rt.status, 'Thinking…'); }
      },
      toolStart: (id, name, kind, args, detail, preview) => {
        let diff;
        if (preview) { rt.previews.set(id, preview); diff = { id, path: preview.path, ...diffText(preview.oldText, preview.newText) }; }
        if (name === 'agent' || name === 'task') { rt.subtasks.set(id, { id, title: detail.replace(/^(Sub-agent:|Agent \([^)]*\):)\s*/, '').replace(/ · background$/, ''), last: 'starting…', done: false }); }
        this.forwardToParent(rt, detail);
        this.setStatus(rt, rt.status, detail);
        this.emit(rt, { type: 'toolStart', id, name, kind, args, detail, diff });
        if (name !== 'todo_write' && attachAction(rt.todos, { toolId: id, detail })) { this.emitTodos(rt); }
      },
      toolEnd: (id, ok, result) => {
        const t = rt.subtasks.get(id);
        if (t) { t.done = true; t.ok = ok; }
        this.emit(rt, { type: 'toolEnd', id, ok, result });
        if (finishAction(rt.todos, id, ok)) { this.emitTodos(rt); }
        this.setStatus(rt, rt.status, 'Thinking…');
        this.saveSoon(rt);
      },
      info: (t) => this.emit(rt, { type: 'info', text: t }),
      userInjected: (items) => {
        this.emit(rt, { type: 'userMsg', text: items.map((q) => q.display).join('\n\n'), midTurn: true, files: items.flatMap((q) => q.files ?? []), thumbs: items.flatMap((q) => q.thumbs ?? []) });
        this.emitQueue(rt);
        this.setStatus(rt, rt.status, 'Reading your new message…');
      },
      spent: (tokens) => {
        if (!Number.isFinite(tokens) || tokens <= 0) { return; }
        rt.tokens += Math.round(tokens);
        this.changed();
        this.saveSoon(rt);
      },
      usage: (used, limit) => {
        const total = used + overheadOf(rt);
        rt.usage = { used: total, limit };
        this.emit(rt, { type: 'usage', used: total, limit });
      },
      modeChanged: (mode) => { rt.settings.mode = mode; this.emit(rt, { type: 'agentSettings', settings: { ...rt.settings } }); },
      approvalSettled: (id, label) => {
        if (!rt.pending.delete(id)) { return; }
        this.emit(rt, { type: 'approvalDone', id, label });
        if (!rt.pending.size) { this.setStatus(rt, 'running', 'Thinking…'); }
      },
      subProgress: (id, text) => {
        const t = rt.subtasks.get(id);
        if (t) { t.last = text; }
        this.emit(rt, { type: 'toolProgress', id, text });
        this.changed();
      },
      approve: (req) => new Promise<boolean>((resolve) => {
        rt.pending.set(req.id, { kind: 'approve', resolve });
        let diff;
        if (req.preview) { rt.previews.set(req.id, req.preview); diff = { id: req.id, path: req.preview.path, ...diffText(req.preview.oldText, req.preview.newText) }; }
        this.setStatus(rt, 'waiting', `Waiting for approval: ${req.detail}`);
        this.emit(rt, { type: 'approve', id: req.id, kind: req.kind, name: req.name, detail: req.detail, diff, ...(req.reason ? { reason: req.reason } : {}) });
      }),
      todos: (items) => {
        rt.todos = mergeTodos(rt.todos, items);
        const active = rt.todos.find((t) => t.status === 'in_progress');
        if (active) { this.setStatus(rt, rt.status, active.activeForm || active.content); }
        this.emitTodos(rt);
        this.saveSoon(rt);
      },
      askUser: (id, questions) => new Promise<Answers | null>((resolve) => {
        rt.pending.set(id, { kind: 'question', resolve, questions });
        this.setStatus(rt, 'waiting', `Waiting for your answer: ${questions[0].question}`);
        this.emit(rt, { type: 'question', id, questions });
      }),
      approvePlan: (id, plan) => new Promise<Mode | null>((resolve) => {
        rt.pending.set(id, { kind: 'plan', resolve });
        this.setStatus(rt, 'waiting', 'Waiting for plan approval');
        this.emit(rt, { type: 'planApprove', id, plan });
      }),
    };
  }

  private emitTodos(rt: AgentRuntime): void {
    this.emit(rt, { type: 'todos', items: JSON.parse(JSON.stringify(rt.todos)) });
    this.changed();
  }

  private emit(rt: AgentRuntime, ev: UiEvent): void {
    // Only the latest task list is kept in the transcript: the card always shows current progress.
    if (ev.type === 'todos') { rt.log = rt.log.filter((e) => e.type !== 'todos'); }
    if (LOGGED.has(ev.type)) {
      const last = rt.log[rt.log.length - 1];
      if (ev.type === 'token' && last?.type === 'token') { last.text += ev.text; } else { rt.log.push({ ...ev }); }
    }
    rt.updatedAt = Date.now();
    const s = this.sessions.get(rt.sessionId);
    if (s) { s.updatedAt = rt.updatedAt; }
    this.deps.onEvent?.(rt.sessionId, rt.id, ev);
  }

  /** Shows "Waiting for the model…" and, after the notice delay, how long the model has been silent. */
  private waitForModel(rt: AgentRuntime): void {
    this.stopWaiting(rt);
    const since = Date.now();
    const notice = this.deps.waitNoticeMs ?? WAIT_NOTICE_MS;
    this.setStatus(rt, rt.status, WAITING_LABEL);
    rt.waitTimer = setInterval(() => {
      // Only while the line still shows the wait: an approval or another status must not be overwritten.
      if (rt.activity.startsWith(WAITING_LABEL)) { this.setStatus(rt, rt.status, waitingLabel(Date.now() - since, notice)); }
    }, this.deps.waitTickMs ?? WAIT_TICK_MS);
    rt.waitTimer.unref?.();
  }

  private stopWaiting(rt: AgentRuntime): void {
    if (rt.waitTimer) { clearInterval(rt.waitTimer); rt.waitTimer = undefined; }
  }

  private setStatus(rt: AgentRuntime, status: StoredStatus, activity: string): void {
    const changed = rt.status !== status || rt.activity !== activity;
    rt.status = status;
    rt.activity = activity;
    if (changed) { this.changed(); }
  }

  private changed(): void { this.deps.onChange?.(); }

  private acquire(rt: AgentRuntime): Promise<void> {
    const max = Math.max(1, this.deps.maxConcurrent?.() ?? 4);
    if (this.runningCount < max) { this.runningCount++; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const entry = { rt, go: () => { rt.cancelQueued = undefined; resolve(); } };
      this.queue.push(entry);
      rt.cancelQueued = () => { this.queue = this.queue.filter((q) => q !== entry); rt.cancelQueued = undefined; reject(new Error('Cancelled')); };
      this.setStatus(rt, 'queued', `Queued: ${this.runningCount} agents already running (limit ${max})`);
    });
  }

  private release(): void {
    this.runningCount = Math.max(0, this.runningCount - 1);
    const max = Math.max(1, this.deps.maxConcurrent?.() ?? 4);
    while (this.queue.length && this.runningCount < max) {
      const next = this.queue.shift()!;
      this.runningCount++;
      next.go();
    }
  }

  private saveSoon(rt: AgentRuntime): void {
    if (rt.saveTimer) { return; }
    rt.saveTimer = setTimeout(() => { rt.saveTimer = undefined; void this.persist(rt); }, this.deps.saveThrottleMs ?? 1500);
  }

  private async persist(rt: AgentRuntime): Promise<void> {
    const s = this.sessions.get(rt.sessionId);
    if (!s || rt.agent.turnCount === 0) { return; }
    try {
      await this.deps.store.saveAgent(rt.record());
      await this.persistMeta(s);
    } catch (e: any) {
      this.emit(rt, { type: 'info', text: `Could not save this chat: ${e.message ?? e}`, error: true });
    }
  }

  private async persistMeta(s: SessionRuntime): Promise<void> {
    if (![...s.agents.values()].some((a) => a.agent.turnCount > 0)) { return; }
    if (!s.persisted) {
      s.persisted = true;
      for (const a of s.agents.values()) { if (a.agent.turnCount === 0) { await this.deps.store.saveAgent(a.record()); } }
    }
    await this.deps.store.saveMeta(s.meta());
  }
}

/** For a fork: the parent's conversation before the assistant message that launched the fork. */
function forkableHistory(history: ChatMessage[], parentToolId?: string): ChatMessage[] {
  let end = history.length;
  if (parentToolId) {
    const i = history.findIndex((m) => m.role === 'assistant' && (m.tool_calls ?? []).some((tc) => tc.id === parentToolId));
    if (i >= 0) { end = i; }
  }
  return JSON.parse(JSON.stringify(history.slice(0, end)));
}

const finiteOr0 = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/** Tokens of the system prompt, memory and tool definitions measured on the agent's last request. */
function overheadOf(rt: AgentRuntime): number {
  const o = rt.agent.lastContext;
  return o ? o.system + o.memory + o.tools + o.mcpTools + o.agentTools : 0;
}

function truncateLog(rt: AgentRuntime, turn: number): void {
  const i = rt.log.findIndex((e) => e.type === 'userMsg' && e.turn === turn);
  if (i >= 0) { rt.log.length = i; }
}

/** Rebuilds the visible transcript of a stored agent from its message history. */
export function transcriptFromHistory(agent: Agent, describe?: (name: string, args: any) => string): UiEvent[] {
  const events: UiEvent[] = [];
  for (const it of historyToUi(agent.history, agent.turnStarts, describe)) {
    if (it.type === 'user') { events.push({ type: 'userMsg', text: it.text, turn: it.turn, files: [] }); }
    else if (it.type === 'assistant') { events.push({ type: 'assistantText', text: it.text }); }
    else {
      events.push({ type: 'toolStart', id: it.id, name: it.name, detail: it.detail, args: it.args });
      events.push({ type: 'toolEnd', id: it.id, ok: it.ok, result: it.result });
    }
  }
  return events;
}
