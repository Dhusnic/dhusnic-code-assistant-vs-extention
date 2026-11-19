import { ChatMessage, LlmConfig, LlmFn, ToolCall, ToolSpec } from './llm';
import { ApprovalPreview, Tool, ToolKind, fnSpec } from './tool';
import { AgentType, BUILTIN_AGENT_TYPES, DEFAULT_AGENT_TYPE } from './agentTypes';
import { Answers, MAX_OPTIONS, MAX_QUESTIONS, UserQuestion, formatAnswers, validateQuestions } from './questions';
import { MAX_TODOS, TodoInput, formatTodos, validateTodos } from './todos';
import { SKILL_TOOL, Skill, expandSkill, findSkill, skillToolSpec } from './skills';
import { Effort, Mode, effortParams, isAllowed, requiresApproval } from './policy';
import { BASE_PROMPT, environmentSection } from './prompts';
import { MAX_PARALLEL_TOOLS, Serializer, isReadOnlyCommand, planBatches } from './scheduler';
import { DEFAULT_CONTEXT, DEFAULT_RATIO, SUMMARY_SYSTEM, compactHistory, estimateTokens, pruneToolOutputs, shouldCompact } from './compaction';

export interface ApprovalRequest {
  id: string;
  kind: ToolKind;
  name: string;
  detail: string;
  preview?: ApprovalPreview;
}

export interface AgentUi {
  token(t: string): void;
  toolStart(id: string, name: string, kind: ToolKind, args: string, detail: string, preview?: ApprovalPreview): void;
  toolEnd(id: string, ok: boolean, result: string): void;
  approve(req: ApprovalRequest): Promise<boolean>;
  info(t: string): void;
  usage?(used: number, limit: number): void;
  /** Shows the proposed plan; resolves to the mode to continue in, or null if the user wants more planning. */
  approvePlan?(id: string, plan: string): Promise<Mode | null>;
  modeChanged?(mode: Mode): void;
  /** Shows clarifying questions; resolves with the answers, or null if the user skipped them. */
  askUser?(id: string, questions: UserQuestion[]): Promise<Answers | null>;
  /** The agent's task list changed (todo_write). */
  todos?(items: TodoInput[]): void;
  /** Messages the user queued while the agent was working were just handed to the model. */
  userInjected?(items: QueuedInput[]): void;
  /** Live progress lines from a running sub-agent, shown inside its task card. */
  subProgress?(parentId: string, text: string): void;
}

export interface RunOptions { mode: Mode; effort: Effort; model: string }

/** A message the user sent while the agent was busy; delivered with the agent's next model call. */
export interface QueuedInput { text: string; display: string; files?: string[]; thumbs?: string[] }

/** Wraps mid-turn user messages so the model knows they arrived while it was working. */
export function queuedMessageText(texts: string[]): string {
  return `The user sent ${texts.length > 1 ? 'these messages' : 'this message'} while you were working:\n${texts.map((t) => `<user-message>\n${t}\n</user-message>`).join('\n')}\n\nTake ${texts.length > 1 ? 'them' : 'it'} into account now: ${texts.length > 1 ? 'they' : 'it'} may add to, change, redirect or cancel the current task. Briefly acknowledge ${texts.length > 1 ? 'them' : 'it'}, then continue with the updated task (or stop if the user asked you to).`;
}

export interface ToolRequest { tool: string; kind: ToolKind; args: any; root: string; mode: Mode }
export interface GuardDecision { effect?: 'allow' | 'ask' | 'deny'; reason?: string }
export interface HookOutcome { blocked: boolean; reason?: string; context?: string[] }

/** Optional safety layer around the agent loop: permission rules, hooks, secret masking and auditing. */
export interface AgentGuard {
  /** Turns masked secrets in tool arguments back into real values; throws if the arguments cannot be restored safely. */
  restoreArgs?(args: any): any;
  decide?(req: ToolRequest): Promise<GuardDecision> | GuardDecision;
  beforeTool?(req: ToolRequest, signal: AbortSignal): Promise<HookOutcome>;
  afterTool?(req: ToolRequest, ok: boolean, result: string, ms: number, signal: AbortSignal): Promise<HookOutcome | void>;
  onApproval?(req: ToolRequest, outcome: 'asked' | 'allowed' | 'denied'): void;
  onPrompt?(text: string, signal: AbortSignal): Promise<HookOutcome>;
  onStop?(signal: AbortSignal): Promise<HookOutcome>;
}

/** How many times a Stop hook may send the agent back to work in one turn. */
const MAX_STOP_CONTINUES = 3;

