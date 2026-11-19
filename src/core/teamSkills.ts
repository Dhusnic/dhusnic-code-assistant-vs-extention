import { execFile } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { renameWithRetry } from './store';

/**
 * Team skill library. A source is a local or UNC folder used in place, or a git repository kept as a shallow clone in
 * <cacheDir>/<hash>. Each source yields bases for loadSkills: the folders holding `skills/` or `commands/`
 * (the source root, its `.claude` or `.infraon` folder, or the parent when the source itself is a `skills` folder).
 */
export interface TeamSource { kind: 'folder' | 'git'; id: string; name: string; location: string; ref?: string }
export interface TeamSkillBase { base: string; source: 'team'; name: string }
export type GitFn = (args: string[], opts: { cwd?: string; signal?: AbortSignal }) => Promise<{ stdout: string; stderr?: string }>;
export interface SyncOptions { gitFn?: GitFn; signal?: AbortSignal; minIntervalMs?: number; now?: () => number }
export interface SyncResult { skillBases: TeamSkillBase[]; errors: string[]; updated: string[] }

export const DEFAULT_SYNC_INTERVAL_MS = 6 * 3600_000;
const NO_COPY_RETRY_MS = 5 * 60_000;
const GIT_TIMEOUT_MS = 120_000;
const FOLDER_TIMEOUT_MS = 5000;
const GIT_SCHEMES = new Set(['https', 'http', 'ssh', 'git']);
const SCP_RE = /^\w[\w.-]*@\w[\w.-]*:(?!\/\/)\S+$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
// Applied to every network or checkout command. Symlinks stay off so a repository cannot point a skill at a private file.
const HARDENING = ['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', '-c', 'core.symlinks=false', '-c', 'advice.detachedHead=false'];

export const redactUrl = (s: string): string => s.replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***@');

export function isValidRef(ref: unknown): ref is string {
  return typeof ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref)
    && !ref.includes('..') && !ref.includes('//') && !/(\.lock|\/|\.)$/.test(ref) && !ref.includes('/.');
}

const isLocalPath = (s: string): boolean => path.isAbsolute(s) || /^[a-z]:[\\/]/i.test(s) || s.startsWith('\\\\') || /^~[\\/]/.test(s);
const expandHome = (s: string): string => (/^~[\\/]/.test(s) ? path.join(os.homedir(), s.slice(2)) : s);

function classify(s: string): { kind: 'folder' | 'git'; location: string } | { error: string } {
  if (s.startsWith('-')) { return { error: 'must not begin with "-"' }; }
  if (/^[a-z][a-z0-9+.-]*::/i.test(s)) { return { error: 'git transport helpers such as ext:: are not allowed' }; }
  if (/^file:/i.test(s)) {
    try { return { kind: 'folder', location: fileURLToPath(s) }; } catch { return { error: 'not a usable local folder' }; }
  }
  if (isLocalPath(s)) { return { kind: 'folder', location: expandHome(s) }; }
  if (/\s/.test(s)) { return { error: 'a git URL cannot contain spaces' }; }
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s)?.[1].toLowerCase();
  if (scheme) {
    if (!GIT_SCHEMES.has(scheme)) { return { error: `the ${scheme} transport is not allowed` }; }
    let u: URL;
    try { u = new URL(s); } catch { return { error: 'not a valid URL' }; }
    if (!u.hostname || u.hostname.startsWith('-') || u.username.startsWith('-')) { return { error: 'the URL has no usable host' }; }
    if (u.password) { return { error: 'credentials must not be stored in the URL' }; }
    return { kind: 'git', location: s };
  }
  return SCP_RE.test(s) ? { kind: 'git', location: s } : { error: 'expected an absolute folder path or a git URL' };
}

function makeSource(kind: 'folder' | 'git', location: string, ref: string | undefined, name: unknown): TeamSource {
  const id = createHash('sha256').update(`${kind}\0${location}\0${ref ?? ''}`).digest('hex').slice(0, 16);
  const base = location.replace(/[\\/]+$/, '').split(/[\\/:]/).pop()?.replace(/\.git$/i, '') ?? '';
  const label = (typeof name === 'string' && name.trim() ? name.trim() : base).replace(/[^\w.-]+/g, '-').slice(0, 64);
  return { kind, id, name: label || id, location, ...(ref ? { ref } : {}) };
}

