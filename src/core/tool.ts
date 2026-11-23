import { ToolSpec } from './llm';
import type { EditDiagnostics } from './editDiagnostics';

export type ToolKind = 'read' | 'edit' | 'exec' | 'meta';

export interface ApprovalPreview { path: string; oldText: string; newText: string }

/** One folder of a (possibly multi-root) VS Code workspace. */
export interface WorkspaceRoot { name: string; path: string }

export interface ToolCtx {
  root: string;
  /** Every workspace folder, the primary one (root) included. Missing or one entry: a single-root workspace. */
  roots?: WorkspaceRoot[];
  signal: AbortSignal;
  /** Called before a file is modified so checkpoints can capture the original. */
  snapshot: (absPath: string) => Promise<void>;
  /** Tracks what the agent has read; edit tools refuse to change a file it has not read, or that changed since. */
  reads?: ReadTracker;
  /** Language-server errors for edited files; edit tools append the errors an edit introduced. Missing: no check. */
  diagnostics?: EditDiagnostics;
  /**
   * Folders outside the workspace that read tools (read_file, list_dir) may open by absolute path, never write:
   * the folders of loaded skills (built-in, personal, team), so the agent can read the references and scripts they ship.
   */
  readOnlyRoots?: string[];
}

export interface ReadTracker {
  markRead(absPath: string): Promise<void>;
  /** An error message when the file exists but was not read, or changed on disk since it was read. */
  check(absPath: string, displayPath: string): Promise<string | undefined>;
  /** The agent itself just wrote the file: its new contents count as read. */
  markWritten(absPath: string): Promise<void>;
}

export interface Tool {
  spec: ToolSpec;
  kind: ToolKind;
  /** One-line human description used in approval prompts and tool cards. */
  describe(args: any): string;
  run(args: any, ctx: ToolCtx): Promise<string>;
  /** Computes what an edit would change, without applying it. Throws on invalid input. */
  preview?(args: any, ctx: ToolCtx): Promise<ApprovalPreview>;
}

export const fnSpec = (name: string, description: string, properties: object, required: string[]): ToolSpec => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
