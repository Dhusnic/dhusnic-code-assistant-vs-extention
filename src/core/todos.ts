/**
 * Claude-style task list (TodoWrite): the agent keeps a short list of steps with a status each. The runtime attaches
 * every tool action performed while a step is in progress to that step, so the UI can show what was done per step.
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export interface TodoAction { toolId: string; detail: string; ok?: boolean; at?: number; ms?: number }
export interface TodoItem { content: string; status: TodoStatus; activeForm?: string; actions: TodoAction[]; startedAt?: number; finishedAt?: number }
export interface TodoInput { content: string; status: TodoStatus; activeForm?: string }

export const MAX_TODOS = 20;
const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed'];
const MAX_ACTIONS_PER_STEP = 60;

export function validateTodos(raw: unknown): { todos?: TodoInput[]; error?: string } {
  const list = (raw as { todos?: unknown })?.todos;
  if (!Array.isArray(list) || !list.length) { return { error: 'todos must be a non-empty array' }; }
  if (list.length > MAX_TODOS) { return { error: `keep the list to at most ${MAX_TODOS} steps` }; }
  const todos: TodoInput[] = [];
  for (const [i, t] of list.entries()) {
    const content = String(t?.content ?? '').trim();
    const status = String(t?.status ?? 'pending').replace('-', '_') as TodoStatus;
    if (!content) { return { error: `step ${i + 1} has no content` }; }
    if (!STATUSES.includes(status)) { return { error: `step ${i + 1} has an invalid status "${t?.status}" (use pending, in_progress or completed)` }; }
    todos.push({ content: content.slice(0, 200), status, activeForm: t?.activeForm ? String(t.activeForm).trim().slice(0, 200) : undefined });
  }
  if (todos.filter((t) => t.status === 'in_progress').length > 1) { return { error: 'only one step may be in_progress at a time' }; }
  return { todos };
}

/** New list from the agent, keeping the recorded actions of steps that still exist (matched by content). */
export function mergeTodos(prev: TodoItem[], next: TodoInput[], now = Date.now()): TodoItem[] {
  const byContent = new Map(prev.map((t) => [t.content.toLowerCase(), t]));
  return next.map((t) => {
    const old = byContent.get(t.content.toLowerCase());
    const item: TodoItem = { ...t, actions: old?.actions ?? [], startedAt: old?.startedAt, finishedAt: old?.finishedAt };
    // Timing: a step starts when it first becomes in_progress and finishes when it becomes completed.
    if (t.status === 'in_progress' && !item.startedAt) { item.startedAt = now; }
    if (t.status === 'completed' && !item.finishedAt) { item.finishedAt = now; item.startedAt ??= old?.startedAt ?? item.actions[0]?.at ?? now; }
    if (t.status !== 'completed') { item.finishedAt = undefined; }
    if (t.status === 'pending') { item.startedAt = undefined; }
    return item;
  });
}

/** Records a tool action against the step that is currently in progress. Returns true if it was attached. */
export function attachAction(todos: TodoItem[], action: TodoAction, now = Date.now()): boolean {
  const step = todos.find((t) => t.status === 'in_progress');
  if (!step) { return false; }
  step.actions.push({ ...action, at: action.at ?? now });
  if (step.actions.length > MAX_ACTIONS_PER_STEP) { step.actions.splice(0, step.actions.length - MAX_ACTIONS_PER_STEP); }
  return true;
}

export function finishAction(todos: TodoItem[], toolId: string, ok: boolean, now = Date.now()): boolean {
  for (const t of todos) {
    const a = t.actions.find((x) => x.toolId === toolId);
    if (a) { a.ok = ok; if (a.at) { a.ms = Math.max(0, now - a.at); } return true; }
  }
  return false;
}

/**
 * After this many tool rounds without a todo_write while steps are unfinished, the model is reminded to update the list.
 * Without it, models routinely build the list once and then work through every step without touching it again, so the
 * UI shows step 1 "in progress" for the whole run with every action piled under it.
 */
export const TODO_REMINDER_ROUNDS = 5;

export const unfinishedTodos = (todos: TodoInput[]): TodoInput[] => todos.filter((t) => t.status !== 'completed');

const listLines = (todos: TodoInput[]): string => todos.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join('\n');

/** Appended to a tool result when the list has gone stale. */
export function todoReminder(todos: TodoInput[], rounds: number): string {
  return `<system-reminder>You have done ${rounds} rounds of tool calls since you last updated the task list, and it still reads:\n${listLines(todos)}\n`
    + `If the work you did finished the step that is in_progress (or later ones), call todo_write NOW: mark each finished step completed and the step you are working on in_progress. Keep exactly one step in_progress. Do not mention this reminder to the user.</system-reminder>`;
}

/** Sent once when the model ends its turn while steps are still open. */
export function todoEndReminder(todos: TodoInput[]): string {
  const open = unfinishedTodos(todos);
  return `You are ending your turn, but the task list still has ${open.length} unfinished step${open.length === 1 ? '' : 's'}:\n${listLines(todos)}\n\n`
    + 'If those steps are done, call todo_write now and mark them completed. If work remains, continue with it. '
    + 'If you are stopping on purpose (blocked, or waiting for the user), mark the finished steps completed and say briefly why you are stopping.';
}

/** Tool result: progress plus a nudge to keep the list accurate. */
export function formatTodos(todos: TodoInput[]): string {
  const done = todos.filter((t) => t.status === 'completed').length;
  const active = todos.find((t) => t.status === 'in_progress');
  const next = todos.find((t) => t.status === 'pending');
  return `Task list updated (${done}/${todos.length} done).${active ? ` In progress: ${active.content}.` : ''}${!active && next ? ` Next: mark "${next.content}" in_progress when you start it.` : ''}${done === todos.length ? ' All steps are complete.' : ''} Keep exactly one step in_progress while working and mark each step completed as soon as it is done.`;
}
