import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ScheduleMode, ScheduleStore, ScheduledTask, dueTasks, msUntilNext, parseSchedule } from '../../core/schedules';
import type { Hub } from '../hub';

/** Runs this workspace's scheduled tasks with one timer that sleeps until the next task is due. */
export class Scheduler implements vscode.Disposable {
  private store: ScheduleStore;
  private timer?: NodeJS.Timeout;
  private running = new Set<string>();

  constructor(private hub: Hub, private dir: string) {
    this.store = new ScheduleStore(path.join(dir, 'schedules.json'));
  }

  async start(): Promise<void> {
    await this.store.load();
    await this.store.reconcile();
    this.arm();
  }

  dispose(): void { clearTimeout(this.timer); }

  private arm(): void {
    clearTimeout(this.timer);
    const tasks = this.store.list();
    if (!tasks.some((t) => t.enabled)) { return; }
    this.timer = setTimeout(() => void this.tick(), msUntilNext(tasks, new Date()));
  }

  private async tick(): Promise<void> {
    try {
      await this.store.load();
      for (const task of dueTasks(this.store.list(), new Date())) {
        if (!this.running.has(task.id) && await this.claim(task)) { void this.run(task); }
      }
    } catch (e: any) { this.hub.output.appendLine(`[schedule] ${e.message ?? e}`); }
    this.arm();
  }

  /** Two windows on one workspace share a schedule; creating this folder decides which of them runs the slot. */
  private async claim(task: ScheduledTask): Promise<boolean> {
    const slot = path.join(this.dir, 'schedule-claims', `${task.id}-${task.nextRunAt ?? 0}`);
    await fs.mkdir(path.dirname(slot), { recursive: true });
    return fs.mkdir(slot).then(() => true, (e) => { if (e.code === 'EEXIST') { return false; } throw e; });
  }

  private async run(task: ScheduledTask): Promise<void> {
    this.running.add(task.id);
    try {
      await this.store.markRun(task.id, 'running');
      await this.hub.runScheduled(task.name, task.prompt, task.mode);
      await this.store.markRun(task.id, 'success');
    } catch (e: any) {
      this.hub.output.appendLine(`[schedule] ${task.name}: ${e.message ?? e}`);
      await this.store.markRun(task.id, 'error').catch(() => undefined);
    } finally { this.running.delete(task.id); this.arm(); }
  }

  private async create(): Promise<void> {
    const name = await vscode.window.showInputBox({ prompt: 'Task name', placeHolder: 'Morning regression review', ignoreFocusOut: true });
    if (!name?.trim()) { return; }
    const prompt = await vscode.window.showInputBox({ prompt: 'What should the agent do?', placeHolder: 'Summarize yesterday\'s pull requests', ignoreFocusOut: true });
    if (!prompt?.trim()) { return; }
    const schedule = await vscode.window.showInputBox({
      prompt: 'When should it run?', value: 'weekdays 09:00', ignoreFocusOut: true,
      validateInput: (v) => { const p = parseSchedule(v); return p.ok ? undefined : `${p.error}. Examples: daily 09:00, weekly mon 09:00, every 30m, 0 9 * * 1-5`; },
    });
    if (!schedule) { return; }
    const modes: Array<{ label: string; description: string; mode: ScheduleMode }> = [
      { label: 'Plan only', description: 'Reads and reports, changes nothing', mode: 'plan' },
      { label: 'Ask before edits', description: 'Waits for your approval', mode: 'ask' },
      { label: 'Edit automatically', description: 'Applies file edits, asks before commands', mode: 'auto-edit' },
    ];
    const mode = await vscode.window.showQuickPick(modes, { placeHolder: 'What may the task do?' });
    if (!mode) { return; }
    await this.store.add({ name: name.trim(), prompt: prompt.trim(), schedule, enabled: true, mode: mode.mode });
    this.arm();
    void vscode.window.showInformationMessage(`Scheduled "${name.trim()}".`);
  }

  async manage(): Promise<void> {
    await this.store.load();
    const items = this.store.list().map((t) => ({
      label: `${t.enabled ? '$(clock)' : '$(circle-slash)'} ${t.name}`, description: t.schedule,
      detail: t.enabled && t.nextRunAt ? `Next run ${new Date(t.nextRunAt).toLocaleString()}` : 'Paused', task: t as ScheduledTask | undefined,
    }));
    const pick = await vscode.window.showQuickPick([{ label: '$(add) New scheduled task', description: '', detail: undefined, task: undefined }, ...items], { placeHolder: 'Scheduled tasks for this workspace' });
    if (!pick) { return; }
    if (!pick.task) { await this.create(); return; }
    const t = pick.task;
    const action = await vscode.window.showQuickPick(['Run now', t.enabled ? 'Pause' : 'Resume', 'Delete'], { placeHolder: t.name });
    if (action === 'Run now') { void this.run(t); }
    else if (action === 'Delete') { await this.store.remove(t.id); }
    else if (action) { await this.store.update(t.id, { enabled: !t.enabled }); }
    this.arm();
  }
}