function parseEntry(entry: unknown): TeamSource | { error: string } {
  const obj = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined;
  const value = typeof entry === 'string' ? entry : obj?.url ?? obj?.git ?? obj?.path ?? obj?.folder;
  if (typeof value !== 'string' || !value.trim()) { return { error: 'expected a folder path, a git URL, or { url, ref, name }' }; }
  let text = value.trim();
  if (/[\0-\x1f\x7f]/.test(text)) { return { error: 'contains control characters' }; }
  let ref: unknown = obj?.ref;
  if (!isLocalPath(text) && !/^file:/i.test(text) && text.includes('#')) {
    const i = text.indexOf('#');
    ref ??= text.slice(i + 1);
    text = text.slice(0, i);
  }
  const c = classify(text);
  if ('error' in c) { return { error: `"${redactUrl(text)}": ${c.error}` }; }
  if (ref !== undefined && c.kind === 'folder') { return { error: `"${text}": a folder source cannot have a ref` }; }
  if (ref !== undefined && !isValidRef(ref)) { return { error: `"${redactUrl(text)}": invalid ref` }; }
  return makeSource(c.kind, c.location, ref as string | undefined, obj?.name);
}

/** Reads the setting: an array of strings or objects, or one string separated by commas or new lines. */
export function parseTeamSources(raw: unknown): { sources: TeamSource[]; errors: string[] } {
  const errors: string[] = [];
  const sources = new Map<string, TeamSource>();
  if (raw === undefined || raw === null) { return { sources: [], errors }; }
  const items: unknown[] = typeof raw === 'string' ? raw.split(/[\r\n,]+/).filter((s) => s.trim()) : Array.isArray(raw) ? raw : [raw];
  for (const item of items) {
    const r = parseEntry(item);
    if ('error' in r) { errors.push(r.error); } else if (!sources.has(r.id)) { sources.set(r.id, r); }
  }
  return { sources: [...sources.values()], errors };
}

