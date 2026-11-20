import * as fs from 'fs/promises';
import * as path from 'path';
import { AgentRecord, SessionStore2, validId } from './store';

/**
 * Sessions are stored once per machine (global storage), but each VS Code window only lists and opens the sessions of
 * its own workspace (repo). The workspace is recorded on the session's meta as a normalised key; sessions saved before
 * that have no key and are attributed from the absolute paths they touched (tool calls, checkpoints):
 *   - mostly inside this window's folders   -> 'mine' (the key is written, so the decision is made once)
 *   - mostly outside them                    -> 'other' (hidden here; the right window claims it)
 *   - no evidence at all (e.g. pure Q&A)     -> 'unassigned': listed, marked, and claimed by the first window that opens it
 */

/** The key of a window with no folder open. All empty windows share it; it never equals a folder's key. */
export const EMPTY_WORKSPACE = '<no-folder>';

export type Ownership = 'mine' | 'other' | 'unassigned';

export interface ScopeContext {
  /** workspaceKey() of the current window. */
  key: string;
  /** The window's workspace folders (absolute paths); used to attribute legacy sessions. */
  roots: string[];
  /** Paths whose files say nothing about the repo (the extension's own storage: worktrees, checkpoints). */
  ignore?: string[];
  platform?: NodeJS.Platform;
}

const URI_RE = /^[a-z][\w+.-]+:\/\//i;
const pathApi = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

/** Normalises a folder or workspace-file path so the same place always gives the same string (case-insensitive on Windows). */
export function normalizeRoot(p: string, platform: NodeJS.Platform = process.platform): string {
  if (p === EMPTY_WORKSPACE) { return p; }
  if (URI_RE.test(p) && !/^[a-z]:[\\/]/i.test(p)) { return p.replace(/\/+$/, ''); }
  const api = pathApi(platform);
  let r = api.normalize(p);
  const top = api.parse(r).root;
  while (r.length > top.length && (r.endsWith('/') || (platform === 'win32' && r.endsWith('\\')))) { r = r.slice(0, -1); }
  return platform === 'win32' ? r.toLowerCase() : r;
}

/**
 * The identity of a window's workspace: the .code-workspace file of a saved multi-root workspace, otherwise the first
 * folder (the same folder the assistant treats as its root), otherwise EMPTY_WORKSPACE.
 */
export function workspaceKey(ws: { workspaceFile?: string; folders?: string[] }, platform: NodeJS.Platform = process.platform): string {
  if (ws.workspaceFile) { return normalizeRoot(ws.workspaceFile, platform); }
  const first = ws.folders?.find((f) => !!f);
  return first ? normalizeRoot(first, platform) : EMPTY_WORKSPACE;
}

export function sameWorkspace(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return normalizeRoot(a, platform) === normalizeRoot(b, platform);
}

export function isAbsolutePath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') { return /^[a-z]:[\\/]/i.test(p) || /^\\\\[^\\]/.test(p); }
  return p.startsWith('/') && !p.startsWith('//');
}

export function isInside(child: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const c = normalizeRoot(child, platform), r = normalizeRoot(root, platform);
  if (c === r) { return true; }
  const sep = platform === 'win32' ? '\\' : '/';
  return c.startsWith(r.endsWith(sep) ? r : r + sep);
}

const MAX_EVIDENCE = 500;

/** Absolute paths found in the agents' tool-call arguments. */
export function absolutePathsIn(agents: Array<Pick<AgentRecord, 'history'>>, platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (out.length >= MAX_EVIDENCE) { return; }
    if (typeof v === 'string') { const s = v.trim(); if (s.length < 1024 && !s.includes('\n') && isAbsolutePath(s, platform)) { out.push(s); } return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') { Object.values(v).forEach(walk); }
  };
  for (const a of agents) {
    for (const m of a.history ?? []) {
      for (const tc of m?.tool_calls ?? []) {
        const raw = tc?.function?.arguments;
        if (typeof raw !== 'string') { continue; }
        try { walk(JSON.parse(raw)); } catch { /* not JSON */ }
      }
    }
  }
  return out;
}

