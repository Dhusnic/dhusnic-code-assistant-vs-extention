import { ToolSpec } from './llm';

export type ToolKind = 'read' | 'edit' | 'exec' | 'meta';

export interface ApprovalPreview { path: string; oldText: string; newText: string }

export interface ToolCtx {
  root: string;
  signal: AbortSignal;
  /** Called before a file is modified so checkpoints can capture the original. */
  snapshot: (absPath: string) => Promise<void>;
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
