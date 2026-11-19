import * as fs from 'fs/promises';
import * as path from 'path';
import { SKIP_DIRS } from './glob';

/**
 * Hierarchical project memory, compatible with Claude Code:
 *   user     ~/.claude/CLAUDE.md, ~/.infraon/INFRAON.md
 *   project  <root>/{CLAUDE,INFRAON,AGENTS}.md (first found per directory wins)
 *   folder   the same names in each folder from the root down to the file being worked on
 * `@import path` (or a bare `@path/to/file.md`) on its own line pulls in another file.
 */
export type MemoryLevel = 'user' | 'project' | 'folder';
export interface MemoryFile {
  path: string; rel: string; level: MemoryLevel; chars: number; exists: boolean;
  /** Set by loadMemoryText when the budget cut this file short or removed it. */
  truncated?: boolean; omitted?: boolean;
}
export interface LoadMemoryOptions { activeFile?: string; touched?: string[]; maxChars?: number; cache?: MemoryCache }

export const MEMORY_NAMES = ['CLAUDE.md', 'INFRAON.md', 'AGENTS.md'];
export const DEFAULT_MEMORY_CHARS = 30000;
export const MAX_IMPORT_DEPTH = 3;
export const TRUNCATION_MARK = '\n[... truncated to fit the memory budget]';
export const OMISSION_MARK = '[omitted to fit the memory budget]';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_EXPANDED_CHARS = 1024 * 1024;
const MAX_CACHE_ENTRIES = 256;
const MAX_FOLDERS = 64;
const MIN_KEEP_CHARS = 200;
const MISSING = 'missing';
const IMPORT_RE = /^\s*@(import\s+)?(\S.*?)\s*$/;

const STARTER = `# Project memory

Notes here are given to the assistant in every conversation in this folder.

## Commands

## Conventions
`;

const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

function inside(base: string, p: string): boolean {
  const r = path.relative(fold(base), fold(p));
  return r === '' || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
}

const realOr = (p: string): Promise<string> => fs.realpath(p).catch(() => path.resolve(p));

/** Where a memory file may read from. `confine` also applies the bases to the file itself (a repo's symlinks are not trusted). */
interface Scope { bases: string[]; confine: boolean }
interface Entry { text: string | undefined; deps: Map<string, string> }
interface Expansion { bases: string[]; realBases: string[]; deps: Map<string, string>; left: number }

/** Parsed memory keyed by file; a hit costs one stat per file involved (imports included) and no reads. */
export class MemoryCache {
  private entries = new Map<string, Entry>();
  statCalls = 0;
  readCalls = 0;

  clear(): void { this.entries.clear(); }

  async signature(file: string): Promise<string> {
    this.statCalls++;
    try {
      const s = await fs.stat(file);
      return s.isFile() ? `${s.mtimeMs}:${s.size}` : MISSING;
    } catch { return MISSING; }
  }

  /** The file's text with imports expanded, or undefined when it is missing or refused. */
  async load(file: string, scope: Scope): Promise<string | undefined> {
    const key = `${scope.confine ? 1 : 0}|${scope.bases.join('|')}|${file}`;
    const hit = this.entries.get(key);
    if (hit) {
      const files = [...hit.deps.keys()];
      const sigs = await Promise.all(files.map((f) => this.signature(f)));
      if (files.every((f, i) => hit.deps.get(f) === sigs[i])) {
        this.entries.delete(key);
        this.entries.set(key, hit);
        return hit.text;
      }
      this.entries.delete(key);
    }
    const deps = new Map<string, string>();
    const text = await this.loadFresh(file, scope, deps);
    this.entries.set(key, { text, deps });
    if (this.entries.size > MAX_CACHE_ENTRIES) { this.entries.delete(this.entries.keys().next().value as string); }
    return text;
  }

  private async loadFresh(file: string, scope: Scope, deps: Map<string, string>): Promise<string | undefined> {
    const realBases = await Promise.all(scope.bases.map(realOr));
    const real = await realOr(file);
    if (scope.confine && !realBases.some((b) => inside(b, real))) { deps.set(file, await this.signature(file)); return undefined; }
    return this.expand(file, { bases: scope.bases, realBases, deps, left: MAX_EXPANDED_CHARS }, 0, [fold(real)]);
  }

  private async read(file: string, deps: Map<string, string>): Promise<string | undefined> {
    const sig = await this.signature(file);
    deps.set(file, sig);
    if (sig === MISSING) { return undefined; }
    this.readCalls++;
    try {
      const fh = await fs.open(file, 'r');
      try {
        const size = (await fh.stat()).size;
        const buf = Buffer.alloc(Math.min(size, MAX_FILE_BYTES));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const text = buf.subarray(0, bytesRead).toString('utf8').replace(/^﻿/, '');
        if (text.includes('\0')) { return '[binary file skipped]'; }
        return size > MAX_FILE_BYTES ? `${text}\n[... file too large, truncated]` : text;
      } finally { await fh.close(); }
    } catch { return undefined; }
  }