/** Decides from the evidence whether a legacy session belongs to the window whose folders are `roots`. */
export function classifyEvidence(paths: string[], ctx: Pick<ScopeContext, 'roots' | 'ignore' | 'platform'>): Ownership {
  const platform = ctx.platform ?? process.platform;
  let inside = 0, outside = 0;
  for (const p of paths) {
    if ((ctx.ignore ?? []).some((i) => isInside(p, i, platform))) { continue; }
    if (ctx.roots.some((r) => isInside(p, r, platform))) { inside++; } else { outside++; }
  }
  if (!inside && !outside) { return 'unassigned'; }
  return inside > 0 && inside >= outside ? 'mine' : 'other';
}

/** Absolute paths of files the session's agents changed, from its checkpoint manifests. */
export async function checkpointPaths(checkpointsDir: string, sid: string): Promise<string[]> {
  if (!validId(sid)) { return []; }
  const out: string[] = [];
  const base = path.join(checkpointsDir, sid);
  let agents: string[] = [];
  try { agents = await fs.readdir(base); } catch { return out; }
  for (const aid of agents) {
    let turns: string[] = [];
    try { turns = (await fs.readdir(path.join(base, aid))).filter((t) => /^turn-\d+$/.test(t)); } catch { continue; }
    for (const t of turns) {
      try {
        const m = JSON.parse(await fs.readFile(path.join(base, aid, t, 'manifest.json'), 'utf8'));
        for (const e of Array.isArray(m?.entries) ? m.entries : []) { if (typeof e?.abs === 'string') { out.push(e.abs); } }
      } catch { /* no manifest */ }
      if (out.length >= MAX_EVIDENCE) { return out; }
    }
  }
  return out;
}

/** Scopes stored sessions to the current window's workspace. */
export class SessionScope {
  /** Decisions about legacy sessions, valid for one workspace key. */
  private legacy = new Map<string, Ownership>();
  private legacyKey?: string;

  constructor(private store: SessionStore2, private context: () => ScopeContext, private checkpointsDir?: string) {}

  private cache(): Map<string, Ownership> {
    const key = this.context().key;
    if (key !== this.legacyKey) { this.legacy.clear(); this.legacyKey = key; }
    return this.legacy;
  }

  /** Whose session this is. Pass `recorded` when the caller already read the meta (null = known to have none). */
  async ownership(sid: string, recorded?: string | null): Promise<Ownership> {
    const ctx = this.context();
    const platform = ctx.platform ?? process.platform;
    if (recorded === undefined) {
      const w = await this.store.workspaceOf(sid).catch(() => ({ exists: false, workspace: undefined }));
      if (!w.exists) { return 'unassigned'; } // nothing stored: nothing to leak (callers then report it as missing)
      recorded = w.workspace ?? null;
    }
    if (recorded !== null) { return sameWorkspace(recorded, ctx.key, platform) ? 'mine' : 'other'; }
    const cache = this.cache();
    const known = cache.get(sid);
    if (known) { return known; }
    const loaded = await this.store.loadSession(sid).catch(() => undefined);
    const evidence = [
      ...absolutePathsIn(loaded?.agents ?? [], platform),
      ...(this.checkpointsDir ? await checkpointPaths(this.checkpointsDir, sid) : []),
    ];
    const verdict = classifyEvidence(evidence, ctx);
    if (verdict === 'mine') { await this.store.setWorkspace(sid, ctx.key).catch(() => undefined); }
    cache.set(sid, verdict);
    return verdict;
  }

  /** Keeps this workspace's sessions; legacy sessions nobody can attribute are kept and flagged `unassigned`. */
  async filter<T extends { id: string; workspace?: string }>(items: T[]): Promise<Array<T & { unassigned?: boolean }>> {
    const out: Array<T & { unassigned?: boolean }> = [];
    for (const it of items) {
      const o = await this.ownership(it.id, it.workspace ?? null);
      if (o === 'mine') { out.push(it); } else if (o === 'unassigned') { out.push({ ...it, unassigned: true }); }
    }
    return out;
  }

  /** Whether this window may open / rename / delete the session. */
  async allows(sid: string): Promise<boolean> { return (await this.ownership(sid)) !== 'other'; }

  /** Records the current workspace on a legacy session (no-op when one is already recorded). */
  async claim(sid: string): Promise<void> {
    if (await this.store.setWorkspace(sid, this.context().key).catch(() => false)) { this.cache().set(sid, 'mine'); }
  }
}
