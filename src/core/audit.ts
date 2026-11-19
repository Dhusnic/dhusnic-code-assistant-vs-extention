import * as fs from 'fs/promises';
import * as path from 'path';

export type AuditKind = 'tool' | 'approval' | 'hook' | 'permission' | 'prompt';

export interface AuditEntry {
  at: string;
  sessionId: string;
  agentId: string;
  kind: AuditKind;
  tool?: string;
  detail: string;
  outcome?: string;
  ruleRaw?: string;
  ms?: number;
}

export interface AuditOptions { maxBytes?: number; maxFiles?: number; redact?: (s: string) => string }

const SESSION_ID = /^[\w-]{1,64}$/;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_DETAIL = 2000;
const BATCH_DELAY_MS = 25;
const CSV_COLUMNS: Array<keyof AuditEntry> = ['at', 'sessionId', 'agentId', 'kind', 'tool', 'detail', 'outcome', 'ruleRaw', 'ms'];

const validSession = (id: unknown): id is string => typeof id === 'string' && SESSION_ID.test(id) && !RESERVED_NAME.test(id);

function csvCell(v: unknown): string {
  if (v === undefined || v === null) { return ''; }
  if (typeof v === 'number') { return String(v); }
  // A leading formula character would execute when the export is opened in a spreadsheet.
  const s = /^[=+\-@\t\r]/.test(String(v)) ? `'${v}` : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Append-only JSONL audit trail, one file per session, rotated by size. */
export class AuditLog {
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly redactFn?: (s: string) => string;
  private pending = new Map<string, string[]>();
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private checkedTail = new Set<string>();

  constructor(private readonly dir: string, opts: AuditOptions = {}) {
    this.maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : 5 * 1024 * 1024;
    this.maxFiles = opts.maxFiles && opts.maxFiles >= 1 ? Math.floor(opts.maxFiles) : 3;
    this.redactFn = opts.redact;
  }

  private clean(s: unknown): string {
    let out = typeof s === 'string' ? s : String(s ?? '');
    if (this.redactFn) {
      // Failing closed: an unredacted detail must never reach the disk.
      try { out = this.redactFn(out); } catch { return '[redaction failed]'; }
    }
    return out.length > MAX_DETAIL ? out.slice(0, MAX_DETAIL) : out;
  }

  /** Queues an entry; `at` defaults to now. Never throws. Entries with an invalid session id are dropped. */
  append(entry: Omit<AuditEntry, 'at'> & { at?: string }): void {
    try {
      if (!validSession(entry?.sessionId)) { return; }
      const row: AuditEntry = {
        at: entry.at ?? new Date().toISOString(), sessionId: entry.sessionId, agentId: this.clean(entry.agentId),
        kind: entry.kind, detail: this.clean(entry.detail),
      };
      if (entry.tool !== undefined) { row.tool = this.clean(entry.tool); }
      if (entry.outcome !== undefined) { row.outcome = this.clean(entry.outcome); }
      if (entry.ruleRaw !== undefined) { row.ruleRaw = this.clean(entry.ruleRaw); }
      if (typeof entry.ms === 'number' && Number.isFinite(entry.ms)) { row.ms = entry.ms; }
      const list = this.pending.get(row.sessionId);
      const line = JSON.stringify(row);
      if (list) { list.push(line); } else { this.pending.set(row.sessionId, [line]); }
      if (!this.timer) {
        this.timer = setTimeout(() => { this.timer = undefined; void this.enqueueDrain(); }, BATCH_DELAY_MS);
        this.timer.unref?.();
      }
    } catch { /* auditing must never break the agent */ }
  }

  private enqueueDrain(): Promise<void> {
    this.chain = this.chain.then(() => this.drain()).catch(() => { /* disk trouble is not the agent's problem */ });
    return this.chain;
  }

  private file(sessionId: string, n = 0): string {
    return path.join(this.dir, n ? `${sessionId}.${n}.jsonl` : `${sessionId}.jsonl`);
  }

  private async rotate(sessionId: string): Promise<void> {
    await fs.rm(this.file(sessionId, this.maxFiles - 1), { force: true }).catch(() => undefined);
    for (let n = this.maxFiles - 2; n >= 0; n--) {
      await fs.rename(this.file(sessionId, n), this.file(sessionId, n + 1)).catch(() => undefined);
    }
    await fs.rm(this.file(sessionId), { force: true }).catch(() => undefined);
  }

  /** A crash can leave a partial last line; start on a fresh line so the next entry is not glued to it. */
  private async tailPrefix(sessionId: string, size: number): Promise<string> {
    if (this.checkedTail.has(sessionId)) { return ''; }
    this.checkedTail.add(sessionId);
    if (!size) { return ''; }
    const fh = await fs.open(this.file(sessionId), 'r');
    try {
      const b = Buffer.alloc(1);
      await fh.read(b, 0, 1, size - 1);
      return b[0] === 0x0a ? '' : '\n';
    } finally { await fh.close(); }
  }

  private async writeBatch(sessionId: string, lines: string[]): Promise<void> {
    let size = await fs.stat(this.file(sessionId)).then((s) => s.size, () => 0);
    let buf = await this.tailPrefix(sessionId, size).catch(() => '');
    size += Buffer.byteLength(buf);
    for (const line of lines) {
      const add = Buffer.byteLength(line) + 1;
      if (size + add > this.maxBytes && size > 0) {
        if (buf) { await fs.appendFile(this.file(sessionId), buf, 'utf8'); buf = ''; }
        await this.rotate(sessionId);
        size = 0;
      }
      buf += `${line}\n`;
      size += add;
    }
    if (buf) { await fs.appendFile(this.file(sessionId), buf, 'utf8'); }
  }

  private async drain(): Promise<void> {
    while (this.pending.size) {
      const batch = this.pending;
      this.pending = new Map();
      await fs.mkdir(this.dir, { recursive: true });
      for (const [sessionId, lines] of batch) {
        await this.writeBatch(sessionId, lines).catch(() => undefined);
      }
    }
  }

  /** Resolves once everything appended so far is on disk. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.enqueueDrain();
  }

  /** Returns entries oldest first across rotated files; `limit` keeps the newest. Corrupt lines are skipped. */
  async read(sessionId: string, opts: { limit?: number } = {}): Promise<AuditEntry[]> {
    if (!validSession(sessionId)) { return []; }
    await this.flush();
    const limit = opts.limit !== undefined && opts.limit >= 0 ? opts.limit : Infinity;
    let out: AuditEntry[] = [];
    for (let n = 0; n < this.maxFiles && out.length < limit; n++) {
      let text: string;
      try { text = await fs.readFile(this.file(sessionId, n), 'utf8'); } catch { continue; }
      const rows: AuditEntry[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) { continue; }
        try {
          const v = JSON.parse(line);
          if (v && typeof v.at === 'string' && typeof v.kind === 'string') { rows.push(v); }
        } catch { /* partial line from a crash */ }
      }
      out = rows.concat(out);
    }
    return limit === Infinity ? out : limit === 0 ? [] : out.slice(-limit);
  }

  toCsv(entries: AuditEntry[]): string {
    const rows = entries.map((e) => CSV_COLUMNS.map((c) => csvCell(e[c])).join(','));
    return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
  }
}
