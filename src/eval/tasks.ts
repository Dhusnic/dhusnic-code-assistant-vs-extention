import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

/**
 * One evaluation task: a small repository, a request for the agent, and a command that grades the result.
 *
 *   eval/tasks/<folder>/task.json   the definition below
 *   eval/tasks/<folder>/repo/       the starting repository (copied to a temp folder for every run)
 *   eval/tasks/<folder>/<hidden>/   optional: files copied into the repository only at grading time
 *   eval/tasks/<folder>/solution/   the reference solution: files copied over repo/ (see applySolution in runner.ts)
 *
 * difficulty, language and requires are metadata for reports and filtering. requires names toolchains the task
 * needs beyond Node (see TOOLCHAINS); a task whose toolchain is missing on this machine is skipped, not failed.
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
  difficulty?: Difficulty;
  /** Main language of the fixture, e.g. "javascript", "typescript", "python". */
  language?: string;
  /** Toolchains the check needs besides plain Node (keys of TOOLCHAINS). */
  requires?: string[];
  /** Folder inside the task folder with the reference solution (default "solution" when it exists). */
  solution?: string;
  /** Absolute path of the task folder (set by loadTasks). */
  dir: string;
}

export const DEFAULT_TASK_TIMEOUT_S = 600;

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = typeof DIFFICULTIES[number];

const works = (cmd: string): boolean => {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  return r.status === 0 && !r.error;
};

/**
 * Toolchains a task may require, each with a cheap local probe (no network). "node-ts" is Node's built-in type
 * stripping (22.6+), which runs .ts files without installing TypeScript; "python" is python3 or python on PATH.
 */
export const TOOLCHAINS: Record<string, () => boolean> = {
  'node-ts': () => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    return major > 22 || (major === 22 && minor >= 6);
  },
  python: () => works('python3') || works('python'),
};

const probed = new Map<string, boolean>();

/** The task's required toolchains that this machine lacks (results are cached per process). */
export function missingToolchains(task: Pick<EvalTask, 'requires'>): string[] {
  return (task.requires ?? []).filter((t) => {
    if (!probed.has(t)) { probed.set(t, TOOLCHAINS[t]?.() ?? false); }
    return !probed.get(t);
  });
}

/** Absolute path of the task's reference solution folder, if it has one. */
export function solutionDir(task: Pick<EvalTask, 'dir' | 'solution'>): string | undefined {
  const dir = path.join(task.dir, task.solution ?? 'solution');
  return fs.existsSync(dir) ? dir : undefined;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');

/** Checks a parsed task.json; returns the problems found (empty when valid). */
export function validateTask(raw: any, dir: string): string[] {
  const errs: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return ['task.json must contain a JSON object']; }
  for (const k of ['name', 'prompt', 'check'] as const) {
    if (typeof raw[k] !== 'string' || !raw[k].trim()) { errs.push(`"${k}" must be a non-empty string`); }
  }
  if (raw.timeoutSeconds !== undefined && !(typeof raw.timeoutSeconds === 'number' && raw.timeoutSeconds > 0)) { errs.push('"timeoutSeconds" must be a positive number'); }
  for (const k of ['mustNotChange', 'tags', 'crlf', 'requires'] as const) {
    if (raw[k] !== undefined && !isStringArray(raw[k])) { errs.push(`"${k}" must be an array of non-empty strings`); }
  }
  if (raw.hiddenTests !== undefined) {
    if (typeof raw.hiddenTests !== 'string' || !raw.hiddenTests.trim()) { errs.push('"hiddenTests" must be a folder name'); }
    else if (!fs.existsSync(path.join(dir, raw.hiddenTests))) { errs.push(`hiddenTests folder "${raw.hiddenTests}" does not exist`); }
  }
  if (raw.difficulty !== undefined && !DIFFICULTIES.includes(raw.difficulty)) { errs.push(`"difficulty" must be one of ${DIFFICULTIES.join(', ')}`); }
  if (raw.language !== undefined && (typeof raw.language !== 'string' || !raw.language.trim())) { errs.push('"language" must be a non-empty string'); }
  if (isStringArray(raw.requires)) {
    for (const t of raw.requires) { if (!(t in TOOLCHAINS)) { errs.push(`unknown toolchain "${t}" in "requires" (known: ${Object.keys(TOOLCHAINS).join(', ')})`); } }
  }
  if (raw.solution !== undefined) {
    if (typeof raw.solution !== 'string' || !raw.solution.trim()) { errs.push('"solution" must be a folder name'); }
    else if (!fs.existsSync(path.join(dir, raw.solution))) { errs.push(`solution folder "${raw.solution}" does not exist`); }
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
