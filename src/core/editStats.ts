/**
 * Local edit statistics: how often the file-editing tools (edit_file, multi_edit, write_file) succeed or fail, why
 * they fail, and with which model and file type. It helps decide whether a model or a file type needs better edit
 * prompting, without guessing from anecdotes.
 *
 * Privacy by construction: a record holds only the tool name, the model id, the file EXTENSION and a short reason
 * code derived from the error text. Never the path, file contents, old_string/new_string or the raw error message.
 * The counters live in memory for one VS Code window and are never sent anywhere; the host only prints them to the
 * extension's own output channel (command "Infraon Assistant: Show Edit Statistics").
 *
 * Reasons come from the error messages in fstools.ts (applyEdit, FileReadTracker.check, resolveIn, multiOps), so keep
 * classifyEditError in step when those messages change. Distinct keys per table are capped so a long-running window
 * with odd file names cannot grow without bound.
 */
import * as path from 'path';

/** The tools whose outcomes are counted. */
export const EDIT_STAT_TOOLS: ReadonlySet<string> = new Set(['edit_file', 'multi_edit', 'write_file']);

export type EditFailReason =
  | 'no_match' | 'multiple_matches' | 'not_read_first' | 'stale_file' | 'empty_old_string' | 'no_change'
  | 'bad_arguments' | 'outside_workspace' | 'file_missing' | 'permission' | 'other';

/** Maps an edit tool's error message to a reason code. Only the code is kept, never the message. */
export function classifyEditError(message: string): EditFailReason {
  const m = String(message ?? '');
  if (/^Path outside workspace/i.test(m)) { return 'outside_workspace'; }
  if (/You have not read .* yet/i.test(m)) { return 'not_read_first'; }
  if (/changed on disk since you last read it/i.test(m)) { return 'stale_file'; }
  if (/\bENOENT\b|no such file or directory/i.test(m)) { return 'file_missing'; }
  if (/\b(EACCES|EPERM|EBUSY|EROFS)\b/.test(m)) { return 'permission'; }
  if (/must not be empty/i.test(m)) { return 'empty_old_string'; }
  if (/identical; nothing to change/i.test(m)) { return 'no_change'; }
  if (/matches \d+ places/i.test(m)) { return 'multiple_matches'; }
  if (/old_string not found/i.test(m)) { return 'no_match'; }
  if (/edits must be a non-empty array|not valid JSON/i.test(m)) { return 'bad_arguments'; }
  return 'other';
}

export interface EditOutcome {
  tool: string;
  /** The model id the call came from ('' = the default model). */
  model: string;
  /** The tool's path argument; only its extension is kept. */
  path?: unknown;
  /** The error message when the call failed; undefined on success. */
  error?: string;
}

export interface Bucket { ok: number; failed: number; reasons: Partial<Record<EditFailReason, number>> }

export interface EditStatsSnapshot {
  since: Date;
  total: Bucket;
  byTool: Record<string, Bucket>;
  byModel: Record<string, Bucket>;
  byExtension: Record<string, Bucket>;
}

const MAX_KEYS = 100;
const OTHER_KEY = '(other)';
const emptyBucket = (): Bucket => ({ ok: 0, failed: 0, reasons: {} });

/** The extension of a path argument, lower-cased ('(none)' without one). Never returns the path itself. */
export function extensionOf(p: unknown): string {
  if (typeof p !== 'string' || !p) { return '(none)'; }
  const ext = path.extname(p.replace(/\\/g, '/')).toLowerCase();
  return /^\.[a-z0-9_+-]{1,15}$/.test(ext) ? ext : '(none)';
}

export class EditStats {
  private total = emptyBucket();
  private byTool = new Map<string, Bucket>();
  private byModel = new Map<string, Bucket>();
  private byExtension = new Map<string, Bucket>();
  private since: Date;

  constructor(private now: () => Date = () => new Date()) { this.since = now(); }

  record(o: EditOutcome): void {
    if (!EDIT_STAT_TOOLS.has(o.tool)) { return; }
    const reason = o.error === undefined ? undefined : classifyEditError(o.error);
    const model = String(o.model ?? '').trim().slice(0, 80) || '(default)';
    for (const b of [this.total, bucketIn(this.byTool, o.tool), bucketIn(this.byModel, model), bucketIn(this.byExtension, extensionOf(o.path))]) {
      if (reason) { b.failed++; b.reasons[reason] = (b.reasons[reason] ?? 0) + 1; } else { b.ok++; }
    }
  }

  snapshot(): EditStatsSnapshot {
    const obj = (m: Map<string, Bucket>) => Object.fromEntries([...m].map(([k, b]) => [k, clone(b)]));
    return { since: this.since, total: clone(this.total), byTool: obj(this.byTool), byModel: obj(this.byModel), byExtension: obj(this.byExtension) };
  }

  reset(): void {
    this.total = emptyBucket();
    this.byTool.clear(); this.byModel.clear(); this.byExtension.clear();
    this.since = this.now();
  }
}

function bucketIn(m: Map<string, Bucket>, key: string): Bucket {
  let b = m.get(key);
  if (!b) {
    if (m.size >= MAX_KEYS) { key = OTHER_KEY; b = m.get(key); }
    if (!b) { b = emptyBucket(); m.set(key, b); }
  }
  return b;
}

const clone = (b: Bucket): Bucket => ({ ok: b.ok, failed: b.failed, reasons: { ...b.reasons } });

const pct = (b: Bucket): string => {
  const n = b.ok + b.failed;
  return n ? `${Math.round((b.failed / n) * 100)}%` : '-';
};

const topReasons = (b: Bucket): string =>
  Object.entries(b.reasons).sort((x, y) => (y[1] ?? 0) - (x[1] ?? 0) || x[0].localeCompare(y[0])).map(([r, n]) => `${r} ${n}`).join(', ');

function table(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}

function section(title: string, label: string, m: Record<string, Bucket>): string[] {
  const rows = Object.entries(m)
    .sort((a, b) => (b[1].ok + b[1].failed) - (a[1].ok + a[1].failed) || a[0].localeCompare(b[0]))
    .map(([k, b]) => [k, String(b.ok), String(b.failed), pct(b), topReasons(b)]);
  return ['', title, ...table([label, 'ok', 'failed', 'fail%', 'failure reasons'], rows)];
}

/** A plain-text report for the output channel. Contains only counts, reason codes, tool names, model ids and extensions. */
export function formatEditStats(s: EditStatsSnapshot): string {
  const n = s.total.ok + s.total.failed;
  const head = `Edit statistics since ${s.since.toISOString()} (this window only, kept in memory, never sent anywhere)`;
  if (!n) { return `${head}\nNo edit_file, multi_edit or write_file calls yet.`; }
  const reasons = Object.entries(s.total.reasons).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0) || a[0].localeCompare(b[0]));
  return [
    head,
    `Total: ${n} calls, ${s.total.ok} ok, ${s.total.failed} failed (${pct(s.total)})`,
    ...section('By tool', 'tool', s.byTool),
    ...section('By model', 'model', s.byModel),
    ...section('By file extension', 'extension', s.byExtension),
    ...(reasons.length ? ['', 'Failure reasons', ...table(['reason', 'count'], reasons.map(([r, c]) => [r, String(c)]))] : []),
  ].join('\n');
}
