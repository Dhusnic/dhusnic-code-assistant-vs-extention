import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { renameWithRetry } from './store';

/**
 * Scheduled tasks. Times are local to the machine. Formats:
 *   daily 09:00 | weekdays 09:00 | weekly mon 09:00 | hourly | every 30m | every 2h | 5-field cron
 * Daylight saving: a time skipped by the spring change runs shifted forward by the gap; a time repeated by the
 * autumn change runs once, except schedules with a wildcard hour, which keep their rhythm through the repeated hour.
 * `every N` slots are aligned to the epoch, so they survive restarts without any stored state.
 */
export type ScheduleMode = 'ask' | 'plan' | 'auto-edit';
export type RunStatus = 'running' | 'success' | 'error' | 'cancelled' | 'skipped' | 'interrupted';
export interface ScheduledTask {
  id: string; name: string; prompt: string; schedule: string; enabled: boolean; mode: ScheduleMode;
  /** Epoch milliseconds. */
  lastRunAt?: number; lastStatus?: RunStatus; nextRunAt?: number;
}
export interface ParsedSchedule {
  ok: boolean;
  error?: string;
  /** First occurrence strictly after `from`; an Invalid Date when the schedule is not ok. */
  next(from: Date): Date;
  /** Latest occurrence at or before `at` and strictly after `after`. */
  prev(at: Date, after: Date): Date | undefined;
}
export interface MissedRun { action: 'run' | 'skip' | 'none'; scheduledFor?: number; lateMs?: number }
export type NewTask = Pick<ScheduledTask, 'name' | 'prompt' | 'schedule'> & Partial<Pick<ScheduledTask, 'enabled' | 'mode'>>;
export type TaskPatch = Partial<Pick<ScheduledTask, 'name' | 'prompt' | 'schedule' | 'enabled' | 'mode'>>;

export const MISSED_RUN_GRACE_MS = 12 * 3600_000;
export const MAX_TIMER_MS = 3600_000;
export const MIN_TIMER_MS = 1000;

const MODES: ScheduleMode[] = ['ask', 'plan', 'auto-edit'];
const STATUSES: RunStatus[] = ['running', 'success', 'error', 'cancelled', 'skipped', 'interrupted'];
const ID_RE = /^[\w-]{1,64}$/;
const DAY_MS = 86400_000;
// The longest gap between two Feb 29ths is 8 years (e.g. 2096 to 2104).
const MAX_SEARCH_DAYS = 366 * 9;
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FULL_DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

interface Cron {
  minutes: number[]; hours: number[]; dom: Set<number>; months: Set<number>; dow: Set<number>;
  domStar: boolean; dowStar: boolean; hourStar: boolean;
}
interface FieldSpec { label: string; min: number; max: number; names?: string[]; nameBase?: number }
const FIELD_SPECS: FieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { label: 'day of week', min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
];

function fieldValue(tok: string, spec: FieldSpec): number | undefined {
  if (/^\d{1,2}$/.test(tok)) {
    const n = Number(tok);
    return n >= spec.min && n <= spec.max ? n : undefined;
  }
  const i = spec.names?.indexOf(tok.toLowerCase()) ?? -1;
  return i < 0 ? undefined : i + (spec.nameBase ?? 0);
}

function parseField(raw: string, spec: FieldSpec): number[] | string {
  const bad = (why: string): string => `${spec.label} "${raw}": ${why}`;
  const out = new Set<number>();
  const isDow = spec.label === 'day of week';
  for (const part of raw.split(',')) {
    const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d{1,3}))?$/i.exec(part);
    if (!m) { return bad('invalid syntax'); }
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) { return bad('step must be at least 1'); }
    let lo = spec.min;
    let hi = isDow ? 6 : spec.max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-');
      const from = fieldValue(a, spec);
      const to = b === undefined ? (m[2] === undefined ? from : spec.max) : fieldValue(b, spec);
      if (from === undefined || to === undefined) { return bad('value out of range'); }
      if (from > to) { return bad('range is reversed'); }
      lo = from; hi = to;
    }
    for (let v = lo; v <= hi; v += step) { out.add(isDow ? v % 7 : v); }
  }
  return [...out].sort((a, b) => a - b);
}

