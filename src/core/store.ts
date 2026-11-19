import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { ChatMessage } from './llm';
import { SUMMARY_PREFIX } from './sessions';

/**
 * Session storage, v2 layout:
 *   <dir>/<sessionId>/session.json          meta + agent summaries (small; used by the History list)
 *   <dir>/<sessionId>/agents/<agentId>.json  one agent's conversation
 * Every file is written atomically (temp file + rename) with the previous version kept as `.bak`,
 * writes to the same file are serialized (latest wins), and reads fall back to `.bak` if the main file is damaged.
 */

export const SCHEMA_VERSION = 2;
export type StoredStatus = 'idle' | 'queued' | 'running' | 'waiting' | 'error' | 'interrupted';
const LIVE_STATUSES: StoredStatus[] = ['queued', 'running', 'waiting'];
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const ID_RE = /^[\w-]{1,64}$/;

export interface AgentSummary { id: string; name: string; createdAt: number; updatedAt: number; status: StoredStatus; turns: number }
export interface SessionMeta { v: number; id: string; title: string; createdAt: number; updatedAt: number; agents: AgentSummary[] }
export interface AgentRecord {
  v: number; id: string; sessionId: string; name: string; createdAt: number; updatedAt: number;
  status: StoredStatus; model: string; mode: string; effort: string; error?: string;
  history: ChatMessage[]; turnStarts: number[];
  /** Claude-style agent hierarchy: one main conversation per session, sub-agents launched from it. */
  role?: 'main' | 'sub'; parentId?: string; type?: string; description?: string; background?: boolean;
  outcome?: 'completed' | 'failed' | 'cancelled'; result?: string; parentToolId?: string;
  /** Bookmarked replies, identified by the turn they belong to and a hash of their text. */
  bookmarks?: Bookmark[];
  /** The git worktree this sub-agent works in, when agent worktrees are on. */
  worktree?: { path: string; branch: string; base: string };
  /** The agent's task list (todo_write) with the actions recorded per step. */
  todos?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string; actions: Array<{ toolId: string; detail: string; ok?: boolean }> }>;
}
export interface Bookmark { turn: number; hash: string; preview: string; at: number }
export interface LoadedSession { meta: SessionMeta; agents: AgentRecord[]; warnings: string[] }
export interface StoredSessionSummary { id: string; title: string; createdAt: number; updatedAt: number; agents: number; turns: number; interrupted: boolean }
export interface VerifyItem { id: string; title: string; status: 'ok' | 'repaired' | 'corrupt'; issues: string[] }

export const validId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id);

/* ------------------------------------------------------------------ validation */

export function isAgentRecord(x: any): x is AgentRecord {
  return !!x && validId(x.id) && validId(x.sessionId) && typeof x.name === 'string'
    && Array.isArray(x.history) && x.history.every((m: any) => m && ROLES.has(m.role))
    && Array.isArray(x.turnStarts) && x.turnStarts.every((n: unknown) => Number.isInteger(n));
}

function isMeta(x: any): x is SessionMeta {
  return !!x && validId(x.id) && typeof x.title === 'string' && Array.isArray(x.agents)
    && x.agents.every((a: any) => a && validId(a.id) && typeof a.name === 'string');
}

/** turnStarts must point at user messages in non-decreasing order; otherwise rebuild them from the history. */
export function repairTurnStarts(history: ChatMessage[], turnStarts: number[]): { turnStarts: number[]; repaired: boolean } {
  let prev = -1;
  const ok = turnStarts.every((i) => {
    const good = i >= prev && i >= 0 && i < history.length && history[i].role === 'user';
    prev = i;
    return good;
  });
  if (ok) { return { turnStarts, repaired: false }; }
  const rebuilt: number[] = [];
  history.forEach((m, i) => { if (m.role === 'user' && !(m.content ?? '').startsWith(SUMMARY_PREFIX)) { rebuilt.push(i); } });
  return { turnStarts: rebuilt, repaired: true };
}

/* ------------------------------------------------------------------ low-level io */

type RenameFn = (from: string, to: string) => Promise<void>;
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST']);

export async function renameWithRetry(from: string, to: string, rename: RenameFn = fs.rename, attempts = 6): Promise<void> {
  for (let i = 0; ; i++) {
    try { await rename(from, to); return; } catch (e: any) {
      if (i >= attempts - 1 || !RETRYABLE.has(e.code)) { throw e; }
      await new Promise((r) => setTimeout(r, 25 * 2 ** i));
    }
  }
}

