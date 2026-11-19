export const DEFAULT_MIN_DURATION_MS = 30000;

export interface AgentActivity {
  sessionId: string; agentId: string; role: 'main' | 'sub'; status: string; title: string; activity: string;
  startedAt?: number; description?: string; outcome?: 'completed' | 'failed' | 'cancelled';
  /** Foreground sub-agents report to their parent, so only background ones announce finishing. Absent means background. */
  background?: boolean;
  /** The user stopped this run. A stopped main agent ends plain idle, so this is the only way to tell. */
  cancelled?: boolean;
}
export interface NotifySettings { taskDone: boolean; needsInput: boolean; backgroundAgents: boolean; errors: boolean }
export interface NotifyContext {
  windowFocused: boolean; panelVisible: boolean; minDurationMs?: number; settings?: Partial<NotifySettings>;
  /** Clock override for tests. */
  now?: number;
}
export type NotifyKind = 'needsInput' | 'taskDone' | 'backgroundAgent' | 'error';
export interface NotifyDecision {
  kind: NotifyKind; level: 'info' | 'warning' | 'error'; sessionId: string; agentId: string; message: string;
}

export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = { taskDone: true, needsInput: true, backgroundAgents: true, errors: true };

const short = (s: string, max = 160): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const label = (a: AgentActivity): string => (a.role === 'sub' && a.description ? `${a.title} / ${a.description}` : a.title);
const decision = (a: AgentActivity, kind: NotifyKind, level: NotifyDecision['level'], message: string): NotifyDecision =>
  ({ kind, level, sessionId: a.sessionId, agentId: a.agentId, message: short(message, 240) });

/**
 * Decides whether one agent's state change deserves a notification. Pure: the same pair always gives the same answer.
 * The runtime goes idle/error first and only then settles a sub-agent (outcome set, startedAt cleared), so a sub-agent's
 * finish is read from the settled state: before that, `outcome` can still be the previous run's.
 */
export function decideNotification(prev: AgentActivity | undefined, next: AgentActivity, ctx: NotifyContext): NotifyDecision | undefined {
  if (next.cancelled) { return undefined; }
  const on = { ...DEFAULT_NOTIFY_SETTINGS, ...ctx.settings };
  const looking = ctx.windowFocused && ctx.panelVisible;

  if (next.status === 'waiting') {
    const fresh = prev?.status !== 'waiting' || (prev.activity !== next.activity && /^Waiting\b/.test(next.activity));
    return fresh && !looking && on.needsInput ? decision(next, 'needsInput', 'warning', `${label(next)}: ${short(next.activity)}`) : undefined;
  }
  if (!prev) { return undefined; } // first sight of an agent (e.g. restored from disk) is not a transition

  if (next.status === 'error') {
    if (prev.status === 'error' || !on.errors || (next.outcome === 'cancelled' && next.startedAt === undefined)) { return undefined; }
    return decision(next, 'error', 'error', `${label(next)}: ${short(next.activity)}`);
  }
  if (next.status !== 'idle') { return undefined; }

  if (next.role === 'main') {
    if (prev.status !== 'running' && prev.status !== 'waiting') { return undefined; }
    const start = next.startedAt ?? prev.startedAt;
    if (start === undefined || looking || !on.taskDone) { return undefined; }
    if ((ctx.now ?? Date.now()) - start < (ctx.minDurationMs ?? DEFAULT_MIN_DURATION_MS)) { return undefined; }
    return decision(next, 'taskDone', 'info', `${label(next)}: task finished`);
  }

  if (next.background === false || !on.backgroundAgents || next.startedAt !== undefined) { return undefined; }
  if (!next.outcome || next.outcome === 'cancelled') { return undefined; }
  if (prev.startedAt === undefined && prev.status !== 'running' && prev.status !== 'waiting') { return undefined; }
  const name = next.description || 'Background agent';
  return decision(next, 'backgroundAgent', next.outcome === 'failed' ? 'warning' : 'info', `${next.title}: agent "${short(name, 80)}" ${next.outcome}`);
}

/** Remembers each agent's last state, so every transition is judged exactly once. */
export class NotificationTracker {
  private sessions = new Map<string, Map<string, AgentActivity>>();

  observe(next: AgentActivity, ctx: NotifyContext): NotifyDecision | undefined {
    let agents = this.sessions.get(next.sessionId);
    if (!agents) { agents = new Map(); this.sessions.set(next.sessionId, agents); }
    const prev = agents.get(next.agentId);
    agents.set(next.agentId, next);
    return decideNotification(prev, next, ctx);
  }

  forget(sessionId: string): void { this.sessions.delete(sessionId); }
  has(sessionId: string): boolean { return this.sessions.has(sessionId); }
  sessionIds(): string[] { return [...this.sessions.keys()]; }
}
