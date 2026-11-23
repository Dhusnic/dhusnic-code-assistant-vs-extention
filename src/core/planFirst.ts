/**
 * Plan first: on a working turn, the model writes a task list before it changes any file.
 *
 * Open-weight models sometimes start editing a multi-file task before they understand it and finish half done. The
 * cheapest correction is a gate in the loop, not an extra model call: the first time in a turn that the model calls a
 * file-changing tool (any tool of kind 'edit', so write_file, edit_file, multi_edit, rename_symbol, remote writes and
 * future edit tools are covered without a name list) while no plan exists, that call is NOT run. Its tool result
 * tells the model to call todo_write with the concrete steps and the files each will change, reading any it has not
 * read yet, and then to make the change again. Every edit call of that same response is held the same way, so a
 * batch of writes is never half applied; after that the gate is spent for the turn and never blocks again.
 *
 * A plan exists when the turn already contains a valid todo_write call, or a list with unfinished steps carried over
 * from an earlier turn (a "continue"). Pure questions and read-only turns never reach the gate, so they cost nothing.
 *
 * Applies only to the main agent (a sub-agent gets one focused task from a parent that planned it), never in plan
 * mode (it plans through exit_plan_mode and cannot edit), and only when the tool is allowed in the current mode.
 * The setting infraonAssistant.planFirst: off, max (the default: Max effort only), always (every effort).
 *
 * The held call is not a real tool run: agent.ts keeps it out of the loop guard and the change tracking, so it is
 * neither counted as a failure or repeat nor as a changed file. Pure: no I/O, no editor access.
 */
import type { ChatMessage } from './llm';
import type { Effort, Mode } from './policy';
import { validateTodos } from './todos';
import { TODO_TOOL } from './agentTools';

/** The infraonAssistant.planFirst setting. */
export type PlanFirstSetting = 'off' | 'max' | 'always';

/** Reads the setting's value, falling back to the default for anything unknown. */
export function parsePlanFirstSetting(v: unknown): PlanFirstSetting {
  return v === 'off' || v === 'always' ? v : 'max';
}

/** Whether plan-first applies to this turn: the setting allows it at this effort, a main agent, not plan mode. */
export function planFirstActive(setting: PlanFirstSetting | undefined, effort: Effort, mode: Mode, subagent: boolean): boolean {
  if (!setting || setting === 'off' || subagent || mode === 'plan') { return false; }
  return setting === 'always' || effort === 'max';
}

/** Whether these messages (the turn so far) contain a valid todo_write call. */
export function hasTodoWrite(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === 'assistant' && (m.tool_calls ?? []).some((tc) => {
    if (tc.function.name !== TODO_TOOL) { return false; }
    try { return !!validateTodos(JSON.parse(tc.function.arguments || '{}')).todos; } catch { return false; }
  }));
}

/** The tool result of a held call. Deliberately not "ERROR…": nothing went wrong, the call was only deferred. */
export function planFirstMessage(tool: string): string {
  return `NOT RUN (plan first): ${tool} was held because you have not written a plan for this task yet. Before changing any file:\n`
    + '1. If you have not read the files you are about to change (and the code that uses them), read them now, batched in one response.\n'
    + `2. Call ${TODO_TOOL} with the concrete steps of the whole task, naming the files each step will change, with the first step in_progress.\n`
    + `3. Then make this change again and continue step by step. This check happens once per request; for a genuinely tiny change, a one- or two-step list is enough.`;
}

/**
 * The gate for one turn. `carriedPlan`: the conversation already had a task list with unfinished steps when the turn
 * started. Decide each call in order; a held round is closed with endRound() so later rounds always run.
 */
export class PlanFirstGate {
  /** 'open' until the first hold; 'holding' for the rest of that response; 'spent' afterwards. */
  private state: 'open' | 'holding' | 'spent' = 'open';

  /** `active`: whether plan-first applies right now (asked per response: the mode can change during a turn). */
  constructor(private readonly active: () => boolean, private readonly carriedPlan: boolean) {}

  /**
   * Whether to hold this call. `isEdit`: the tool changes files and is allowed in the current mode.
   * `turnMessages`: the conversation from the start of this turn, up to (not including) this response.
   * `earlierInResponse`: the calls of this response sent before this one.
   */
  shouldHold(isEdit: boolean, turnMessages: ChatMessage[], earlierInResponse: Array<{ function: { name: string; arguments: string } }>): boolean {
    if (!isEdit || !this.active()) { return false; }
    if (this.state === 'holding') { return true; }
    if (this.state === 'spent') { return false; }
    const planned = this.carriedPlan || hasTodoWrite(turnMessages)
      || hasTodoWrite([{ role: 'assistant', content: null, tool_calls: earlierInResponse.map((c, i) => ({ id: `e${i}`, type: 'function' as const, function: c.function })) }]);
    if (planned) { this.state = 'spent'; return false; }
    this.state = 'holding';
    return true;
  }

  /** The response's calls are all done: a hold in it has used up the gate. */
  endRound(): void { if (this.state === 'holding') { this.state = 'spent'; } }
}