async function atomicWrite(file: string, text: string, rename: RenameFn): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try { await fh.writeFile(text, 'utf8'); await fh.sync(); } finally { await fh.close(); }
  try {
    try { await fs.copyFile(file, `${file}.bak`); } catch (e: any) { if (e.code !== 'ENOENT') { throw e; } }
    await renameWithRetry(tmp, file, rename);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** Reads JSON, validating it; falls back to the `.bak` copy. `source` tells which one was used. */
async function readValidated<T>(file: string, valid: (x: unknown) => x is T): Promise<{ data?: T; source: 'main' | 'backup' | 'none'; error?: string }> {
  let error: string | undefined;
  for (const [f, source] of [[file, 'main'], [`${file}.bak`, 'backup']] as const) {
    try {
      const data = JSON.parse(await fs.readFile(f, 'utf8'));
      if (valid(data)) { return { data, source }; }
      error ??= `${path.basename(f)} has an unexpected shape`;
    } catch (e: any) {
      if (e.code !== 'ENOENT') { error ??= `${path.basename(f)}: ${e.message}`; }
    }
  }
  return { source: 'none', error };
}

/* ------------------------------------------------------------------ store */

export class SessionStore2 {
  private queues = new Map<string, { next?: string; running: boolean; waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> }>();

  constructor(readonly dir: string, private rename: RenameFn = fs.rename) {}

  private sessionDir(sid: string): string {
    if (!validId(sid)) { throw new Error(`Invalid session id: ${sid}`); }
    return path.join(this.dir, sid);
  }
  private metaFile(sid: string): string { return path.join(this.sessionDir(sid), 'session.json'); }
  private agentFile(sid: string, aid: string): string {
    if (!validId(aid)) { throw new Error(`Invalid agent id: ${aid}`); }
    return path.join(this.sessionDir(sid), 'agents', `${aid}.json`);
  }

  /** Serialized, latest-wins write. Resolves once this content (or a newer one) is on disk. */
  private writeJson(file: string, obj: unknown): Promise<void> {
    const text = JSON.stringify(obj);
    let q = this.queues.get(file);
    if (!q) { q = { running: false, waiters: [] }; this.queues.set(file, q); }
    q.next = text;
    const p = new Promise<void>((resolve, reject) => q!.waiters.push({ resolve, reject }));
    if (!q.running) { void this.drain(file, q); }
    return p;
  }

  private async drain(file: string, q: { next?: string; running: boolean; waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> }): Promise<void> {
    q.running = true;
    while (q.next !== undefined) {
      const text = q.next;
      q.next = undefined;
      const waiters = q.waiters;
      q.waiters = [];
      try { await atomicWrite(file, text, this.rename); waiters.forEach((w) => w.resolve()); } catch (e) { waiters.forEach((w) => w.reject(e)); }
    }
    q.running = false;
    if (this.queues.get(file) === q) { this.queues.delete(file); }
  }

  /** Waits until every queued write has finished. */
  async flush(): Promise<void> {
    while (this.queues.size) { await new Promise((r) => setTimeout(r, 5)); }
  }

  async saveMeta(meta: SessionMeta): Promise<void> {
    return this.writeJson(this.metaFile(meta.id), { ...meta, v: SCHEMA_VERSION });
  }

  async saveAgent(rec: AgentRecord): Promise<void> {
    return this.writeJson(this.agentFile(rec.sessionId, rec.id), { ...rec, v: SCHEMA_VERSION });
  }

  async loadAgent(sid: string, aid: string): Promise<{ rec?: AgentRecord; source: 'main' | 'backup' | 'none'; error?: string }> {
    const r = await readValidated(this.agentFile(sid, aid), isAgentRecord);
    if (!r.data) { return { source: 'none', error: r.error }; }
    const rec = { ...r.data };
    if (LIVE_STATUSES.includes(rec.status)) { rec.status = 'interrupted'; }
    rec.turnStarts = repairTurnStarts(rec.history, rec.turnStarts).turnStarts;
    return { rec, source: r.source, error: r.error };
  }

  private async agentIdsOnDisk(sid: string): Promise<string[]> {
    try {
      return (await fs.readdir(path.join(this.sessionDir(sid), 'agents')))
        .filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter(validId).sort();
    } catch { return []; }
  }

  async loadSession(sid: string): Promise<LoadedSession | undefined> {
    await this.migrateLegacy();
    const warnings: string[] = [];
    const m = await readValidated(this.metaFile(sid), isMeta);
    if (m.source === 'backup') { warnings.push('session.json was damaged; restored from backup'); }
    const onDisk = await this.agentIdsOnDisk(sid);
    if (!m.data && !onDisk.length) { return undefined; }
    const ids = [...new Set([...(m.data?.agents.map((a) => a.id) ?? []), ...onDisk])];
    const agents: AgentRecord[] = [];
    for (const aid of ids) {
      const r = await this.loadAgent(sid, aid);
      if (!r.rec) { warnings.push(`agent ${aid} could not be read${r.error ? ` (${r.error})` : ''}`); continue; }
      if (r.source === 'backup') { warnings.push(`agent ${aid} was damaged; restored from backup`); }
      agents.push(r.rec);
    }
    const meta = m.data ?? rebuildMeta(sid, agents);
    if (!m.data) { warnings.push('session.json was missing; rebuilt from agent files'); }
    meta.agents = agents.map((a) => summaryOf(a, meta.agents.find((x) => x.id === a.id)));
    return { meta, agents, warnings };
  }

  async list(): Promise<StoredSessionSummary[]> {
    await this.migrateLegacy();
    let names: string[];
    try { names = await fs.readdir(this.dir); } catch { return []; }
    const out: StoredSessionSummary[] = [];
    for (const n of names) {
      if (!validId(n)) { continue; }
      const m = await readValidated(path.join(this.dir, n, 'session.json'), isMeta);
      let meta = m.data;
      if (!meta) {
        const loaded = await this.loadSession(n).catch(() => undefined);
        if (!loaded) { continue; }
        meta = loaded.meta;
      }
      out.push({
        id: meta.id, title: meta.title, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
        agents: meta.agents.length, turns: meta.agents.reduce((s, a) => s + (a.turns ?? 0), 0),
        interrupted: meta.agents.some((a) => LIVE_STATUSES.includes(a.status) || a.status === 'interrupted'),
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteSession(sid: string): Promise<void> {
    await this.flush();
    await fs.rm(this.sessionDir(sid), { recursive: true, force: true });
  }

  async deleteAgent(sid: string, aid: string): Promise<void> {
    await this.flush();
    const f = this.agentFile(sid, aid);
    await Promise.all([fs.rm(f, { force: true }), fs.rm(`${f}.bak`, { force: true })]);
  }

  /** Converts v1 single-file sessions (`<id>.json`) to the v2 layout. The original is kept as `<id>.json.migrated`. */
  async migrateLegacy(): Promise<number> {
    let names: string[];
    try { names = await fs.readdir(this.dir); } catch { return 0; }
    let migrated = 0;
    for (const n of names) {
      if (!n.endsWith('.json')) { continue; }
      const sid = n.slice(0, -5);
      if (!validId(sid)) { continue; }
      const file = path.join(this.dir, n);
      let legacy: any;
      try { legacy = JSON.parse(await fs.readFile(file, 'utf8')); } catch { continue; }
      if (!legacy || legacy.id !== sid || !Array.isArray(legacy.history) || !Array.isArray(legacy.turnStarts)) { continue; }
      const rec: AgentRecord = {
        v: SCHEMA_VERSION, id: 'a1', sessionId: sid, name: 'Agent 1',
        createdAt: legacy.createdAt ?? Date.now(), updatedAt: legacy.updatedAt ?? Date.now(), status: 'idle',
        model: legacy.model ?? '', mode: legacy.mode ?? 'ask', effort: legacy.effort ?? 'medium',
        history: legacy.history, turnStarts: repairTurnStarts(legacy.history, legacy.turnStarts).turnStarts,
      };
      await this.saveAgent(rec);
      await this.saveMeta({ v: SCHEMA_VERSION, id: sid, title: String(legacy.title ?? 'Chat'), createdAt: rec.createdAt, updatedAt: rec.updatedAt, agents: [summaryOf(rec)] });
      await renameWithRetry(file, `${file}.migrated`, this.rename);
      migrated++;
    }
    return migrated;
  }

  /** Checks every stored session; with `repair`, rewrites what can be recovered. */
  async verify(repair = false): Promise<VerifyItem[]> {
    await this.migrateLegacy();
    await this.flush();
    let names: string[];
    try { names = await fs.readdir(this.dir); } catch { return []; }
    const report: VerifyItem[] = [];
    for (const sid of names.filter(validId)) {
      const issues: string[] = [];
      const m = await readValidated(this.metaFile(sid), isMeta);
      if (m.source === 'backup') { issues.push('session.json damaged (backup is good)'); }
      if (m.source === 'none') { issues.push(m.error ? `session.json unreadable: ${m.error}` : 'session.json missing'); }
      const listed = new Set(m.data?.agents.map((a) => a.id) ?? []);
      const onDisk = await this.agentIdsOnDisk(sid);
      const agents: AgentRecord[] = [];
      let lost = 0;
      for (const aid of new Set([...listed, ...onDisk])) {
        if (!onDisk.includes(aid)) { issues.push(`agent ${aid} is listed but its file is missing`); }
        else if (!listed.has(aid) && m.data) { issues.push(`agent ${aid} exists but is not listed`); }
        const raw = await readValidated(this.agentFile(sid, aid), isAgentRecord);
        if (!raw.data) { if (onDisk.includes(aid)) { issues.push(`agent ${aid} unreadable${raw.error ? `: ${raw.error}` : ''}`); lost++; } continue; }
        if (raw.source === 'backup') { issues.push(`agent ${aid} damaged (backup is good)`); }
        const ts = repairTurnStarts(raw.data.history, raw.data.turnStarts);
        if (ts.repaired) { issues.push(`agent ${aid} had inconsistent turn markers`); }
        agents.push({ ...raw.data, turnStarts: ts.turnStarts });
      }
      const title = m.data?.title ?? '(untitled)';
      if (!agents.length) { report.push({ id: sid, title, status: 'corrupt', issues: issues.length ? issues : ['no readable agents'] }); continue; }
      if (!issues.length) { report.push({ id: sid, title, status: 'ok', issues }); continue; }
      if (repair) {
        for (const a of agents) { await this.saveAgent(a); }
        const meta = m.data ?? rebuildMeta(sid, agents);
        meta.agents = agents.map((a) => summaryOf(a, meta.agents.find((x) => x.id === a.id)));
        await this.saveMeta(meta);
      }
      report.push({ id: sid, title, status: repair && !lost ? 'repaired' : 'corrupt', issues });
    }
    return report;
  }

  /** End-to-end probe: write a session, read it back, compare, delete. Proves the storage path works on this machine. */
  async selfTest(): Promise<{ ok: boolean; ms: number; detail: string }> {
    const t0 = Date.now();
    const sid = `selftest-${randomBytes(4).toString('hex')}`;
    const rec: AgentRecord = {
      v: SCHEMA_VERSION, id: 'a1', sessionId: sid, name: 'probe', createdAt: t0, updatedAt: t0, status: 'idle', model: 'm', mode: 'ask', effort: 'medium',
      history: [{ role: 'user', content: 'ping ✓ ünïcode 🚀' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{"a":1}' } }] }, { role: 'tool', tool_call_id: 'c', content: 'pong' }],
      turnStarts: [0],
    };
    try {
      await this.saveAgent(rec);
      await this.saveMeta({ v: SCHEMA_VERSION, id: sid, title: 'probe', createdAt: t0, updatedAt: t0, agents: [summaryOf(rec)] });
      await this.saveAgent({ ...rec, name: 'probe-2' });
      const back = await this.loadSession(sid);
      const got = back?.agents[0];
      const same = !!got && got.name === 'probe-2' && JSON.stringify(got.history) === JSON.stringify(rec.history) && JSON.stringify(got.turnStarts) === '[0]';
      return { ok: same, ms: Date.now() - t0, detail: same ? 'write → read → compare succeeded' : 'data read back did not match what was written' };
    } catch (e: any) {
      return { ok: false, ms: Date.now() - t0, detail: e.message ?? String(e) };
    } finally {
      await this.deleteSession(sid).catch(() => undefined);
    }
  }
}

export function summaryOf(a: AgentRecord, prev?: AgentSummary): AgentSummary {
  return { id: a.id, name: a.name, createdAt: a.createdAt ?? prev?.createdAt ?? Date.now(), updatedAt: a.updatedAt, status: a.status, turns: a.turnStarts.length };
}

function rebuildMeta(sid: string, agents: AgentRecord[]): SessionMeta {
  const first = agents[0];
  const firstUser = first?.history.find((m) => m.role === 'user');
  return {
    v: SCHEMA_VERSION, id: sid, title: (firstUser?.display ?? firstUser?.content ?? 'Recovered chat').slice(0, 60),
    createdAt: Math.min(...agents.map((a) => a.createdAt ?? Date.now())), updatedAt: Math.max(...agents.map((a) => a.updatedAt ?? 0)),
    agents: agents.map((a) => summaryOf(a)),
  };
}