export interface AgentDeps {
  guard?: AgentGuard;
  root: string;
  llm: LlmFn;
  getConfig: (opts: RunOptions) => Promise<LlmConfig> | LlmConfig;
  tools: () => Tool[];
  memory?: () => Promise<string> | string;
  activeFile?: () => string | undefined;
  snapshot?: (turn: number, absPath: string) => Promise<void>;
  /** Roll workspace files back to before `turn`; returns the restored absolute paths. */
  restore?: (turn: number) => Promise<string[]>;
  contextLimit?: () => number;
  compactRatio?: () => number;
  /** Internal: marks a sub-agent (no further delegation). */
  subagent?: boolean;
  /** Runs a sub-agent through the session runtime (tracked, visible, saved). Without it, sub-agents run inline, read-only. */
  spawn?: (req: SpawnRequest) => Promise<SpawnResult>;
  /** Sends a follow-up message to an existing sub-agent (send_message tool). */
  sendToAgent?: (to: string, message: string) => Promise<SpawnResult>;
  /** Sub-agent types offered to the model (built-ins + .claude/agents definitions). */
  agentTypes?: () => AgentType[];
  /** Extra system instructions, e.g. a sub-agent type's prompt. */
  extraSystem?: string;
  /** Skills (SKILL.md) the agent may load with the skill tool. */
  skills?: () => Skill[];
}

export interface SpawnRequest {
  parentToolId: string; description: string; prompt: string; type: string; background: boolean;
  settings: RunOptions; signal: AbortSignal;
  /** The parent's conversation so far (used by the "fork" type). */
  history: ChatMessage[];
}
export interface SpawnResult { ok: boolean; text: string; agentId?: string }

export { BASE_PROMPT } from './prompts';

/** Claude-style delegation tool: launches a sub-agent (foreground or background). */
export const AGENT_TOOL = 'agent';
export const TASK_TOOL = AGENT_TOOL;
export const SEND_TOOL = 'send_message';
export const DELEGATION_TOOLS = [AGENT_TOOL, SEND_TOOL, 'ask_user_question'];

export function agentToolSpec(types: AgentType[]): ToolSpec {
  const list = types.map((t) => `- ${t.name}: ${t.description}${t.readOnly ? ' (read-only)' : ''}`).join('\n');
  return fnSpec(AGENT_TOOL, `Launch a sub-agent to handle a task autonomously in its own context window. Available agent types:
${list}

How to use it:
- Sub-agents start with an EMPTY context (except "fork"), so put every detail they need in prompt and say exactly what to return.
- Launch several agents in one turn (multiple tool calls) to run them in parallel.
- Set run_in_background to true for long work: the call returns at once and you are notified automatically when the agent finishes. Do not poll, sleep or wait for it; continue with other work or end your turn.
- An agent's final message is its report and is returned only to you; summarize what matters for the user.
- Use send_message to give an existing agent follow-up instructions; it keeps its context.
- Prefer doing small, targeted tasks yourself; delegate broad searches or independent pieces of work.`,
  {
    description: { type: 'string', description: 'Short (3-6 word) title of the task.' },
    prompt: { type: 'string', description: 'The complete task for the agent, including all context it needs and what to report back.' },
    subagent_type: { type: 'string', enum: types.map((t) => t.name), description: `Agent type (default: ${DEFAULT_AGENT_TYPE}).` },
    run_in_background: { type: 'boolean', description: 'Run without waiting; you will be notified when it finishes.' },
  }, ['description', 'prompt']);
}

export const QUESTION_TOOL = 'ask_user_question';
export const QUESTION_SPEC: ToolSpec = fnSpec(QUESTION_TOOL,
  `Ask the user 1-${MAX_QUESTIONS} multiple-choice questions when you are genuinely unsure how to proceed (ambiguous requirements, a choice between approaches, preferences, missing details). The run pauses until the user answers, then continues with the answers as this tool's result.
- Each question has 2-${MAX_OPTIONS} concise options with a short description of the trade-off. Do NOT add an "Other" option: the user can always pick "Other" and type an answer.
- Use multiSelect: true when several options can apply at once.
- If you recommend an option, put it first and end its label with " (Recommended)".
- Ask everything you need in ONE call instead of several in a row. Do not use this for things you can find out by reading the code.`,
  {
    questions: {
      type: 'array', minItems: 1, maxItems: MAX_QUESTIONS,
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The full question, ending with a question mark.' },
          header: { type: 'string', description: 'Very short label shown as a chip (max 12 characters), e.g. "Format".' },
          options: {
            type: 'array', minItems: 2, maxItems: MAX_OPTIONS,
            items: { type: 'object', properties: { label: { type: 'string', description: '1-5 words.' }, description: { type: 'string', description: 'What choosing this means.' } }, required: ['label'] },
          },
          multiSelect: { type: 'boolean', description: 'Allow selecting several options.' },
        },
        required: ['question', 'options'],
      },
    },
  }, ['questions']);

export const TODO_TOOL = 'todo_write';
export const TODO_SPEC: ToolSpec = fnSpec(TODO_TOOL,
  `Create or update your task list for the current work; the user sees it as a live checklist. Send the COMPLETE list every time (it replaces the previous one).
- Use it for tasks with 3 or more steps, and right after a plan is approved (one item per plan step).
- Exactly one step should be in_progress while you work; mark a step completed immediately when it is done.
- content is the step in imperative form ("Fix the login bug"); activeForm is the present-continuous form shown while it runs ("Fixing the login bug").
- At most ${MAX_TODOS} steps. Skip the list for trivial single-step requests.`,
  {
    todos: {
      type: 'array', minItems: 1, maxItems: MAX_TODOS,
      items: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          activeForm: { type: 'string' },
        },
        required: ['content', 'status'],
      },
    },
  }, ['todos']);

