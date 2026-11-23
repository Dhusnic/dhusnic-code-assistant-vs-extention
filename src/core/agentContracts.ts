/**
 * The interfaces between the agent loop and everything around it: the UI that shows a run, the safety layer that
 * guards each tool call, the dependencies the host injects, and sub-agent spawning. Kept apart from agent.ts so the
 * host and the tests can depend on the contracts without reading the loop. agent.ts re-exports all of it.
 */
import type { ChatMessage, LlmConfig, LlmFn, ToolCallProgress } from './llm';
import type { ApprovalPreview, Tool, ToolKind, WorkspaceRoot } from './tool';
import type { AgentType } from './agentTypes';
import type { Answers, UserQuestion } from './questions';
import type { TodoInput } from './todos';
import type { Skill } from './skills';
import type { Effort, Mode } from './policy';
import type { FileChangeFeed } from './changeJournal';
import type { CheckCommand } from './checks';
import type { EditDiagnostics } from './editDiagnostics';
import type { SelfReviewSetting } from './selfReview';
import type { PlanFirstSetting } from './planFirst';

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
  /** The model is still writing a tool call (e.g. a large write_file): its name, size so far and target path. */
  toolWriting?(p: ToolCallProgress): void;
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

export interface ToolRequest { tool: string; kind: ToolKind; args: any; root: string; mode: Mode }
export interface GuardDecision { effect?: 'allow' | 'ask' | 'deny'; reason?: string }
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
  /** The editor's diagnostics, so edit tools can report the errors an edit introduced (see editDiagnostics.ts). */
  diagnostics?: EditDiagnostics;
  /** infraonAssistant.selfReview: review the turn's diff with a fresh model call before finishing (selfReview.ts). Missing = off. */
  selfReview?: () => SelfReviewSetting;
  /** infraonAssistant.planFirst: hold the turn's first file change until a task list exists (planFirst.ts). Missing = off. */
  planFirst?: () => PlanFirstSetting;
  /** A file's content before `turn` changed it (its checkpoint backup); undefined when the turn did not capture it. */
  original?: (turn: number, absPath: string) => Promise<{ existed: boolean; data?: Buffer } | undefined>;
  /** Repo map section for the system prompt (repoMap.ts), fetched once per turn; '' when off or not built yet. */
  repoMap?: () => Promise<string> | string;
}

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