const defaultGit: GitFn = (args, opts) => new Promise((resolve, reject) => {
  execFile('git', args, {
    cwd: opts.cwd, signal: opts.signal, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:http:ssh:git',
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes',
    },
  }, (err, stdout, stderr) => {
    if (err) { reject(new Error(String(stderr).trim().split(/\r?\n/).pop() || err.message)); return; }
    resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});

async function isDir(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

/** An offline network share can hang for a long time; treat that as unreachable. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); timer.unref(); });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

async function findBases(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const c of [root, path.join(root, '.claude'), path.join(root, '.infraon')]) {
    if (await isDir(path.join(c, 'skills')) || await isDir(path.join(c, 'commands'))) { out.push(c); }
  }
  if (!out.length && path.basename(root).toLowerCase() === 'skills') { out.push(path.dirname(root)); }
  return out;
}

interface SourceResult { bases: string[]; error?: string; updated: boolean }
interface SyncState { lastAttemptAt?: number }

async function readState(file: string): Promise<SyncState> {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return typeof s?.lastAttemptAt === 'number' ? { lastAttemptAt: s.lastAttemptAt } : {};
  } catch { return {}; }
}

async function cloneSource(src: TeamSource, dir: string, cacheDir: string, git: (a: string[], cwd?: string) => Promise<{ stdout: string }>): Promise<void> {
  const tmp = path.join(cacheDir, `${src.id}.tmp-${randomBytes(4).toString('hex')}`);
  const sha = src.ref && SHA_RE.test(src.ref);
  try {
    await git([...HARDENING, 'clone', '--depth', '1', '--no-tags', '--single-branch', '--template=', ...(src.ref && !sha ? ['--branch', src.ref] : []), '--', src.location, tmp]);
    if (sha) {
      await git([...HARDENING, 'fetch', '--depth', '1', '--no-tags', '--', 'origin', src.ref as string], tmp);
      await git([...HARDENING, 'checkout', '--detach', 'FETCH_HEAD'], tmp);
    }
    await fs.rm(dir, { recursive: true, force: true });
    try { await renameWithRetry(tmp, dir); } catch (e) {
      if (!await isDir(path.join(dir, '.git'))) { throw e; }           // another window finished the same clone first
    }
  } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined); }
}

async function updateSource(src: TeamSource, dir: string, git: (a: string[], cwd?: string) => Promise<{ stdout: string }>): Promise<boolean> {
  const before = (await git(['rev-parse', 'HEAD'], dir)).stdout.trim();
  await git([...HARDENING, 'fetch', '--depth', '1', '--no-tags', '--', 'origin', src.ref ?? 'HEAD'], dir);
  const after = (await git(['rev-parse', 'FETCH_HEAD'], dir)).stdout.trim();
  if (after === before) { return false; }
  await git([...HARDENING, 'reset', '--hard', 'FETCH_HEAD'], dir);
  await git(['clean', '-ffdx'], dir);
  return true;
}

async function syncGit(src: TeamSource, cacheDir: string, opts: SyncOptions): Promise<SourceResult> {
  const dir = path.join(cacheDir, src.id);
  const stateFile = `${dir}.json`;
  const now = (opts.now ?? Date.now)();
  const interval = opts.minIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  const have = await isDir(path.join(dir, '.git'));
  const wait = have ? interval : Math.min(interval, NO_COPY_RETRY_MS);
  const last = (await readState(stateFile)).lastAttemptAt;
  const copy = async (error?: string, updated = false): Promise<SourceResult> => ({ bases: await isDir(path.join(dir, '.git')) ? await findBases(dir) : [], error, updated });
  if (opts.signal?.aborted) { return copy(`${src.name}: sync cancelled`); }
  if (last !== undefined && now >= last && now - last < wait) { return copy(have ? undefined : `${src.name}: not downloaded yet, will retry shortly`); }
  const gitFn = opts.gitFn ?? defaultGit;
  const git = (args: string[], cwd?: string): Promise<{ stdout: string }> => gitFn(args, { cwd, signal: opts.signal });
  const record = async (): Promise<void> => {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({ lastAttemptAt: now }), 'utf8');
  };
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    const updated = have ? await updateSource(src, dir, git) : (await cloneSource(src, dir, cacheDir, git), true);
    await record();
    return copy(undefined, updated);
  } catch (e: any) {
    if (!opts.signal?.aborted) { await record().catch(() => undefined); }
    return copy(`${src.name}: ${redactUrl(e?.message ?? String(e)).slice(0, 300)}${have ? ' (using the last good copy)' : ''}`);
  }
}

async function syncFolder(src: TeamSource): Promise<SourceResult> {
  try {
    if (!await withTimeout(isDir(src.location), FOLDER_TIMEOUT_MS, 'folder access')) { return { bases: [], error: `${src.name}: folder not found: ${src.location}`, updated: false }; }
    return { bases: await withTimeout(findBases(src.location), FOLDER_TIMEOUT_MS, 'folder access'), updated: false };
  } catch (e: any) { return { bases: [], error: `${src.name}: ${e.message}`, updated: false }; }
}

const running = new Map<string, Promise<SourceResult>>();

/** Concurrent syncs of one source share a single run. */
function syncOne(src: TeamSource, cacheDir: string, opts: SyncOptions): Promise<SourceResult> {
  const key = `${path.resolve(cacheDir)}|${src.id}`;
  const active = running.get(key);
  if (active) { return active; }
  const run = (src.kind === 'git' ? syncGit(src, cacheDir, opts) : syncFolder(src)).finally(() => running.delete(key));
  running.set(key, run);
  return run;
}

/** Brings every source up to date as far as possible. Never rejects: failures are reported and the last good copy is used. */
export async function syncTeamSkills(sources: TeamSource[], cacheDir: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const results = await Promise.all(sources.map((s) => syncOne(s, cacheDir, opts).catch((e: any): SourceResult => ({ bases: [], error: `${s.name}: ${e?.message ?? e}`, updated: false }))));
  const out: SyncResult = { skillBases: [], errors: [], updated: [] };
  results.forEach((r, i) => {
    const name = sources[i].name;
    for (const base of r.bases) { out.skillBases.push({ base, source: 'team', name }); }
    if (r.error) { out.errors.push(r.error); }
    else if (!r.bases.length) { out.errors.push(`${name}: no skills or commands folder found`); }
    if (r.updated) { out.updated.push(name); }
  });
  return out;
}
