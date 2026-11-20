import * as fs from 'fs';
import * as path from 'path';

/**
 * One evaluation task: a small repository, a request for the agent, and a command that grades the result.
 *
 *   eval/tasks/<folder>/task.json   the definition below
 *   eval/tasks/<folder>/repo/       the starting repository (copied to a temp folder for every run)
 *   eval/tasks/<folder>/<hidden>/   optional: files copied into the repository only at grading time
 */
export interface EvalTask {
  name: string;
  prompt: string;
  /** Shell command run in the repository after the agent finishes; exit code 0 means the task passed. */
  check: string;
  /** Wall-clock limit for the agent (default 600). */
  timeoutSeconds?: number;
  /** Globs (relative to the repository) whose files must be byte-identical to the original, e.g. the tests. */
  mustNotChange?: string[];
  /** Folder inside the task folder whose files are copied into the repository just before the check runs. */
  hiddenTests?: string;
  /** Files converted to CRLF line endings after copying (fixtures stay LF in git, whatever autocrlf does). */
  crlf?: string[];
  tags?: string[];
  /** Absolute path of the task folder (set by loadTasks). */
  dir: string;
}

export const DEFAULT_TASK_TIMEOUT_S = 600;

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');

/** Checks a parsed task.json; returns the problems found (empty when valid). */
export function validateTask(raw: any, dir: string): string[] {
  const errs: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return ['task.json must contain a JSON object']; }
  for (const k of ['name', 'prompt', 'check'] as const) {
    if (typeof raw[k] !== 'string' || !raw[k].trim()) { errs.push(`"${k}" must be a non-empty string`); }
  }
  if (raw.timeoutSeconds !== undefined && !(typeof raw.timeoutSeconds === 'number' && raw.timeoutSeconds > 0)) { errs.push('"timeoutSeconds" must be a positive number'); }
  for (const k of ['mustNotChange', 'tags', 'crlf'] as const) {
    if (raw[k] !== undefined && !isStringArray(raw[k])) { errs.push(`"${k}" must be an array of non-empty strings`); }
  }
  if (raw.hiddenTests !== undefined) {
    if (typeof raw.hiddenTests !== 'string' || !raw.hiddenTests.trim()) { errs.push('"hiddenTests" must be a folder name'); }
    else if (!fs.existsSync(path.join(dir, raw.hiddenTests))) { errs.push(`hiddenTests folder "${raw.hiddenTests}" does not exist`); }
  }
  if (!fs.existsSync(path.join(dir, 'repo'))) { errs.push('the task has no repo/ folder'); }
  return errs;
}

/** Loads every task folder under `dir`. Invalid tasks are reported in errors and skipped. */
export function loadTasks(dir: string): { tasks: EvalTask[]; errors: string[] } {
  const tasks: EvalTask[] = [];
  const errors: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e: any) { return { tasks, errors: [`cannot read tasks folder ${dir}: ${e.message}`] }; }
  for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const taskDir = path.join(dir, e.name);
    const file = path.join(taskDir, 'task.json');
    let raw: any;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err: any) {
      errors.push(`${e.name}: ${err.code === 'ENOENT' ? 'no task.json' : `task.json is not valid JSON (${err.message})`}`);
      continue;
    }
    const problems = validateTask(raw, taskDir);
    if (problems.length) { errors.push(`${e.name}: ${problems.join('; ')}`); continue; }
    tasks.push({ ...raw, dir: taskDir });
  }
  return { tasks, errors };
}

/** Finds eval/tasks by walking up from each start folder (works from out/, a scratch build folder or the repo root). */
export function findTasksDir(...starts: string[]): string | undefined {
  for (const start of starts) {
    let cur = path.resolve(start);
    for (;;) {
      const candidate = path.join(cur, 'eval', 'tasks');
      if (fs.existsSync(candidate)) { return candidate; }
      const up = path.dirname(cur);
      if (up === cur) { break; }
      cur = up;
    }
  }
  return undefined;
}