export const SEND_SPEC: ToolSpec = fnSpec(SEND_TOOL,
  'Send a follow-up message to an existing sub-agent (by the agent id returned when it was launched). It continues with its context intact and runs in the background; you are notified when it replies.',
  { to: { type: 'string', description: 'Agent id, e.g. "a3".' }, message: { type: 'string', description: 'What the agent should do next.' } }, ['to', 'message']);

const SUBAGENT_PROMPT = `\n\nYou are a SUB-AGENT launched by a parent agent to do one task. Work autonomously: you cannot ask the user questions.
Finish with a concise, factual report: key findings with file:line references, what you changed and how you verified it. Do not include raw dumps of file contents. Your final message is the only thing the parent will see.`;

export const PLAN_TOOL = 'exit_plan_mode';
export const PLAN_SPEC: ToolSpec = fnSpec(PLAN_TOOL,
  'Present your finished plan to the user for approval. Call this once research is complete; only available in plan mode. On approval you leave plan mode and can edit files.',
  { plan: { type: 'string', description: 'The full plan in markdown: numbered steps, files to change, risks, verification.' } }, ['plan']);

const PLAN_PROMPT = `\n\nYou are in PLAN MODE. You may only read and search; you cannot edit files or run commands.
Research the task thoroughly, then call the exit_plan_mode tool with a concrete plan for the user to approve: numbered steps, the files you will change, risks, and how you will verify the result. Do not write the plan only as chat text and do not start implementing until the plan is approved.`;

export function buildSystemPrompt(mode: Mode, effort: Effort, root: string, memory: string, activeFile?: string, subagent = false, extra = ''): string {
  const hint = effortParams(effort).hint;
  return [
    BASE_PROMPT,
    mode === 'plan' ? PLAN_PROMPT : '',
    subagent ? SUBAGENT_PROMPT : '',
    extra ? `\n\n${extra}` : '',
    hint ? `\n\nEffort guidance: ${hint}` : '',
    `\n\n${environmentSection(root, { platform: process.platform })}`,
    activeFile ? `\nActive file: ${activeFile}` : '',
    memory ? `\n\n# Project instructions\n${memory}` : '',
  ].join('');
}

export class Agent {
  history: ChatMessage[] = [];
  /** history index at which each user turn begins */
  turnStarts: number[] = [];
  private abort?: AbortController;
  /** Size of everything sent besides the messages (system prompt, memory, tool definitions), from the last request. */
  lastContext?: ContextOverhead;
  /** Parallel tool calls may each need approval; the user is asked one at a time. */
  private approvals = new Serializer();
  /** Supplies (and removes) messages the user queued while this agent was busy. */
  pendingInput?: () => QueuedInput[];

  constructor(protected deps: AgentDeps) {}

  reset(): void { this.cancel(); this.history = []; this.turnStarts = []; }
  cancel(): void { this.abort?.abort(); }
  get turnCount(): number { return this.turnStarts.length; }

  contextUsage(): { used: number; limit: number } {
    return { used: estimateTokens(this.history), limit: this.deps.contextLimit?.() ?? DEFAULT_CONTEXT };
  }

