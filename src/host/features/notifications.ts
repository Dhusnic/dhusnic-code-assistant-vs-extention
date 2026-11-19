import * as vscode from 'vscode';
import { AgentActivity, NotificationTracker, NotifyContext, NotifyDecision } from '../../core/notify';

const COALESCE_MS = 5000;
const OPEN = 'Open';

interface Settings { enabled: boolean; minDurationMs: number; categories: NonNullable<NotifyContext['settings']> }

function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('infraonAssistant.notifications');
  return {
    enabled: c.get<boolean>('enabled', true),
    minDurationMs: Math.max(0, c.get<number>('minDurationSeconds', 30)) * 1000,
    categories: {
      taskDone: c.get<boolean>('taskDone', true), needsInput: c.get<boolean>('needsInput', true),
      backgroundAgents: c.get<boolean>('backgroundAgents', true), errors: c.get<boolean>('errors', true),
    },
  };
}

const MUTED: NotifyContext['settings'] = { taskDone: false, needsInput: false, backgroundAgents: false, errors: false };

export function createNotifier(opts: { openSession(id: string): Promise<void>; isPanelVisible(sid: string): boolean }): {
  update(snapshot: Array<{ id: string; title: string; agents: any[] }>): void; dispose(): void;
} {
  const tracker = new NotificationTracker();
  const lastShown = new Map<string, number>();
  const queued = new Map<string, { decision: NotifyDecision; timer: NodeJS.Timeout }>();
  let settings: Settings | undefined;
  let disposed = false;
  const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('infraonAssistant.notifications')) { settings = undefined; }
  });

  const unqueue = (sid: string): void => {
    const q = queued.get(sid);
    if (q) { clearTimeout(q.timer); queued.delete(sid); }
  };

  const show = (d: NotifyDecision): void => {
    lastShown.set(d.sessionId, Date.now());
    const w = vscode.window;
    const toast = d.level === 'error' ? w.showErrorMessage(d.message, OPEN) : d.level === 'warning' ? w.showWarningMessage(d.message, OPEN) : w.showInformationMessage(d.message, OPEN);
    toast.then((choice) => {
      if (choice === OPEN && !disposed) { opts.openSession(d.sessionId).catch(() => undefined); }
    }, () => undefined);
  };

  /** At most one toast per session per window; a newer decision replaces the one still waiting. */
  const offer = (d: NotifyDecision): void => {
    const wait = (lastShown.get(d.sessionId) ?? 0) + COALESCE_MS - Date.now();
    unqueue(d.sessionId);
    if (wait <= 0) { show(d); return; }
    const timer = setTimeout(() => { queued.delete(d.sessionId); if (!disposed) { show(d); } }, wait);
    queued.set(d.sessionId, { decision: d, timer });
  };

  const forget = (sid: string): void => { tracker.forget(sid); unqueue(sid); lastShown.delete(sid); };

  return {
    update(snapshot) {
      if (disposed) { return; }
      const cfg = (settings ??= readSettings());
      const focused = vscode.window.state.focused;
      const live = new Set<string>();
      for (const s of snapshot) {
        live.add(s.id);
        const ctx: NotifyContext = {
          windowFocused: focused, panelVisible: opts.isPanelVisible(s.id), minDurationMs: cfg.minDurationMs,
          settings: cfg.enabled ? cfg.categories : MUTED,
        };
        for (const a of s.agents) {
          const next: AgentActivity = {
            sessionId: s.id, agentId: a.id, role: a.role === 'sub' ? 'sub' : 'main', status: a.status, title: s.title, activity: a.activity ?? '',
            startedAt: a.startedAt, description: a.description, outcome: a.outcome, background: !!a.background, cancelled: !!a.cancelled,
          };
          // A question that was answered while its toast was held back is no longer worth showing.
          const q = queued.get(s.id);
          if (q && q.decision.kind === 'needsInput' && q.decision.agentId === a.id && a.status !== 'waiting') { unqueue(s.id); }
          const d = tracker.observe(next, ctx);
          if (d) { offer(d); }
        }
      }
      for (const sid of tracker.sessionIds()) { if (!live.has(sid)) { forget(sid); } }
    },
    dispose() {
      disposed = true;
      configSub.dispose();
      for (const sid of [...queued.keys()]) { unqueue(sid); }
      lastShown.clear();
    },
  };
}
