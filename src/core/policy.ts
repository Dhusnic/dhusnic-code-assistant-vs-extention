import { ToolKind } from './tool';

export type Mode = 'ask' | 'auto-edit' | 'auto' | 'plan';
export type Effort = 'low' | 'medium' | 'high' | 'max';

export const MODES: Mode[] = ['ask', 'auto-edit', 'auto', 'plan'];
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'max'];

export const MODE_INFO: Record<Mode, { label: string; description: string }> = {
  ask: { label: 'Ask before edits', description: 'Approve every file edit and command' },
  'auto-edit': { label: 'Edit automatically', description: 'Apply file edits freely; ask before commands' },
  auto: { label: 'Auto-execute', description: 'Edit files and run commands without asking' },
  plan: { label: 'Plan mode', description: 'Read-only research, then propose a plan to approve' },
};

export const EFFORT_INFO: Record<Effort, { label: string; description: string }> = {
  low: { label: 'Low', description: 'Fast answers, minimal exploration' },
  medium: { label: 'Medium', description: 'Balanced (default)' },
  high: { label: 'High', description: 'Thorough exploration and verification' },
  max: { label: 'Max', description: 'Exhaustive, longest-running' },
};

export interface EffortParams { temperature: number; maxTokens: number; maxIterations: number; hint: string }

export function effortParams(effort: Effort): EffortParams {
  switch (effort) {
    case 'low': return { temperature: 0.1, maxTokens: 2048, maxIterations: 8, hint: 'Be fast and concise. Explore only what is strictly necessary.' };
    case 'high': return { temperature: 0.2, maxTokens: 8192, maxIterations: 40, hint: 'Explore thoroughly, reason step by step, and verify your changes (run tests or check diagnostics) before finishing.' };
    case 'max': return { temperature: 0.3, maxTokens: 16384, maxIterations: 60, hint: 'Be exhaustive: investigate broadly, consider edge cases, verify with tests and diagnostics, and re-check your work before finishing.' };
    default: return { temperature: 0.2, maxTokens: 4096, maxIterations: 25, hint: '' };
  }
}

export function isMode(v: unknown): v is Mode { return typeof v === 'string' && (MODES as string[]).includes(v); }
export function isEffort(v: unknown): v is Effort { return typeof v === 'string' && (EFFORTS as string[]).includes(v); }

/** Plan mode forbids anything that mutates the workspace or runs code. */
export function isAllowed(mode: Mode, kind: ToolKind): boolean {
  return !(mode === 'plan' && (kind === 'edit' || kind === 'exec'));
}

export function requiresApproval(mode: Mode, kind: ToolKind): boolean {
  if (kind === 'read' || kind === 'meta') { return false; }
  if (mode === 'auto') { return false; }
  if (mode === 'auto-edit') { return kind === 'exec'; }
  return true;
}
