import { ChatMessage, LlmConfig, LlmFn, StreamResult, ToolCall, ToolSpec } from './llm';
import { contextLimitFromError, isContextLengthError } from './modelInfo';
import { parseTextToolCalls } from './textToolCalls';
import { ApprovalPreview, Tool, ToolKind, fnSpec } from './tool';
import { AgentType, BUILTIN_AGENT_TYPES, DEFAULT_AGENT_TYPE } from './agentTypes';
import { Answers, MAX_OPTIONS, MAX_QUESTIONS, UserQuestion, formatAnswers, validateQuestions } from './questions';
import { MAX_TODOS, TODO_REMINDER_ROUNDS, TodoInput, formatTodos, todoEndReminder, todoReminder, unfinishedTodos, validateTodos } from './todos';
import { SKILL_TOOL, Skill, expandSkill, findSkill, skillToolSpec } from './skills';
import { Effort, Mode, effortParams, isAllowed, requiresApproval } from './policy';
import { BASE_PROMPT, FANOUT_PROMPT, environmentSection } from './prompts';
import { MAX_PARALLEL_TOOLS, Serializer, isReadOnlyCommand, planBatches } from './scheduler';
import { DEFAULT_CONTEXT, DEFAULT_RATIO, SUMMARY_SYSTEM, compactHistory, estimateTokens, pruneToolOutputs, shouldCompact } from './compaction';
import * as path from 'path';
import { FileReadTracker, clipOutput, resolveIn } from './fstools';
import { FileChangeFeed } from './changeJournal';
import { WorkspaceRoot } from './tool';

export interface ApprovalRequest {
  id: string;
  kind: ToolKind;
  name: string;
  detail: string;
  preview?: ApprovalPreview;
  /** Why approval is needed when it is not just the mode (a rule, a server setting, a dangerous command). */
  reason?: string;
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
  /** The agent settled a waiting approval itself (the mode changed so it no longer needs the user): remove the prompt. */
  approvalSettled?(id: string, label: string): void;
  /** Shows clarifying questions; resolves with the answers, or null if the user skipped them. */
  askUser?(id: string, questions: UserQuestion[]): Promise<Answers | null>;
  /** The agent's task list changed (todo_write). */
  todos?(items: TodoInput[]): void;
  /** Messages the user queued while the agent was working were just handed to the model. */
  userInjected?(items: QueuedInput[]): void;
  /** Live progress lines from a running sub-agent, shown inside its task card. */
  subProgress?(parentId: string, text: string): void;
  /** Tokens one model call consumed (prompt + completion), for per-agent monitoring. */
  spent?(tokens: number): void;
  /** End of a turn that changed files: which files, and which checks ran after the last change. */
  verification?(v: { changed: string[]; checks: Array<{ label: string; ok: boolean }> }): void;
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
/** The rules and the mode together: run, ask first, refused by a rule, or not allowed in this mode. */
type Verdict = { effect: 'allow' | 'ask' | 'deny' | 'mode'; reason?: string };
export interface HookOutcome { blocked: boolean; reason?: string; context?: string[] }

/** Optional safety layer around the agent loop: permission rules, hooks, secret masking and auditing. */
export interface AgentGuard {
  /** Turns masked secrets in tool arguments back into real values; throws if the arguments cannot be restored safely. */
  restoreArgs?(args: any, tool?: string): any;
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
  /**
   * The project's own checks (typecheck, lint, tests). When the agent changed files and is about to finish, these run
   * through run_command (same approvals and rules); failures go back to the model to fix before it may finish.
   */
  checks?: () => Promise<CheckCommand[]> | CheckCommand[];
  /** User overrides of the effort level's limits (0 or missing = use the effort level's value). */
  limits?: () => { maxIterations?: number; maxTokens?: number };
  /** Every file change in the workspace, so changes made by shell commands and sub-agents count as changes too. */
  fileChanges?: FileChangeFeed;
  /** All workspace folders (multi-root); the first that equals root is the primary one. */
  roots?: () => WorkspaceRoot[];
}

/** How many times one turn may recover from a reply cut off at the output-token limit. */
export const MAX_CUT_OFF_RECOVERIES = 3;
/** How many times one turn may compact and retry after the model said the request was too long. */
export const MAX_OVERFLOW_RETRIES = 2;
const isJson = (s: string): boolean => { try { JSON.parse(s || '{}'); return true; } catch { return false; } };

/** One project check: a shell command run in the workspace root. */
export interface CheckCommand {
  name: string; command: string; timeoutSeconds: number;
  /** Faster form limited to the changed files: {files} = quoted changed paths, {dirs} = their folders as ./dir. */
  related?: string;
}

/** Documentation, images and similar: changing only these needs no build or test run. */
export const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc|png|jpe?g|gif|svg|ico|webp|pdf)$|(^|\/)(LICENSE|CHANGELOG|AUTHORS|CODEOWNERS|NOTICE)(\.[a-z]+)?$/i;
/** Above this many changed files the related form is no faster than the full run. */
const MAX_RELATED_FILES = 20;