  /**
   * Keeps the conversation inside the model's context window: first trims old tool output, then (if still
   * too large, or when `force` is set) summarizes everything before the latest turn. Returns true if history changed.
   */
  async compact(opts: RunOptions, ui: AgentUi, force = false): Promise<boolean> {
    const { used, limit } = this.contextUsage();
    const ratio = this.deps.compactRatio?.() ?? DEFAULT_RATIO;
    if (!force && !shouldCompact(used, limit, ratio)) { ui.usage?.(used, limit); return false; }

    const pruned = pruneToolOutputs(this.history, force ? 4 : 8);
    if (!force && !shouldCompact(estimateTokens(pruned), limit, ratio)) {
      this.history = pruned;
      ui.usage?.(estimateTokens(pruned), limit);
      return true;
    }
    const signal = this.abort?.signal ?? new AbortController().signal;
    try {
      const res = await compactHistory(pruned, this.turnStarts, async (text) => {
        const cfg = { ...(await this.deps.getConfig(opts)), temperature: 0.1, maxTokens: 2048 };
        const out = await this.deps.llm(cfg, [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: text }], [], () => {}, signal);
        return out.content;
      });
      this.history = res.summarized ? res.history : pruneToolOutputs(this.history, 2, 600);
      if (res.summarized) { this.turnStarts = res.turnStarts; }
    } catch (e: any) {
      if (e.message === 'Cancelled') { throw e; }
      this.history = pruneToolOutputs(this.history, 2, 600);
      ui.info(`Could not summarize the conversation (${e.message}); trimmed old tool output instead.`);
    }
    const after = estimateTokens(this.history);
    ui.info(`Conversation compacted to save context (~${Math.round(used / 1000)}k → ~${Math.round(after / 1000)}k tokens).`);
    ui.usage?.(after, limit);
    return after < used;
  }

  /** Claude-style context breakdown for the UI: what fills the window, the auto-compact buffer and free space. */
  contextBreakdown(limit: number, ratio: number): ContextBreakdown {
    const o = this.lastContext ?? { system: 0, memory: 0, tools: 0, mcpTools: 0, agentTools: 0, toolCount: 0, mcpCount: 0 };
    const by = { user: 0, assistant: 0, tool: 0 } as Record<'user' | 'assistant' | 'tool', number>;
    const count = { user: 0, assistant: 0, tool: 0, toolCalls: 0 };
    for (const m of this.history) {
      if (m.role === 'system') { continue; }
      by[m.role] += estimateTokens([m]);
      count[m.role]++;
      count.toolCalls += m.tool_calls?.length ?? 0;
    }
    const messages = by.user + by.assistant + by.tool;
    const used = o.system + o.memory + o.tools + o.mcpTools + o.agentTools + messages;
    const buffer = Math.round(limit * (1 - ratio));
    return {
      limit, used, ratio, measured: !!this.lastContext,
      categories: [
        { key: 'system', label: 'System prompt', tokens: o.system },
        { key: 'tools', label: `Tools (${o.toolCount})`, tokens: o.tools },
        { key: 'mcp', label: `MCP tools (${o.mcpCount})`, tokens: o.mcpTools },
        { key: 'agents', label: 'Agents & delegation', tokens: o.agentTools },
        { key: 'memory', label: 'Memory files', tokens: o.memory },
        { key: 'messages', label: 'Messages', tokens: messages },
        { key: 'buffer', label: 'Autocompact buffer', tokens: buffer },
        { key: 'free', label: 'Free space', tokens: Math.max(0, limit - used - buffer) },
      ],
      messages: { userTokens: by.user, assistantTokens: by.assistant, toolResultTokens: by.tool, userCount: count.user, assistantCount: count.assistant, toolResults: count.tool, toolCalls: count.toolCalls, turns: this.turnCount },
    };
  }

  exportState(): { history: ChatMessage[]; turnStarts: number[] } {
    return { history: this.history, turnStarts: this.turnStarts };
  }

  /** Restores a saved conversation; repairs any tool call left unanswered by a crash or cancel. */
  loadState(state: { history: ChatMessage[]; turnStarts: number[] }): void {
    this.cancel();
    this.history = [...state.history];
    this.turnStarts = [...state.turnStarts];
    this.closeDanglingToolCalls();
  }

  /** Rewinds the conversation and (if checkpoints are wired) the files to before `turn`. */
  async rewind(turn: number): Promise<string[]> {
    if (turn < 0 || turn >= this.turnStarts.length) { throw new Error(`No such turn: ${turn}`); }
    this.cancel();
    const files = (await this.deps.restore?.(turn)) ?? [];
    this.history.length = this.turnStarts[turn];
    this.turnStarts.length = turn;
    return files;
  }

  protected toolFor(name: string): Tool | undefined { return this.deps.tools().find((t) => t.spec.function.name === name); }

  protected specsFor(mode: Mode): ToolSpec[] {
    const specs = this.deps.tools().filter((t) => isAllowed(mode, t.kind)).map((t) => t.spec);
    const delegation = this.deps.subagent ? [] : [
      agentToolSpec(this.deps.agentTypes?.() ?? BUILTIN_AGENT_TYPES.filter((t) => t.readOnly)),
      ...(this.deps.sendToAgent ? [SEND_SPEC] : []),
      QUESTION_SPEC,
    ];
    const skill = this.deps.skills ? skillToolSpec(this.deps.skills()) : undefined;
    return [...specs, TODO_SPEC, ...(skill ? [skill] : []), ...delegation, ...(mode === 'plan' ? [PLAN_SPEC] : [])];
  }

  /** `display` is the text shown in the UI when `userText` was expanded (e.g. @file attachments). */
  async send(userText: string, opts: RunOptions, ui: AgentUi, display?: string): Promise<void> {
    this.turnStarts.push(this.history.length);
    const turn = this.turnStarts.length - 1;
    this.history.push({ role: 'user', content: userText, ...(display && display !== userText ? { display } : {}) });
    this.abort = new AbortController();
    const { signal } = this.abort;
    const run: RunOptions = { ...opts };
    const ep = effortParams(run.effort);

    let stopContinues = 0;
    try {
      const submitted = await this.deps.guard?.onPrompt?.(userText, signal);
      if (submitted?.blocked) {
        const text = `Blocked by a hook: ${submitted.reason ?? 'no reason given'}`;
        this.history.push({ role: 'assistant', content: text });
        ui.info(text);
        return;
      }
      if (submitted?.context?.length) {
        const last = this.history[this.history.length - 1];
        last.content = `${last.content}\n\n${submitted.context.join('\n')}`;
      }
      for (let i = 0; i < ep.maxIterations; i++) {
        this.injectQueued(ui);
        await this.compact(opts, ui, false);
        const cfg = { ...(await this.deps.getConfig(opts)), temperature: ep.temperature, maxTokens: ep.maxTokens };
        const memory = (await this.deps.memory?.()) ?? '';
        const system: ChatMessage = {
          role: 'system',
          content: buildSystemPrompt(run.mode, run.effort, this.deps.root, memory, this.deps.activeFile?.(), !!this.deps.subagent, this.deps.extraSystem ?? ''),
        };
        const specs = this.specsFor(run.mode);
        this.lastContext = measureContext(system.content ?? '', memory, specs);
        const res = await this.deps.llm(cfg, [system, ...this.history], specs, (t) => ui.token(t), signal);
        this.history.push({ role: 'assistant', content: res.content || null, tool_calls: res.toolCalls.length ? res.toolCalls : undefined });
        if (!res.toolCalls.length) {
          // A message queued during this reply is answered right away, in the same turn.
          if (this.hasQueued()) { continue; }
          const stop = await this.deps.guard?.onStop?.(signal);
          if (!stop?.blocked || stopContinues >= MAX_STOP_CONTINUES) { return; }
          stopContinues++;
          this.history.push({ role: 'user', content: `A Stop hook asked you to continue: ${stop.reason ?? 'the task is not finished'}`, display: 'Stop hook: continue' });
          continue;
        }
        const exec = (tc: ToolCall) => this.execTool(tc.id, tc.function.name, tc.function.arguments, run, ui, signal, turn);
        for (const batch of planBatches(res.toolCalls, (tc) => this.parallelSafe(tc, run.mode), MAX_PARALLEL_TOOLS)) {
          const results = batch.length === 1 ? [await exec(batch[0])] : await Promise.all(batch.map(exec));
          batch.forEach((tc, j) => this.history.push({ role: 'tool', tool_call_id: tc.id, content: results[j] }));
        }
      }
      ui.info(`Stopped after ${ep.maxIterations} tool rounds.`);
    } catch (e: any) {
      if (e.message !== 'Cancelled') { throw e; }
      this.closeDanglingToolCalls();
      ui.info('Cancelled.');
    } finally {
      const u = this.contextUsage();
      ui.usage?.(u.used, u.limit);
    }
  }

  /**
   * Whether a call may run at the same time as its neighbours from the same response: it must not change
   * anything (reads, searches, read-only MCP tools, read-only shell commands) or be a sub-agent launch.
   * Edits, other commands, questions and plan/todo updates run alone, in the order the model sent them.
   */
  protected parallelSafe(tc: ToolCall, mode: Mode): boolean {
    const name = tc.function.name;
    if (name === AGENT_TOOL || name === SKILL_TOOL) { return true; }
    const tool = this.toolFor(name);
    if (!tool || !isAllowed(mode, tool.kind)) { return false; }
    if (tool.kind === 'read') { return true; }
    if (name !== 'run_command') { return false; }
    try { return isReadOnlyCommand(String(JSON.parse(tc.function.arguments || '{}').command ?? '')); } catch { return false; }
  }

  private hasQueued(): boolean {
    const items = this.pendingInput?.() ?? [];
    if (!items.length) { return false; }
    this.queuedBuffer.push(...items);
    return true;
  }

  private queuedBuffer: QueuedInput[] = [];

  /** Appends messages the user sent mid-turn after the latest tool results, so the next model call sees them. */
  private injectQueued(ui: AgentUi): void {
    const items = [...this.queuedBuffer.splice(0), ...(this.pendingInput?.() ?? [])];
    if (!items.length) { return; }
    this.history.push({ role: 'user', content: queuedMessageText(items.map((q) => q.text)), display: items.map((q) => q.display).join('\n\n') });
    ui.userInjected?.(items);
  }

  /** After a cancel, every assistant tool_call must still have a tool reply or the next request is invalid. */
  private closeDanglingToolCalls(): void {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i];
      if (m.role !== 'assistant') { continue; }
      const answered = new Set(this.history.slice(i + 1).filter((x) => x.role === 'tool').map((x) => x.tool_call_id));
      for (const tc of m.tool_calls ?? []) {
        if (!answered.has(tc.id)) { this.history.push({ role: 'tool', tool_call_id: tc.id, content: 'Cancelled by user.' }); }
      }
      return;
    }
  }

  /** The agent tool: hands the task to the session runtime (tracked sub-agent), or runs it inline as a fallback. */
  private async execTask(id: string, rawArgs: string, run: RunOptions, ui: AgentUi, signal: AbortSignal): Promise<string> {
    let args: { description?: string; prompt?: string; subagent_type?: string; run_in_background?: boolean } = {};
    try { args = JSON.parse(rawArgs || '{}'); } catch { /* reported below */ }
    const title = String(args.description ?? 'Sub-agent task').trim() || 'Sub-agent task';
    const type = typeof args.subagent_type === 'string' && args.subagent_type.trim() ? args.subagent_type.trim() : DEFAULT_AGENT_TYPE;
    const background = args.run_in_background === true;
    ui.toolStart(id, AGENT_TOOL, 'meta', rawArgs, `Agent (${type}): ${title}${background ? ' · background' : ''}`);
    const finish = (ok: boolean, text: string): string => { ui.toolEnd(id, ok, text.slice(0, 4000)); return text; };
    const prompt = String(args.prompt ?? '').trim();
    if (this.deps.subagent) { return finish(false, 'ERROR: sub-agents cannot start further sub-agents.'); }
    if (!prompt) { return finish(false, 'ERROR: prompt must be a non-empty string.'); }
    if (this.deps.spawn) {
      try {
        const r = await this.deps.spawn({ parentToolId: id, description: title, prompt, type, background, settings: { ...run }, signal, history: this.history });
        return finish(r.ok, r.text);
      } catch (e: any) {
        if (e.message === 'Cancelled') { ui.toolEnd(id, false, 'Cancelled'); throw e; }
        return finish(false, `ERROR: ${e.message ?? e}`);
      }
    }

    const child = new Agent({
      ...this.deps, subagent: true, snapshot: undefined, restore: undefined, spawn: undefined, sendToAgent: undefined,
      extraSystem: 'You have read-only tools: you cannot modify files or run commands.',
      tools: () => this.deps.tools().filter((t) => t.kind === 'read'),
    });
    const childUi: AgentUi = {
      token: () => {}, info: () => {}, approve: async () => false,
      toolStart: (_i, _n, _k, _a, detail) => ui.subProgress?.(id, detail),
      toolEnd: () => {},
    };
    const onAbort = () => child.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const effort = run.effort === 'max' ? 'high' : run.effort;
      await raceAbort(child.send(prompt, { mode: 'auto', effort, model: run.model }, childUi), signal);
      const last = child.history[child.history.length - 1];
      const report = last?.role === 'assistant' && last.content ? last.content.trim() : '';
      return report ? finish(true, report) : finish(false, 'The sub-agent finished without a final report (it may have hit its step limit). Try a narrower task.');
    } catch (e: any) {
      if (e.message === 'Cancelled') { ui.toolEnd(id, false, 'Cancelled'); throw e; }
      return finish(false, `ERROR: sub-agent failed: ${e.message ?? e}`);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** skill: returns a skill's full instructions for the model to follow (Claude-style progressive loading). */
  private execSkill(id: string, rawArgs: string, ui: AgentUi): string {
    let args: { name?: string; args?: string } = {};
    try { args = JSON.parse(rawArgs || '{}'); } catch { /* reported below */ }
    const name = String(args.name ?? '').trim();
    ui.toolStart(id, SKILL_TOOL, 'meta', rawArgs, `Using skill: ${name || '?'}`);
    const finish = (ok: boolean, text: string): string => { ui.toolEnd(id, ok, ok ? `Loaded skill "${name}"` : text); return text; };
    const all = this.deps.skills?.() ?? [];
    const s = findSkill(all, name);
    if (!s) { return finish(false, `ERROR: no skill named "${name}". Available: ${all.filter((x) => x.modelInvocable).map((x) => x.name).join(', ') || 'none'}.`); }
    if (!s.modelInvocable) { return finish(false, `ERROR: the skill "${s.name}" can only be started by the user (/${s.name}). Tell the user they can run it.`); }
    return finish(true, `Skill "${s.name}" loaded. Follow these instructions to complete the user's request:\n\n${expandSkill(s, String(args.args ?? ''))}`);
  }

  /** todo_write: replaces the task list shown to the user. */
  private execTodo(id: string, rawArgs: string, ui: AgentUi): string {
    let args: unknown = {};
    try { args = JSON.parse(rawArgs || '{}'); } catch { /* reported below */ }
    const v = validateTodos(args);
    ui.toolStart(id, TODO_TOOL, 'meta', rawArgs, 'Updated the task list');
    const finish = (ok: boolean, text: string): string => { ui.toolEnd(id, ok, text); return text; };
    if (!v.todos) { return finish(false, `ERROR: ${v.error}. Send the full corrected list to ${TODO_TOOL}.`); }
    ui.todos?.(v.todos);
    return finish(true, formatTodos(v.todos));
  }

  /** ask_user_question: pauses the run until the user answers (or skips), then returns the answers. */
  private async execQuestion(id: string, rawArgs: string, ui: AgentUi, signal: AbortSignal): Promise<string> {
    let args: unknown = {};
    try { args = JSON.parse(rawArgs || '{}'); } catch { /* reported below */ }
    const v = validateQuestions(args);
    const n = v.questions?.length ?? 0;
    ui.toolStart(id, QUESTION_TOOL, 'meta', rawArgs, n ? `Asked you ${n} question${n === 1 ? '' : 's'}` : 'Question');
    const finish = (ok: boolean, text: string): string => { ui.toolEnd(id, ok, text.slice(0, 4000)); return text; };
    if (this.deps.subagent) { return finish(false, 'ERROR: sub-agents cannot ask the user. Make a reasonable assumption and state it in your report.'); }
    if (!v.questions) { return finish(false, `ERROR: ${v.error}. Fix the questions and call ${QUESTION_TOOL} again.`); }
    if (!ui.askUser) { return finish(false, 'ERROR: questions are not supported here; continue with your best judgement and state your assumptions.'); }
    let answers: Answers | null;
    try { answers = await raceAbort(ui.askUser(id, v.questions), signal); } catch (e: any) {
      if (e.message === 'Cancelled') { ui.toolEnd(id, false, 'Cancelled'); }
      throw e;
    }
    return finish(!!answers, formatAnswers(v.questions, answers));
  }

  /** The send_message tool: continues an existing sub-agent with a follow-up instruction. */
  private async execSend(id: string, rawArgs: string, ui: AgentUi): Promise<string> {
    let args: { to?: string; message?: string } = {};
    try { args = JSON.parse(rawArgs || '{}'); } catch { /* reported below */ }
    const to = String(args.to ?? '').trim();
    ui.toolStart(id, SEND_TOOL, 'meta', rawArgs, `Message → ${to || '?'}`);
    const finish = (ok: boolean, text: string): string => { ui.toolEnd(id, ok, text.slice(0, 4000)); return text; };
    if (this.deps.subagent || !this.deps.sendToAgent) { return finish(false, 'ERROR: send_message is not available here.'); }
    if (!to || !String(args.message ?? '').trim()) { return finish(false, 'ERROR: "to" and "message" are required.'); }
    try {
      const r = await this.deps.sendToAgent(to, String(args.message));
      return finish(r.ok, r.text);
    } catch (e: any) { return finish(false, `ERROR: ${e.message ?? e}`); }
  }

  /** Handles exit_plan_mode. `run` is the per-turn options object, mutated on approval so the next LLM call uses the new mode. */
  private async execPlan(id: string, rawArgs: string, run: RunOptions, ui: AgentUi, signal: AbortSignal): Promise<string> {
    let plan = '';
    try { plan = String(JSON.parse(rawArgs || '{}').plan ?? '').trim(); } catch { /* reported below */ }
    ui.toolStart(id, PLAN_TOOL, 'meta', rawArgs, 'Present plan for approval');
    const finish = (ok: boolean, text: string): string => { ui.toolEnd(id, ok, text); return text; };
    if (run.mode !== 'plan') { return finish(false, `ERROR: ${PLAN_TOOL} is only available in plan mode.`); }
    if (!plan) { return finish(false, 'ERROR: plan must be a non-empty markdown string.'); }
    if (!ui.approvePlan) { return finish(false, 'DENIED: plan approval is not available in this client.'); }
    let decision: Mode | null;
    try { decision = await raceAbort(ui.approvePlan(id, plan), signal); } catch (e: any) {
      if (e.message === 'Cancelled') { ui.toolEnd(id, false, 'Cancelled'); }
      throw e;
    }
    if (!decision || decision === 'plan') {
      return finish(false, 'The user did not approve the plan yet. Stay in plan mode: ask what to change or revise the plan, then call exit_plan_mode again.');
    }
    run.mode = decision;
    ui.modeChanged?.(decision);
    return finish(true, `The user approved the plan. You are now in "${decision}" mode and may edit files and run commands. First turn the plan into a task list with todo_write (one step per plan step, the first one in_progress), then implement it step by step, updating the list as you go.`);
  }

  protected async execTool(
    id: string, name: string, rawArgs: string, opts: RunOptions, ui: AgentUi, signal: AbortSignal, turn: number,
  ): Promise<string> {
    if (name === PLAN_TOOL) { return this.execPlan(id, rawArgs, opts, ui, signal); }
    if (name === AGENT_TOOL) { return this.execTask(id, rawArgs, opts, ui, signal); }
    if (name === SEND_TOOL) { return this.execSend(id, rawArgs, ui); }
    if (name === QUESTION_TOOL) { return this.execQuestion(id, rawArgs, ui, signal); }
    if (name === TODO_TOOL) { return this.execTodo(id, rawArgs, ui); }
    if (name === SKILL_TOOL && this.deps.skills) { return this.execSkill(id, rawArgs, ui); }
    const tool = this.toolFor(name);
    if (!tool) { ui.toolStart(id, name, 'exec', rawArgs, name); ui.toolEnd(id, false, `unknown tool ${name}`); return `ERROR: unknown tool ${name}`; }
    let args: any;
    try { args = JSON.parse(rawArgs || '{}'); } catch {
      ui.toolStart(id, name, tool.kind, rawArgs, name);
      ui.toolEnd(id, false, 'invalid JSON arguments');
      return 'ERROR: tool arguments were not valid JSON.';
    }
    const guard = this.deps.guard;
    let restoreError: string | undefined;
    try { if (guard?.restoreArgs) { args = guard.restoreArgs(args); } } catch (e: any) { restoreError = e.message ?? String(e); }
    const ctx = {
      root: this.deps.root, signal,
      snapshot: (abs: string) => this.deps.snapshot?.(turn, abs) ?? Promise.resolve(),
    };
    const allowed = isAllowed(opts.mode, tool.kind);
    let preview: ApprovalPreview | undefined;
    let previewError: string | undefined;
    if (allowed && !restoreError && tool.preview) {
      try { preview = await tool.preview(args, ctx); } catch (e: any) { previewError = e.message ?? String(e); }
    }
    const detail = relativizePaths(tool.describe(args), this.deps.root);
    if (preview) { preview = { ...preview, path: relativizePaths(preview.path, this.deps.root) }; }
    ui.toolStart(id, name, tool.kind, rawArgs, detail, preview);
    const finish = (ok: boolean, text: string): string => { ui.toolEnd(id, ok, text.slice(0, 4000)); return text; };

    if (!allowed) { return finish(false, `ERROR: ${name} is not allowed in ${opts.mode} mode.`); }
    if (restoreError) { return finish(false, `ERROR: ${restoreError}`); }
    if (previewError) { return finish(false, `ERROR: ${previewError}`); }
    const req: ToolRequest = { tool: name, kind: tool.kind, args, root: this.deps.root, mode: opts.mode };
    const started = Date.now();
    try {
      // Deny rules are checked first and cannot be overridden by the mode, a hook or an approval.
      const decision = (await guard?.decide?.(req)) ?? {};
      if (decision.effect === 'deny') { return finish(false, `DENIED by permission rule${decision.reason ? `: ${decision.reason}` : '.'}`); }
      const pre = await guard?.beforeTool?.(req, signal);
      if (pre?.blocked) { return finish(false, `BLOCKED by hook: ${pre.reason ?? 'no reason given'}`); }
      const ask = decision.effect === 'ask' || (decision.effect !== 'allow' && requiresApproval(opts.mode, tool.kind));
      if (ask) {
        guard?.onApproval?.(req, 'asked');
        const ok = await raceAbort(this.approvals.run(async () => (signal.aborted ? false : ui.approve({ id, kind: tool.kind, name, detail, preview }))), signal);
        guard?.onApproval?.(req, ok ? 'allowed' : 'denied');
        if (!ok) { return finish(false, 'DENIED by user.'); }
      }
      const result = await tool.run(args, ctx);
      const post = await guard?.afterTool?.(req, true, result, Date.now() - started, signal);
      const notes = [...(post?.context ?? []), ...(post?.blocked ? [`A PostToolUse hook reported a problem: ${post.reason ?? 'no reason given'}`] : [])];
      return finish(true, notes.length ? `${result}\n\n${notes.join('\n')}` : result);
    } catch (e: any) {
      if (e.message === 'Cancelled') { ui.toolEnd(id, false, 'Cancelled'); throw e; }
      await guard?.afterTool?.(req, false, String(e.message ?? e), Date.now() - started, signal)?.catch(() => undefined);
      return finish(false, `ERROR: ${e.message ?? e}`);
    }
  }
}