  private async expand(file: string, ctx: Expansion, depth: number, stack: string[]): Promise<string | undefined> {
    const raw = await this.read(file, ctx.deps);
    if (raw === undefined) { return undefined; }
    const out: string[] = [];
    let fence: string | undefined;
    for (const line of raw.split(/\r?\n/)) {
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (f) {
        if (!fence) { fence = f[1][0]; } else if (fence === f[1][0]) { fence = undefined; }
        out.push(line);
        continue;
      }
      const m = fence ? null : IMPORT_RE.exec(line);
      if (!m) { out.push(line); continue; }
      const spec = m[2].replace(/^["']|["']$/g, '');
      const explicit = !!m[1];
      // A bare "@name" is usually a mention or decorator; it only counts when it looks like a path.
      if (!explicit && (/\s/.test(spec) || !/[./\\]/.test(spec))) { out.push(line); continue; }
      out.push(await this.importLine(spec, line, explicit, file, ctx, depth, stack));
    }
    return out.join('\n');
  }

  private async importLine(spec: string, line: string, explicit: boolean, from: string, ctx: Expansion, depth: number, stack: string[]): Promise<string> {
    const note = (why: string): string => `[import ${why}: ${spec}]`;
    if (/^[a-z][a-z0-9+.-]*:|^[\\/~]/i.test(spec)) { return note('refused, not a relative path'); }
    const target = path.resolve(path.dirname(from), spec.replace(/\\/g, '/'));
    if (!ctx.bases.some((b) => inside(b, target))) { return note('refused, outside the allowed folders'); }
    if (await this.signature(target) === MISSING) {
      ctx.deps.set(target, MISSING);
      return explicit ? note('not found') : line;
    }
    const real = await realOr(target);
    if (!ctx.realBases.some((b) => inside(b, real))) { ctx.deps.set(target, await this.signature(target)); return note('refused, outside the allowed folders'); }
    if (stack.includes(fold(real))) { return note('skipped, cycle'); }
    if (depth >= MAX_IMPORT_DEPTH) { return note(`skipped, deeper than ${MAX_IMPORT_DEPTH} levels`); }
    if (ctx.left <= 0) { return note('skipped, too much imported text'); }
    const body = await this.expand(target, ctx, depth + 1, [...stack, fold(real)]);
    if (body === undefined) { return note('not found'); }
    ctx.left -= body.length;
    return body;
  }
}

let sharedCache: MemoryCache | undefined;
const shared = (): MemoryCache => (sharedCache ??= new MemoryCache());

interface Loaded { file: MemoryFile; text: string }

async function firstIn(dir: string, cache: MemoryCache): Promise<string | undefined> {
  for (const n of MEMORY_NAMES) {
    const f = path.join(dir, n);
    if (await cache.signature(f) !== MISSING) { return f; }
  }
  return undefined;
}

async function loadEntry(file: string, rel: string, level: MemoryLevel, scope: Scope, cache: MemoryCache): Promise<Loaded> {
  const text = await cache.load(file, scope);
  return { file: { path: file, rel, level, chars: text?.length ?? 0, exists: text !== undefined }, text: text ?? '' };
}

const userFiles = (home: string): Array<{ file: string; rel: string }> => [
  { file: path.join(home, '.claude', 'CLAUDE.md'), rel: '~/.claude/CLAUDE.md' },
  { file: path.join(home, '.infraon', 'INFRAON.md'), rel: '~/.infraon/INFRAON.md' },
];
const userScope = (root: string, home: string): Scope => ({ bases: [path.resolve(home), path.resolve(root)], confine: false });
// Project content is untrusted (it may arrive with a clone), so it can never import from the home folder.
const projectScope = (root: string): Scope => ({ bases: [path.resolve(root)], confine: true });

async function baseEntries(root: string, home: string, cache: MemoryCache): Promise<Loaded[]> {
  const out: Loaded[] = [];
  for (const u of userFiles(home)) {
    if (await cache.signature(u.file) === MISSING) { continue; }
    const e = await loadEntry(u.file, u.rel, 'user', userScope(root, home), cache);
    if (e.file.exists) { out.push(e); }
  }
  const f = await firstIn(root, cache);
  if (f && !out.some((e) => fold(e.file.path) === fold(f))) {
    const e = await loadEntry(f, path.basename(f), 'project', projectScope(root), cache);
    if (e.file.exists) { out.push(e); }
  }
  return out;
}

/** Folders (relative, shallowest first, root excluded) whose memory applies to a file. */
function folderChain(root: string, file: string): string[] {
  const rel = (path.isAbsolute(file) ? path.relative(root, file) : file).replace(/\\/g, '/');
  const parts = rel.split('/').filter((p) => p && p !== '.');
  if (path.isAbsolute(rel) || /^[a-z]:/i.test(rel) || parts.includes('..')) { return []; }
  const out: string[] = [];
  for (const p of parts.slice(0, -1)) {
    if (SKIP_DIRS.has(p)) { break; }                                  // vendored and generated trees do not speak for the project
    out.push(out.length ? `${out[out.length - 1]}/${p}` : p);
  }
  return out;
}

async function folderEntries(root: string, dirs: string[], cache: MemoryCache): Promise<Loaded[]> {
  const out: Loaded[] = [];
  for (const d of dirs) {
    const f = await firstIn(path.join(root, d), cache);
    if (!f) { continue; }
    const e = await loadEntry(f, `${d}/${path.basename(f)}`, 'folder', projectScope(root), cache);
    if (e.file.exists) { out.push(e); }
  }
  return out;
}

/** User level files plus the project root file, least specific first. Only files that exist. */
export async function discoverMemory(root: string, home: string, cache: MemoryCache = shared()): Promise<MemoryFile[]> {
  return (await baseEntries(root, home, cache)).map((e) => e.file);
}

/** Folder level files from just below the root down to `relFile`'s directory. The root's own file comes from discoverMemory. */
export async function memoryForPath(root: string, relFile: string, cache: MemoryCache = shared()): Promise<MemoryFile[]> {
  return (await folderEntries(root, folderChain(root, relFile), cache)).map((e) => e.file);
}

function cut(s: string, n: number): string {
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

interface Section { file: MemoryFile; head: string; body: string; gone?: boolean }

/** Trims the least specific sections first until the rendered text fits. */
function fitBudget(sections: Section[], max: number): void {
  const total = (): number => {
    const live = sections.filter((s) => !s.gone);
    return live.reduce((n, s) => n + s.head.length + 1 + s.body.length, 0) + Math.max(0, live.length - 1) * 2;
  };
  sections.forEach((s, i) => {
    const over = total() - max;
    if (over <= 0) { return; }
    const keep = s.body.length - over - TRUNCATION_MARK.length;
    if (keep >= (i === sections.length - 1 ? 1 : MIN_KEEP_CHARS)) { s.body = cut(s.body, keep) + TRUNCATION_MARK; s.file.truncated = true; }
    else { s.body = OMISSION_MARK; s.file.omitted = true; }
  });
  for (const s of sections) {
    if (total() <= max) { return; }
    s.gone = true;
    s.file.omitted = true;
  }
}

/** The memory text for one LLM call: a labelled section per file, most specific last, never longer than maxChars. */
export async function loadMemoryText(root: string, home: string, opts: LoadMemoryOptions = {}): Promise<{ text: string; files: MemoryFile[] }> {
  const cache = opts.cache ?? shared();
  const max = Math.max(0, Math.floor(opts.maxChars ?? DEFAULT_MEMORY_CHARS));
  const active = opts.activeFile ? folderChain(root, opts.activeFile) : [];
  const others = [...new Set((opts.touched ?? []).flatMap((f) => folderChain(root, f)))]
    .filter((d) => !active.includes(d))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const entries = [...await baseEntries(root, home, cache), ...await folderEntries(root, [...others, ...active].slice(-MAX_FOLDERS), cache)];
  const files = entries.map((e) => ({ ...e.file }));
  const sections: Section[] = entries
    .map((e, i) => ({ file: files[i], head: `--- Memory: ${e.file.rel} (${e.file.level}) ---`, body: e.text.trim() }))
    .filter((s) => s.body);
  fitBudget(sections, max);
  const text = sections.filter((s) => !s.gone).map((s) => `${s.head}\n${s.body}`).join('\n\n');
  return { text: text.length > max ? cut(text, max) : text, files };
}

/** Entries for a /memory picker, including the files that could be created. */
export async function listEditableMemory(root: string, home: string, activeFile?: string, cache: MemoryCache = shared()): Promise<MemoryFile[]> {
  const out: MemoryFile[] = [];
  for (const u of userFiles(home)) { out.push((await loadEntry(u.file, u.rel, 'user', userScope(root, home), cache)).file); }
  const rootFile = (await firstIn(root, cache)) ?? path.join(root, MEMORY_NAMES[0]);
  out.push((await loadEntry(rootFile, path.basename(rootFile), 'project', projectScope(root), cache)).file);
  const chain = activeFile ? folderChain(root, activeFile) : [];
  for (const d of chain) {
    const f = await firstIn(path.join(root, d), cache);
    if (f) { out.push((await loadEntry(f, `${d}/${path.basename(f)}`, 'folder', projectScope(root), cache)).file); }
    else if (d === chain[chain.length - 1]) {
      out.push({ path: path.join(root, d, MEMORY_NAMES[0]), rel: `${d}/${MEMORY_NAMES[0]}`, level: 'folder', chars: 0, exists: false });
    }
  }
  return out;
}

/** Creates a memory file from the starter template. An existing file is left alone (`created: false`). */
export async function createMemoryFile(file: string): Promise<{ path: string; created: boolean }> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, STARTER, { encoding: 'utf8', flag: 'wx' });
    return { path: file, created: true };
  } catch (e: any) {
    if (e.code === 'EEXIST') { return { path: file, created: false }; }
    throw e;
  }
}