/**
 * The checks to run for these changed files (workspace-relative, forward slashes): none when only documentation
 * changed; the related (faster) form of a check when it has one and few files changed; the full command otherwise.
 */
export function scopeChecks(checks: CheckCommand[], changed: string[]): CheckCommand[] {
  const code = changed.filter((f) => !DOC_FILE.test(f));
  if (changed.length && !code.length) { return []; }
  const local = code.filter((f) => !/^([a-z]:)?\//i.test(f));
  return checks.map((c) => {
    if (!c.related || !local.length || local.length > MAX_RELATED_FILES || local.length !== code.length) { return c; }
    const files = local.map((f) => `"${f}"`).join(' ');
    const goDirs = [...new Set(local.filter((f) => f.endsWith('.go')).map((f) => { const d = path.posix.dirname(f); return d === '.' ? '.' : `./${d}`; }))];
    if (c.related.includes('{dirs}') && !goDirs.length) { return c; }
    return { ...c, command: c.related.replace('{files}', files).replace('{dirs}', goDirs.join(' ')) };
  });
}

/** How many times failing checks may send the agent back to fix them in one turn. */
export const MAX_CHECK_ROUNDS = 2;
const CHECK_OUTPUT_CHARS = 8000;

export function checksPromptSection(checks: CheckCommand[]): string {
  if (!checks.length) { return ''; }
  return `# Project checks
These commands check this project. Run the relevant ones with run_command (pass timeout_seconds) after changing code. They also run automatically when you finish a turn in which you changed files; if one fails you will get its output and must fix the cause.
${checks.map((c) => `- ${c.name}: \`${c.command}\``).join('\n')}`;
}

/** Exit code from run_command output ("[exit 0]" on the last line), or undefined when it did not finish normally. */
export function exitCodeOf(result: string): number | undefined {
  const m = /\[exit (-?\d+)\]\s*$/.exec(result);
  return m ? Number(m[1]) : undefined;
}

const NOT_RUN = /^(DENIED|BLOCKED)/;

/** How a command appears in the verification summary. */
const checkLabel = (command: string): string => (command.length > 60 ? `${command.slice(0, 57)}...` : command);

export interface SpawnRequest {
  parentToolId: string; description: string; prompt: string; type: string; background: boolean;
  settings: RunOptions; signal: AbortSignal;
  /** The parent's conversation so far (used by the "fork" type). */
  history: ChatMessage[];
}
export interface SpawnResult {
  ok: boolean; text: string; agentId?: string;
  /** Absolute paths the sub-agent changed in the parent's workspace (not in a worktree of its own). */
  changed?: string[];
}

export { BASE_PROMPT } from './prompts';

/** Tokens one model call consumed: the gateway's own count, or an estimate when it does not report usage. */
export function tokensSpent(res: Pick<StreamResult, 'usage' | 'content' | 'toolCalls'>, sent: ChatMessage[]): number {
  if (res.usage) { return Math.max(0, (res.usage.prompt || 0) + (res.usage.completion || 0)); }
  return estimateTokens([...sent, { role: 'assistant', content: res.content || null, tool_calls: res.toolCalls?.length ? res.toolCalls : undefined }]);
}

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
- Launch several agents in one turn (multiple tool calls) to run them in parallel. When the user lists several independent tasks, launch one agent per task in the same response; never give two parallel agents edits to the same files.
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

export function buildSystemPrompt(mode: Mode, effort: Effort, root: string, memory: string, activeFile?: string, subagent = false, extra = '', checks = '', roots?: WorkspaceRoot[]): string {
  const hint = effortParams(effort).hint;
  return [
    BASE_PROMPT,
    mode === 'plan' ? PLAN_PROMPT : '',
    subagent ? SUBAGENT_PROMPT : `\n\n${FANOUT_PROMPT}`,
    extra ? `\n\n${extra}` : '',
    hint ? `\n\nEffort guidance: ${hint}` : '',
    `\n\n${environmentSection(root, { platform: process.platform, ...(roots && roots.length > 1 ? { roots } : {}) })}`,
    checks ? `\n\n${checks}` : '',
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
  /**
   * The mode the user has selected right now. When set, a running turn follows it from the next tool call on
   * (instead of the mode the turn started with); call reconsiderApprovals() after it changes.
   */
  liveMode?: () => Mode;
  /** Approvals waiting for the user, by tool call id: each one judges itself again under the current mode. */
  private waiting = new Map<string, () => Promise<void>>();
  /** Which files this agent has read, so edits are based on their current contents. */
  readonly reads = new FileReadTracker();
  /** Absolute paths changed in this agent's last turn (by any of its tools, commands or sub-agents). */
  lastChanged: string[] = [];
  /** Changes made for this agent outside its own tool calls (a background sub-agent), counted in its next turn. */
  private pendingExternal = new Set<string>();

  /** A background sub-agent changed these files: the next turn's checks and summary must include them. */
  markExternalChanges(paths: string[]): void { for (const p of paths) { this.pendingExternal.add(p); } }
  private takePending(): string[] { const out = [...this.pendingExternal]; this.pendingExternal.clear(); return out; }

  constructor(protected deps: AgentDeps) {}

  reset(): void { this.cancel(); this.history = []; this.turnStarts = []; this.reads.clear(); }
  cancel(): void { this.abort?.abort(); }

  /**
   * The user switched modes: every approval still waiting is judged again. One the new mode allows without asking runs
   * now; one the new mode forbids (plan) is refused; rule, protected-path, policy and web asks keep waiting.
   */
  reconsiderApprovals(): void { for (const recheck of [...this.waiting.values()]) { void recheck(); } }

  /** Brings the turn's options up to the user's current mode; returns it. */
  private syncMode(run: RunOptions): Mode {
    const live = this.liveMode?.();
    if (live) { run.mode = live; }
    return run.mode;
  }

  /** What the rules and the mode say about a call. Rule denies and asks hold in every mode; only mode-based asks vary. */
  private async judge(req: ToolRequest): Promise<Verdict> {
    if (!isAllowed(req.mode, req.kind)) { return { effect: 'mode' }; }
    const d = (await this.deps.guard?.decide?.(req)) ?? {};
    if (d.effect === 'deny' || d.effect === 'ask') { return { effect: d.effect, reason: d.reason }; }
    return { effect: d.effect !== 'allow' && requiresApproval(req.mode, req.kind) ? 'ask' : 'allow' };
  }

  /**
   * Asks the user to approve a call, following the live mode: when the mode changes while the call waits (behind
   * another prompt or for the user), it is judged again and runs, or is refused, without asking if the new mode says so.
   * Resolves with true to run it, or with the refusal to return to the model. `req.mode` ends as the mode that decided.
   */
  private async awaitApproval(req: ToolRequest, ask: ApprovalRequest, opts: RunOptions, ui: AgentUi, signal: AbortSignal): Promise<true | string> {
    if (signal.aborted) { return 'DENIED by user.'; }
    const refusal = (v: Verdict, mode: Mode): string => (v.effect === 'mode'
      ? `ERROR: ${req.tool} is not allowed in ${mode} mode.`
      : `DENIED by permission rule${v.reason ? `: ${v.reason}` : '.'}`);
    // It may have waited behind another prompt while the mode changed.
    if (this.syncMode(opts) !== req.mode) {
      req.mode = opts.mode;
      const v = await this.judge(req);
      if (v.effect === 'allow') { return true; }
      if (v.effect !== 'ask') { return refusal(v, req.mode); }
      ask = { ...ask, reason: v.reason };
    }
    return new Promise<true | string>((resolve) => {
      let done = false;
      const settle = (r: true | string, label?: string): void => {
        if (done) { return; }
        done = true;
        this.waiting.delete(ask.id);
        if (label) { ui.approvalSettled?.(ask.id, label); }
        resolve(r);
      };
      this.waiting.set(ask.id, async () => {
        const mode = this.liveMode?.();
        if (done || signal.aborted || !mode || mode === req.mode) { return; }
        let v: Verdict;
        try { v = await this.judge({ ...req, mode }); } catch { return; }
        // Still waiting, the mode did not change again meanwhile, and the new mode decides without the user.
        if (done || this.liveMode?.() !== mode || v.effect === 'ask') { return; }
        req.mode = mode;
        opts.mode = mode;
        if (v.effect === 'allow') { settle(true, `allowed (${mode} mode)`); } else { settle(refusal(v, mode), v.effect === 'mode' ? `not allowed in ${mode} mode` : 'denied by permission rule'); }
      });
      ui.approve(ask).then((ok) => settle(ok ? true : 'DENIED by user.'), () => settle('DENIED by user.'));
    });
  }

  get turnCount(): number { return this.turnStarts.length; }

  private warnedTextCalls = false;

  /** The model's real context limit, learned from a "too long" error (smaller than the configured one). */
  private learnedLimit?: number;

  contextUsage(): { used: number; limit: number } {
    const configured = this.deps.contextLimit?.() ?? DEFAULT_CONTEXT;
    return { used: estimateTokens(this.history), limit: this.learnedLimit ? Math.min(configured, this.learnedLimit) : configured };
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
      // The latest task list survives the summary, so reminders about unfinished steps keep working afterwards.
      const { todos } = this.todoState();
      const carry = todos && unfinishedTodos(todos).length
        ? { call: { id: `todo_carry_${Date.now().toString(36)}`, type: 'function' as const, function: { name: TODO_TOOL, arguments: JSON.stringify({ todos }) } }, result: formatTodos(todos) }
        : undefined;
      const res = await compactHistory(pruned, this.turnStarts, async (text) => {
        const cfg = { ...(await this.deps.getConfig(opts)), temperature: 0.1, maxTokens: 2048 };
        const sent: ChatMessage[] = [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: text }];
        const out = await this.deps.llm(cfg, sent, [], () => {}, signal);
        ui.spent?.(tokensSpent(out, sent));
        return out.content;
      }, carry);
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
    // Files may have changed while the session was closed: everything must be read again before it is edited.
    this.reads.clear();
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
    // The active file goes with the message, not into the system prompt: a system prompt that changes whenever the
    // user switches tabs defeats the server's prefix cache, so every request would re-process the whole conversation.
    const active = this.deps.activeFile?.();
    const content = active ? `${userText}\n\n(Active editor file: ${active})` : userText;
    const shown = display ?? (content !== userText ? userText : undefined);
    this.history.push({ role: 'user', content, ...(shown && shown !== content ? { display: shown } : {}) });
    this.abort = new AbortController();
    const { signal } = this.abort;
    const run: RunOptions = { ...opts };
    const ep = { ...effortParams(run.effort) };
    const limits = this.deps.limits?.() ?? {};
    if (limits.maxIterations && limits.maxIterations > 0) { ep.maxIterations = Math.floor(limits.maxIterations); }
    if (limits.maxTokens && limits.maxTokens > 0) { ep.maxTokens = Math.floor(limits.maxTokens); }

    let stopContinues = 0;
    let checkRounds = 0;
    let cutOffs = 0;
    let overflows = 0;
    /** Tool rounds in this turn, and whether the end-of-turn task-list reminder was sent. */
    let toolRounds = 0;
    let todoEndNudged = false;
    /** Files changed since the checks last ran. */
    let dirty = false;
    this.track = { changed: new Set(), abs: new Set(), verified: [] };
    const feed = this.deps.fileChanges;
    let cursor = feed?.cursor() ?? 0;
    const roots = this.deps.roots?.();
    const early = this.takePending();
    if (early.length) { dirty = true; this.noteChanged(early); }
    try {
      let checks = await this.loadChecks();
      const checksSection = checksPromptSection(checks);
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
        // The user may have switched modes during the last step: the next model call and its tools follow the new one.
        this.syncMode(run);
        await this.compact(opts, ui, false);
        const cfg = { ...(await this.deps.getConfig(opts)), temperature: ep.temperature, maxTokens: ep.maxTokens };
        const memory = (await this.deps.memory?.()) ?? '';
        const system: ChatMessage = {
          role: 'system',
          content: buildSystemPrompt(run.mode, run.effort, this.deps.root, memory, undefined, !!this.deps.subagent, this.deps.extraSystem ?? '', checksSection, roots),
        };
        const specs = this.specsFor(run.mode);
        this.lastContext = measureContext(system.content ?? '', memory, specs);
        let res: StreamResult;
        try {
          res = await this.deps.llm(cfg, [system, ...this.history], specs, (t) => ui.token(t), signal);
        } catch (e) {
          // Too long for the model: learn its real limit from the error, shorten the conversation and try again.
          if (!isContextLengthError(e) || overflows >= MAX_OVERFLOW_RETRIES) { throw e; }
          overflows++;
          const limit = contextLimitFromError(e);
          if (limit) { this.learnedLimit = limit; ep.maxTokens = Math.min(ep.maxTokens, Math.max(1024, Math.floor(limit / 4))); }
          ui.info(`The conversation is too long for the model${limit ? ` (its limit is ${limit} tokens)` : ''}; compacting it and retrying.`);
          await this.compact(opts, ui, true);
          continue;
        }
        ui.spent?.(tokensSpent(res, [system, ...this.history]));
        // A gateway without a tool-call parser returns the calls as text (<tool_call>…): recognize and run them anyway.
        if (!res.toolCalls.length && res.content) {
          const parsed = parseTextToolCalls(res.content, specs.map((sp) => sp.function.name));
          if (parsed) {
            res = { ...res, content: parsed.rest, toolCalls: parsed.calls };
            if (!this.warnedTextCalls) {
              this.warnedTextCalls = true;
              ui.info('The model wrote its tool calls as text; they were recognized and run. For best results, enable tool-call parsing on the LLM gateway (vLLM: --enable-auto-tool-choice --tool-call-parser <name>).');
            }
          }
        }
        // The reply hit the output-token limit: a cut-off tool call has broken arguments, and cut-off text is unfinished.
        if (res.finishReason === 'length' && cutOffs < MAX_CUT_OFF_RECOVERIES) {
          const broken = res.toolCalls.some((tc) => !isJson(tc.function.arguments));
          if (broken || !res.toolCalls.length) {
            cutOffs++;
            this.history.push({ role: 'assistant', content: res.content || (broken ? '(reply cut off while writing a tool call)' : null) });
            this.history.push(broken
              ? { role: 'user', content: `Your last reply was cut off at the output limit (${ep.maxTokens} tokens) while you were writing a tool call, so it was NOT run. Send it again in smaller pieces: for a large file, write_file a first part, then add the rest with edit_file or multi_edit; for many changes, use several smaller calls.`, display: 'Reply cut off: asked to split it up' }
              : { role: 'user', content: 'Your last reply was cut off at the output limit. Continue exactly where you stopped, without repeating what you already wrote.', display: 'Reply cut off: continuing' });
            ui.info(broken ? 'The reply was cut off at the output limit while writing a tool call; asking the model to split it up.' : 'The reply was cut off at the output limit; asking the model to continue.');
            continue;
          }
        }
        this.history.push({ role: 'assistant', content: res.content || null, tool_calls: res.toolCalls.length ? res.toolCalls : undefined });
        if (!res.toolCalls.length) {
          // A message queued during this reply is answered right away, in the same turn.
          if (this.hasQueued()) { continue; }
          // A project created during this turn (no package.json etc. when it started) gets its checks detected now.
          if (dirty && !checks.length) { checks = await this.loadChecks(); }
          const scoped = dirty ? scopeChecks(checks, [...this.track.changed]) : [];
          if (dirty && checks.length && !scoped.length) { dirty = false; ui.info('Only documentation changed: project checks skipped.'); }
          // The model already ran every check after its last change and they passed: no need to run them again.
          if (dirty && this.alreadyVerified(checks, scoped)) { dirty = false; }
          if (dirty && scoped.length && run.mode !== 'plan' && this.toolFor('run_command')) {
            dirty = false;
            const failed = await this.runChecks(scoped, run, ui, signal, turn);
            if (failed) {
              if (checkRounds < MAX_CHECK_ROUNDS) {
                checkRounds++;
                this.history.push({
                  role: 'user',
                  content: `The project checks failed after your changes (automatic check ${checkRounds} of ${MAX_CHECK_ROUNDS}). Read the output, fix the root cause, and do not finish until the checks pass. If the failure is unrelated to your change (it was already failing before), say so instead of changing unrelated code.\n\n### ${failed.name}: \`${failed.command}\`\n${clipOutput(failed.output, CHECK_OUTPUT_CHARS)}`,
                  display: `Checks failed: ${failed.name}`,
                });
                continue;
              }
              ui.info(`Project checks are still failing (${failed.name}: ${failed.command}) after ${MAX_CHECK_ROUNDS} fix attempts. Review the output above.`);
            }
          }
          // Ending a working turn with steps still open leaves the list (and the UI) stuck on a step: ask once to settle it.
          if (!todoEndNudged && toolRounds > 0 && !this.deps.subagent && run.mode !== 'plan') {
            const { todos } = this.todoState();
            if (todos && unfinishedTodos(todos).length) {
              todoEndNudged = true;
              this.history.push({ role: 'user', content: todoEndReminder(todos), display: 'Task list has unfinished steps: asked to update it' });
              continue;
            }
          }
          const stop = await this.deps.guard?.onStop?.(signal);
          if (!stop?.blocked || stopContinues >= MAX_STOP_CONTINUES) { this.reportVerification(ui); return; }
          stopContinues++;
          this.history.push({ role: 'user', content: `A Stop hook asked you to continue: ${stop.reason ?? 'the task is not finished'}`, display: 'Stop hook: continue' });
          continue;
        }
        const exec = (tc: ToolCall) => this.execTool(tc.id, tc.function.name, tc.function.arguments, run, ui, signal, turn);
        for (const batch of planBatches(res.toolCalls, (tc) => this.parallelSafe(tc, run.mode), MAX_PARALLEL_TOOLS)) {
          // Changes from before this batch (the user typing, a background agent) are not this batch's doing.
          if (feed) { cursor = feed.cursor(); }
          const results = batch.length === 1 ? [await exec(batch[0])] : await Promise.all(batch.map(exec));
          const seen = feed ? await feed.changedSince(cursor, batch.some((tc) => this.mayChangeFiles(tc, run.mode))) : undefined;
          if (seen) { cursor = seen.cursor; }
          const external = [...(seen?.paths ?? []), ...this.takePending()];
          if (external.length) { dirty = true; this.noteChanged(external); }
          batch.forEach((tc, j) => {
            this.history.push({ role: 'tool', tool_call_id: tc.id, content: results[j] });
            // A command that changed files (a formatter, a code generator) is a change, not a check.
            if (this.noteResult(tc.function.name, tc.function.arguments, results[j], external.length > 0)) { dirty = true; }
          });
        }
        toolRounds++;
        // The task list went stale (many rounds without todo_write): remind the model inside the last tool result.
        const nudge = this.todoNudge();
        if (nudge) {
          const last = this.history[this.history.length - 1];
          if (last?.role === 'tool') { last.content = `${last.content ?? ''}\n\n${nudge}`; }
        }
      }
      // Hitting the round limit also ends the turn: settle open steps on the next turn, as a normal ending would.
      // The reminder goes into the last tool result (as todoNudge does), so no extra user message is added.
      let openSteps = 0;
      if (!this.deps.subagent && run.mode !== 'plan') {
        const { todos } = this.todoState();
        const last = this.history[this.history.length - 1];
        openSteps = todos ? unfinishedTodos(todos).length : 0;
        if (todos && openSteps && last?.role === 'tool') { last.content = `${last.content ?? ''}\n\n<system-reminder>${todoEndReminder(todos)}</system-reminder>`; }
      }
      ui.info(`Stopped after ${ep.maxIterations} tool rounds${openSteps ? ` with ${openSteps} task step${openSteps === 1 ? '' : 's'} still open` : ''}. Send "continue" to let the agent carry on (or raise Max Iterations in settings).`);
      this.reportVerification(ui);
    } catch (e: any) {
      if (e.message !== 'Cancelled') { throw e; }
      this.closeDanglingToolCalls();
      ui.info('Cancelled.');
    } finally {
      this.lastChanged = [...this.track.abs];
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

  /** What this turn changed, and what was checked after the latest change. */
  private track: { changed: Set<string>; abs: Set<string>; verified: Array<{ label: string; ok: boolean }> } = { changed: new Set(), abs: new Set(), verified: [] };

  /** Files changed by something other than an edit tool (a command, a sub-agent): they count, and reset the evidence. */
  private noteChanged(absPaths: string[]): void {
    for (const abs of absPaths) {
      this.track.abs.add(path.resolve(abs));
      this.track.changed.add(this.displayPath(abs));
    }
    this.track.verified = [];
  }

  /** A path for the summary: relative to the workspace root when inside it, with forward slashes. */
  private displayPath(abs: string): string {
    const rel = path.relative(path.resolve(this.deps.root), path.resolve(abs));
    return (rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs).replace(/\\/g, '/');
  }

  /** Whether running this call can change files in ways the agent does not see directly (commands, sub-agents). */
  private mayChangeFiles(tc: ToolCall, mode: Mode): boolean {
    const name = tc.function.name;
    if (name === AGENT_TOOL) { return true; }
    const tool = this.toolFor(name);
    if (!tool || tool.kind === 'read' || tool.kind === 'meta' || tool.kind === 'edit') { return false; }
    if (name === 'run_command') {
      try { return !isReadOnlyCommand(String(JSON.parse(tc.function.arguments || '{}').command ?? '')); } catch { return true; }
    }
    return isAllowed(mode, tool.kind);
  }

  /** Every project check already ran, and passed, after the last change. */
  private alreadyVerified(checks: CheckCommand[], scoped: CheckCommand[]): boolean {
    const passed = (cmd: string) => this.track.verified.some((v) => v.ok && v.label === checkLabel(cmd));
    // The full command, or its related form for these files, counts.
    return checks.length > 0 && checks.every((c, i) => passed(c.command) || (scoped[i] !== undefined && passed(scoped[i].command)));
  }

  /**
   * Records a tool result for the turn's verification summary. Returns true when it changed a file.
   * A change resets the evidence: only checks that ran after the latest change count.
   */
  private noteResult(name: string, rawArgs: string, result: string, changedFiles = false): boolean {
    if (/^(ERROR|DENIED|BLOCKED)/.test(result)) { return false; }
    let args: any = {};
    try { args = JSON.parse(rawArgs || '{}'); } catch { /* ignore */ }
    if (this.toolFor(name)?.kind === 'edit') {
      if (typeof args.path === 'string' && args.path) {
        const abs = path.resolve(this.deps.root, args.path);
        this.track.abs.add(abs);
        this.track.changed.add(this.displayPath(abs));
      } else { this.track.changed.add(name); }
      this.track.verified = [];
      return true;
    }
    if (name === 'run_command' && typeof args.command === 'string' && !changedFiles) {
      const label = checkLabel(args.command);
      this.track.verified = this.track.verified.filter((v) => v.label !== label);
      this.track.verified.push({ label, ok: exitCodeOf(result) === 0 });
    } else if (name === 'get_diagnostics') {
      this.track.verified = this.track.verified.filter((v) => v.label !== 'diagnostics');
      this.track.verified.push({ label: 'diagnostics', ok: !/\[Error\]/.test(result) });
    }
    return false;
  }

  /** Tells the user, after a turn that changed files, what was checked after the last change, or that nothing was. */
  private reportVerification(ui: AgentUi): void {
    const { changed, verified } = this.track;
    if (!changed.size || this.deps.subagent) { return; }
    const files = `Changed ${changed.size} file${changed.size === 1 ? '' : 's'}`;
    const docsOnly = [...changed].every((f) => DOC_FILE.test(f));
    const summary = verified.length
      ? `${files}. Checked after the last change: ${verified.map((v) => `${v.ok ? '✓' : '✗'} ${v.label}`).join(' · ')}`
      : docsOnly ? `${files} (documentation only; no checks needed).`
        : `${files}. Not verified: no build, test, lint or diagnostics check ran after the last change.`;
    ui.verification?.({ changed: [...changed], checks: verified.map((v) => ({ ...v })) });
    ui.info(summary);
  }

  /** The project's checks; sub-agents skip them (the parent checks the combined result). */
  private async loadChecks(): Promise<CheckCommand[]> {
    if (this.deps.subagent || !this.deps.checks) { return []; }
    try { return (await this.deps.checks()).filter((c) => c && typeof c.command === 'string' && c.command.trim()); } catch { return []; }
  }

  /**
   * Runs the checks in order through run_command, so permission rules, approvals, hooks and the audit log apply.
   * Stops at the first failure and returns it; returns undefined when all pass or the user declined to run them.
   */
  private async runChecks(checks: CheckCommand[], run: RunOptions, ui: AgentUi, signal: AbortSignal, turn: number): Promise<{ name: string; command: string; output: string } | undefined> {
    const passed: string[] = [];
    for (let i = 0; i < checks.length; i++) {
      const c = checks[i];
      const out = await this.execTool(`check_${turn}_${i}_${Date.now().toString(36)}`, 'run_command', JSON.stringify({ command: c.command, timeout_seconds: c.timeoutSeconds }), run, ui, signal, turn);
      this.noteResult('run_command', JSON.stringify({ command: c.command }), out);
      if (NOT_RUN.test(out)) { ui.info(`Project checks skipped (${c.name} was not run).`); return undefined; }
      if (exitCodeOf(out) !== 0) { return { name: c.name, command: c.command, output: out }; }
      passed.push(c.name);
    }
    ui.info(`Project checks passed: ${passed.join(', ')}.`);
    return undefined;
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
        // A foreground sub-agent's changes are this turn's changes: they must be checked before the turn ends.
        if (r.changed?.length) { this.markExternalChanges(r.changed); }
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

  /**
   * The latest valid task list in the conversation and how many tool rounds the model has done since writing it.
   * Read from the history, so it also holds for a restored session.
   */
  todoState(): { todos?: TodoInput[]; rounds: number } {
    let rounds = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i];
      if (m.role !== 'assistant' || !m.tool_calls?.length) { continue; }
      const tc = [...m.tool_calls].reverse().find((c) => c.function.name === TODO_TOOL);
      if (tc) {
        let args: unknown = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* invalid: keep looking further back */ }
        const v = validateTodos(args);
        if (v.todos) { return { todos: v.todos, rounds }; }
      }
      rounds++;
    }
    return { rounds };
  }

  /** A reminder to append to this round's last tool result when the task list has gone stale, else ''. */
  private todoNudge(): string {
    if (this.deps.subagent) { return ''; }
    const { todos, rounds } = this.todoState();
    if (!todos || !unfinishedTodos(todos).length || rounds === 0 || rounds % TODO_REMINDER_ROUNDS !== 0) { return ''; }
    return todoReminder(todos, rounds);
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
    // Every call follows the mode the user has selected now, not the one the turn started with (sub-agents inherit it).
    this.syncMode(opts);
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
    try { if (guard?.restoreArgs) { args = guard.restoreArgs(args, name); } } catch (e: any) { restoreError = e.message ?? String(e); }
    // Multi-root: "<folder name>/path" becomes an absolute path first, so permission rules see the real file.
    const roots = this.deps.roots?.();
    if (roots && roots.length > 1 && args && typeof args === 'object' && typeof args.path === 'string' && args.path && !path.isAbsolute(args.path)) {
      try {
        const abs = resolveIn({ root: this.deps.root, roots }, args.path);
        if (path.relative(this.deps.root, abs).startsWith('..')) { args = { ...args, path: abs }; }
      } catch { /* the tool reports the bad path */ }
    }
    const ctx = {
      root: this.deps.root, roots, signal, reads: this.reads,
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
      let verdict = await this.judge(req);
      if (verdict.effect === 'deny') { return finish(false, `DENIED by permission rule${verdict.reason ? `: ${verdict.reason}` : '.'}`); }
      const pre = await guard?.beforeTool?.(req, signal);
      if (pre?.blocked) { return finish(false, `BLOCKED by hook: ${pre.reason ?? 'no reason given'}`); }
      // The user may have switched modes while the rules and hooks ran: the call follows the new mode.
      if (this.syncMode(opts) !== req.mode) {
        req.mode = opts.mode;
        verdict = await this.judge(req);
        if (verdict.effect === 'deny') { return finish(false, `DENIED by permission rule${verdict.reason ? `: ${verdict.reason}` : '.'}`); }
      }
      if (verdict.effect === 'mode') { return finish(false, `ERROR: ${name} is not allowed in ${req.mode} mode.`); }
      if (verdict.effect === 'ask') {
        guard?.onApproval?.(req, 'asked');
        const ask: ApprovalRequest = { id, kind: tool.kind, name, detail, preview, reason: verdict.reason };
        const out = await raceAbort(this.approvals.run(() => this.awaitApproval(req, ask, opts, ui, signal)), signal);
        guard?.onApproval?.(req, out === true ? 'allowed' : 'denied');
        if (out !== true) { return finish(false, out); }
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