/** Shows paths under the workspace relative to it ("C:\\repo\\src\\a.ts" → "src\\a.ts"), whichever slash style the model used. */
export function relativizePaths(text: string, root: string): string {
  if (!root || !text) { return text; }
  const base = root.replace(/[\\/]+$/, '');
  const variants = new Set([base, base.replace(/\\/g, '/'), base.replace(/\//g, '\\')]);
  let out = text;
  for (const v of variants) {
    const re = new RegExp(`${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]`, process.platform === 'win32' ? 'gi' : 'g');
    out = out.replace(re, '');
  }
  return out;
}

export interface ContextOverhead { system: number; memory: number; tools: number; mcpTools: number; agentTools: number; toolCount: number; mcpCount: number }
export interface ContextBreakdown {
  limit: number; used: number; ratio: number; measured: boolean;
  categories: Array<{ key: string; label: string; tokens: number }>;
  messages: { userTokens: number; assistantTokens: number; toolResultTokens: number; userCount: number; assistantCount: number; toolResults: number; toolCalls: number; turns: number };
}

const tok = (s: string): number => Math.ceil(s.length / 3.5);

/** Token estimate of everything in a request apart from the conversation messages. */
export function measureContext(systemPrompt: string, memory: string, specs: ToolSpec[]): ContextOverhead {
  const isMcp = (sp: ToolSpec) => sp.function.name.startsWith('mcp__');
  const isAgent = (sp: ToolSpec) => DELEGATION_TOOLS.includes(sp.function.name) || sp.function.name === PLAN_TOOL;
  const size = (list: ToolSpec[]) => (list.length ? tok(JSON.stringify(list)) : 0);
  const builtin = specs.filter((sp) => !isMcp(sp) && !isAgent(sp));
  const mcp = specs.filter(isMcp);
  return {
    system: Math.max(0, tok(systemPrompt) - tok(memory)), memory: memory ? tok(memory) : 0,
    tools: size(builtin), mcpTools: size(mcp), agentTools: size(specs.filter(isAgent)),
    toolCount: builtin.length, mcpCount: mcp.length,
  };
}

/** Rejects with Error('Cancelled') as soon as the signal aborts, so a pending prompt can never hang a cancelled run. */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Cancelled')); return; }
    signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
    p.then(resolve, reject);
  });
}
