import * as path from 'path';
import { IgnoreMatcher, SKIP_DIRS } from './glob';

/**
 * Every file change in the workspace, from any source: the agent's edit tools, shell commands (code generators,
 * formatters, sed, package managers), sub-agents, the user. Each agent keeps a cursor and asks what changed since,
 * so it can tell which changes happened while one of its own tools was running.
 */
export interface FileChangeFeed {
  cursor(): number;
  /** Absolute paths changed after `cursor`. With settle, first waits for change events to stop arriving. */
  changedSince(cursor: number, settle?: boolean): Promise<{ paths: string[]; cursor: number }>;
}

/** Build output, caches and tool folders: changes there are side effects of running things, not code changes. */
export const ARTIFACT_DIRS = new Set([
  ...SKIP_DIRS, 'coverage', '.nyc_output', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.cache', '.parcel-cache',
  '.turbo', '.gradle', '.idea', '.vs', '.vscode-test', 'build', 'bin', 'obj', '.angular', '.svelte-kit', '.nuxt', '.dart_tool',
  '.infraon-checkpoints', 'htmlcov', '.eggs',
]);

const ARTIFACT_FILE = /(\.(log|tmp|swp|swo|pyc|pyo|class|o|obj|tsbuildinfo)|~|\.DS_Store|Thumbs\.db)$/i;

/** True for paths whose changes never count as code changes (`rel` uses / or \). */
export function isArtifactPath(rel: string, ignore?: IgnoreMatcher): boolean {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || ARTIFACT_FILE.test(parts[parts.length - 1])) { return true; }
  if (parts.slice(0, -1).some((p) => ARTIFACT_DIRS.has(p) || p.endsWith('.egg-info'))) { return true; }
  if (ignore) {
    for (let i = 1; i <= parts.length; i++) {
      if (ignore.ignores(parts.slice(0, i).join('/'), i < parts.length)) { return true; }
    }
  }
  return false;
}

export class ChangeJournal implements FileChangeFeed {
  private seq = 0;
  private entries: Array<{ seq: number; path: string }> = [];
  private listeners = new Set<() => void>();

  constructor(private opts: { max?: number; quietMs?: number; maxWaitMs?: number } = {}) {}

  record(absPath: string): void {
    this.entries.push({ seq: ++this.seq, path: path.resolve(absPath) });
    const max = this.opts.max ?? 5000;
    if (this.entries.length > max) { this.entries.splice(0, this.entries.length - max); }
    for (const l of this.listeners) { l(); }
  }

  cursor(): number { return this.seq; }

  /** Waits until no change has been recorded for quietMs (or maxWaitMs passed): file watchers report a little late. */
  settle(): Promise<void> {
    const quietMs = this.opts.quietMs ?? 300;
    const maxWaitMs = this.opts.maxWaitMs ?? 2000;
    return new Promise((resolve) => {
      let quiet: NodeJS.Timeout;
      const finish = () => { clearTimeout(quiet); clearTimeout(cap); this.listeners.delete(bump); resolve(); };
      const bump = () => { clearTimeout(quiet); quiet = setTimeout(finish, quietMs); };
      const cap = setTimeout(finish, maxWaitMs);
      this.listeners.add(bump);
      bump();
    });
  }

  async changedSince(cursor: number, settle = false): Promise<{ paths: string[]; cursor: number }> {
    if (settle) { await this.settle(); }
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const e of this.entries) {
      if (e.seq <= cursor) { continue; }
      const key = process.platform === 'win32' ? e.path.toLowerCase() : e.path;
      if (!seen.has(key)) { seen.add(key); paths.push(e.path); }
    }
    return { paths, cursor: this.seq };
  }
}