function parseCron(text: string): Cron | string {
  const parts = text.split(' ');
  if (parts.length !== 5) { return 'expected a 5-field cron expression or daily, weekdays, weekly, hourly, every'; }
  const fields: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const f = parseField(parts[i], FIELD_SPECS[i]);
    if (typeof f === 'string') { return f; }
    fields.push(f);
  }
  const [minutes, hours, dom, months, dow] = fields;
  const domStar = parts[2].startsWith('*');
  const dowStar = parts[4].startsWith('*');
  // With a weekday restriction as well, standard cron matches either one, so only a date-only rule can be impossible.
  if (dowStar && !months.some((m) => dom[0] <= MONTH_DAYS[m - 1])) { return `"${text}" never matches a real date`; }
  return { minutes, hours, dom: new Set(dom), months: new Set(months), dow: new Set(dow), domStar, dowStar, hourStar: parts[1].startsWith('*') };
}

function dayMatches(c: Cron, y: number, m: number, d: number): boolean {
  if (!c.months.has(m + 1)) { return false; }
  const dom = c.dom.has(d);
  const dow = c.dow.has(new Date(y, m, d, 12).getDay());
  return c.domStar || c.dowStar ? dom && dow : dom || dow;
}

/** Every occurrence on one local day, ascending, as epoch milliseconds. */
function dayOccurrences(c: Cron, y: number, m: number, d: number): number[] {
  const back = Math.max(0, new Date(y, m, d + 1).getTimezoneOffset() - new Date(y, m, d).getTimezoneOffset()) * 60_000;
  const out = new Set<number>();
  for (const h of c.hours) {
    for (const min of c.minutes) {
      const t = new Date(y, m, d, h, min).getTime();                  // the runtime resolves a skipped time forward, a repeated one to its first pass
      out.add(t);
      if (back && c.hourStar) {
        const again = new Date(t + back);
        if (again.getHours() === h && again.getMinutes() === min) { out.add(again.getTime()); }
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

function cronSchedule(c: Cron): ParsedSchedule {
  const dayAt = (base: Date, offset: number): [number, number, number] => {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, 12);
    return [d.getFullYear(), d.getMonth(), d.getDate()];
  };
  return {
    ok: true,
    next(from) {
      const t = from.getTime();
      if (!Number.isFinite(t)) { return new Date(NaN); }
      for (let i = -1; i <= MAX_SEARCH_DAYS; i++) {                   // starts a day early: a shifted time can cross midnight
        const [y, m, d] = dayAt(from, i);
        if (!dayMatches(c, y, m, d)) { continue; }
        const hit = dayOccurrences(c, y, m, d).find((x) => x > t);
        if (hit !== undefined) { return new Date(hit); }
      }
      return new Date(NaN);
    },
    prev(at, after) {
      const t = at.getTime();
      const floor = after.getTime();
      if (!Number.isFinite(t) || !Number.isFinite(floor)) { return undefined; }
      const days = Math.min(MAX_SEARCH_DAYS, Math.ceil((t - floor) / DAY_MS) + 2);
      for (let i = 1; i >= -days; i--) {
        const [y, m, d] = dayAt(at, i);
        if (!dayMatches(c, y, m, d)) { continue; }
        const hit = dayOccurrences(c, y, m, d).reverse().find((x) => x <= t);
        if (hit !== undefined) { return hit > floor ? new Date(hit) : undefined; }
      }
      return undefined;
    },
  };
}

function intervalSchedule(ms: number): ParsedSchedule {
  return {
    ok: true,
    next: (from) => (Number.isFinite(from.getTime()) ? new Date((Math.floor(from.getTime() / ms) + 1) * ms) : new Date(NaN)),
    prev(at, after) {
      const hit = Math.floor(at.getTime() / ms) * ms;
      return Number.isFinite(hit) && hit > after.getTime() ? new Date(hit) : undefined;
    },
  };
}

const invalid = (error: string): ParsedSchedule => ({ ok: false, error, next: () => new Date(NaN), prev: () => undefined });

function clock(text: string): { h: number; m: number } | undefined {
  const t = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!t || Number(t[1]) > 23 || Number(t[2]) > 59) { return undefined; }
  return { h: Number(t[1]), m: Number(t[2]) };
}

export function parseSchedule(text: string): ParsedSchedule {
  if (typeof text !== 'string') { return invalid('schedule must be text'); }
  const s = text.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!s) { return invalid('schedule is empty'); }
  if (s.length > 200) { return invalid('schedule is too long'); }
  if (s === 'hourly') { return fromCron('0 * * * *'); }
  const every = /^every (\d+) ?(m|min|mins|minutes?|h|hr|hrs|hours?)$/.exec(s);
  if (every) {
    const minutes = Number(every[1]) * (every[2].startsWith('h') ? 60 : 1);
    if (minutes < 1 || minutes > 1440) { return invalid('"every" must be between 1 minute and 24 hours'); }
    return intervalSchedule(minutes * 60_000);
  }
  if (s.startsWith('every')) { return invalid('expected "every <n>m" or "every <n>h"'); }
  const named = /^(daily|weekdays|weekly)(?: (.+))?$/.exec(s);
  if (!named) { return fromCron(s); }
  const args = (named[2] ?? '').split(' ');
  const time = clock(args[args.length - 1]);
  if (!time) { return invalid(`${named[1]} needs a time such as 09:00`); }
  if (named[1] === 'weekly') {
    const day = args.length === 2 ? FULL_DAY_NAMES.findIndex((n, i) => n === args[0] || DAY_NAMES[i] === args[0]) : -1;
    if (day < 0) { return invalid('weekly needs a day and a time, such as "weekly mon 09:00"'); }
    return fromCron(`${time.m} ${time.h} * * ${day}`);
  }
  if (args.length !== 1) { return invalid(`${named[1]} takes only a time`); }
  return fromCron(`${time.m} ${time.h} * * ${named[1] === 'weekdays' ? '1-5' : '*'}`);
}

function fromCron(text: string): ParsedSchedule {
  const c = parseCron(text);
  return typeof c === 'string' ? invalid(c) : cronSchedule(c);
}

/** The next time a task should run after `from`, or undefined when it is disabled or its schedule is invalid. */
export function nextRun(task: ScheduledTask, from: Date): Date | undefined {
  if (!task.enabled) { return undefined; }
  const s = parseSchedule(task.schedule);
  const d = s.ok ? s.next(from) : undefined;
  return d && Number.isFinite(d.getTime()) ? d : undefined;
}

/**
 * What to do about a task whose time has passed. However many occurrences were missed it runs at most once,
 * and only when the latest of them is under 12 hours old; otherwise the task waits for its next occurrence.
 */
export function missedRun(task: ScheduledTask, now: Date): MissedRun {
  if (!task.enabled) { return { action: 'none' }; }
  const s = parseSchedule(task.schedule);
  if (!s.ok) { return { action: 'none' }; }
  const n = now.getTime();
  const anchor = task.nextRunAt ?? (task.lastRunAt !== undefined ? s.next(new Date(task.lastRunAt)).getTime() : undefined);
  if (anchor === undefined || !Number.isFinite(anchor) || anchor > n) { return { action: 'none' }; }
  const hit = s.prev(now, new Date(Math.max(n - MISSED_RUN_GRACE_MS, anchor - 1)))?.getTime();
  if (hit === undefined || (task.lastRunAt !== undefined && hit <= task.lastRunAt)) { return { action: 'skip', lateMs: n - anchor }; }
  return { action: 'run', scheduledFor: hit, lateMs: n - hit };
}

/** Enabled tasks that should start now, including a missed run that is still within the 12 hour window. */
export function dueTasks(tasks: ScheduledTask[], now: Date): ScheduledTask[] {
  return tasks.filter((t) => missedRun(t, now).action === 'run');
}

/** Delay for one timer covering every task: at least 1 second, at most 1 hour (so sleep and clock changes are noticed). */
export function msUntilNext(tasks: ScheduledTask[], now: Date): number {
  const n = now.getTime();
  let best = MAX_TIMER_MS;
  for (const t of tasks) {
    if (!t.enabled) { continue; }
    if (missedRun(t, now).action === 'run') { return MIN_TIMER_MS; }
    const at = t.nextRunAt !== undefined && t.nextRunAt > n ? t.nextRunAt : nextRun(t, now)?.getTime();
    if (at !== undefined) { best = Math.min(best, at - n); }
  }
  return Math.max(MIN_TIMER_MS, Math.min(MAX_TIMER_MS, best));
}

const optionalTime = (v: unknown): v is number | undefined => v === undefined || (typeof v === 'number' && Number.isFinite(v));

export function validateTask(raw: unknown): { task?: ScheduledTask; error?: string } {
  const x = raw as Partial<ScheduledTask> | null;
  if (!x || typeof x !== 'object' || Array.isArray(x)) { return { error: 'task must be an object' }; }
  if (typeof x.id !== 'string' || !ID_RE.test(x.id)) { return { error: 'invalid task id' }; }
  const fail = (why: string): { error: string } => ({ error: `task ${x.id}: ${why}` });
  if (typeof x.name !== 'string' || !x.name.trim() || x.name.length > 120) { return fail('name must be 1 to 120 characters'); }
  if (typeof x.prompt !== 'string' || !x.prompt.trim()) { return fail('prompt is required'); }
  if (typeof x.enabled !== 'boolean') { return fail('enabled must be true or false'); }
  if (!MODES.includes(x.mode as ScheduleMode)) { return fail(`mode must be one of ${MODES.join(', ')}`); }
  const parsed = parseSchedule(x.schedule as string);
  if (!parsed.ok) { return fail(parsed.error ?? 'invalid schedule'); }
  if (!optionalTime(x.lastRunAt) || !optionalTime(x.nextRunAt)) { return fail('run times must be numbers'); }
  if (x.lastStatus !== undefined && !STATUSES.includes(x.lastStatus)) { return fail('unknown last status'); }
  const task: ScheduledTask = { id: x.id, name: x.name.trim(), prompt: x.prompt, schedule: (x.schedule as string).trim(), enabled: x.enabled, mode: x.mode as ScheduleMode };
  if (x.lastRunAt !== undefined) { task.lastRunAt = x.lastRunAt; }
  if (x.lastStatus !== undefined) { task.lastStatus = x.lastStatus; }
  if (x.nextRunAt !== undefined) { task.nextRunAt = x.nextRunAt; }
  return { task };
}

async function atomicWrite(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try { await fh.writeFile(text, 'utf8'); await fh.sync(); } finally { await fh.close(); }
  try {
    try { await fs.copyFile(file, `${file}.bak`); } catch (e: any) { if (e.code !== 'ENOENT') { throw e; } }
    await renameWithRetry(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/**
 * Tasks in one JSON file. Every change re-reads the file first, so windows sharing it do not undo each other's edits.
 * Entries that fail validation are reported in `errors` and kept in the file for the user to repair.
 */
export class ScheduleStore {
  private tasks: ScheduledTask[] = [];
  private rejected: unknown[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  errors: string[] = [];

  constructor(readonly file: string) {}

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<void> {
    this.errors = [];
    for (const f of [this.file, `${this.file}.bak`]) {
      let data: any;
      try { data = JSON.parse(await fs.readFile(f, 'utf8')); } catch (e: any) {
        if (e.code !== 'ENOENT') { this.errors.push(`${path.basename(f)}: ${e.message}`); }
        continue;
      }
      const list: unknown = Array.isArray(data) ? data : data?.tasks;
      if (!Array.isArray(list)) { this.errors.push(`${path.basename(f)} has an unexpected shape`); continue; }
      this.accept([...list, ...(Array.isArray(data?.invalid) ? data.invalid : [])]);
      return;
    }
    this.tasks = [];
    this.rejected = [];
  }

  private accept(list: unknown[]): void {
    const seen = new Set<string>();
    this.tasks = [];
    this.rejected = [];
    for (const raw of list) {
      const { task, error } = validateTask(raw);
      if (task && !seen.has(task.id)) {
        seen.add(task.id);
        this.tasks.push(task.lastStatus === 'running' ? { ...task, lastStatus: 'interrupted' } : task);
      } else {
        this.errors.push(error ?? `duplicate task id ${task?.id}`);
        this.rejected.push(raw);
      }
    }
  }

  private write(): Promise<void> {
    return atomicWrite(this.file, `${JSON.stringify({ v: 1, tasks: this.tasks, ...(this.rejected.length ? { invalid: this.rejected } : {}) }, null, 2)}\n`);
  }

  private mutate<T>(fn: () => T): Promise<T> {
    return this.enqueue(async () => { await this.read(); const r = fn(); await this.write(); return r; });
  }

  private index(id: string): number {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i < 0) { throw new Error(`No scheduled task "${id}"`); }
    return i;
  }

  /** The tasks as last read or written. */
  list(): ScheduledTask[] { return this.tasks.map((t) => ({ ...t })); }

  load(): Promise<ScheduledTask[]> { return this.enqueue(async () => { await this.read(); return this.list(); }); }

  save(tasks: ScheduledTask[]): Promise<void> {
    return this.enqueue(async () => {
      this.errors = [];
      this.accept(tasks);
      await this.write();
    });
  }

  /** Throws when the task is invalid. */
  add(input: NewTask, now: Date = new Date()): Promise<ScheduledTask> {
    return this.mutate(() => {
      const { task, error } = validateTask({ enabled: true, mode: 'ask', ...input, id: randomBytes(6).toString('hex') });
      if (!task) { throw new Error(error); }
      const at = nextRun(task, now)?.getTime();
      if (at !== undefined) { task.nextRunAt = at; }
      this.tasks.push(task);
      return { ...task };
    });
  }

  /** Throws when the id is unknown or the result is invalid. */
  update(id: string, patch: TaskPatch, now: Date = new Date()): Promise<ScheduledTask> {
    return this.mutate(() => {
      const i = this.index(id);
      const { task, error } = validateTask({ ...this.tasks[i], ...patch, id });
      if (!task) { throw new Error(error); }
      if (patch.schedule !== undefined || patch.enabled !== undefined) {
        delete task.nextRunAt;
        const at = nextRun(task, now)?.getTime();
        if (at !== undefined) { task.nextRunAt = at; }
      }
      this.tasks[i] = task;
      return { ...task };
    });
  }

  remove(id: string): Promise<boolean> {
    return this.mutate(() => {
      const before = this.tasks.length;
      this.tasks = this.tasks.filter((t) => t.id !== id);
      return this.tasks.length !== before;
    });
  }

  /** Records a run and moves the task to its next occurrence. Call it when a run starts as well, so it cannot start twice. */
  markRun(id: string, status: RunStatus, at: Date = new Date()): Promise<ScheduledTask> {
    return this.mutate(() => {
      const i = this.index(id);
      const task: ScheduledTask = { ...this.tasks[i], lastRunAt: at.getTime(), lastStatus: status };
      delete task.nextRunAt;
      const next = nextRun(task, at)?.getTime();
      if (next !== undefined) { task.nextRunAt = next; }
      this.tasks[i] = task;
      return { ...task };
    });
  }

  /** Startup housekeeping: moves tasks that are too late past their missed run and fills in missing times. Returns the skipped tasks. */
  reconcile(now: Date = new Date()): Promise<ScheduledTask[]> {
    return this.mutate(() => {
      const skipped: ScheduledTask[] = [];
      this.tasks = this.tasks.map((t) => {
        const action = missedRun(t, now).action;
        if (action === 'run' || (t.enabled && t.nextRunAt !== undefined && action === 'none')) { return t; }
        if (action === 'skip') { skipped.push(t); }
        const task = { ...t };
        delete task.nextRunAt;
        const at = nextRun(task, now)?.getTime();
        if (at !== undefined) { task.nextRunAt = at; }
        return task;
      });
      return skipped;
    });
  }
}
