import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { ReadTracker, Tool, ToolCtx, WorkspaceRoot, fnSpec } from './tool';
import { withFileLock } from './locks';
import { SKIP_DIRS, filterFiles, globToRegex, hasGlobChars, matchesGlob } from './glob';
import { EnginePreference, FileIndex, SearchMode, SearchOptions, formatSearch, search } from './search';
import { CodeIndex, formatCodeHits } from './codeSearch';
import { reportNewErrors, takeBaseline } from './editDiagnostics';
import type { SemanticRanker } from './hybridSearch';
import { createFileOpsTools } from './fileOps';

export { SKIP_DIRS, globToRegex, matchesGlob };

export const MAX_OUT = 20000;

export function resolveSafe(root: string, p: string): string {
  const abs = path.resolve(root, p || '.');
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { throw new Error(`Path outside workspace: ${p}`); }
  return abs;
}

const samePath = (a: string, b: string): boolean => {
  const x = path.resolve(a), y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

const inside = (root: string, abs: string): boolean => {
  const rel = path.relative(root, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** The workspace folder that contains abs (the most specific one when folders are nested). */
export function rootOf(ctx: { root: string; roots?: WorkspaceRoot[] }, abs: string): WorkspaceRoot | undefined {
  const all = [{ name: path.basename(ctx.root), path: ctx.root }, ...(ctx.roots ?? []).filter((r) => !samePath(r.path, ctx.root))];
  return all.filter((r) => inside(path.resolve(r.path), path.resolve(abs))).sort((a, b) => b.path.length - a.path.length)[0];
}

/**
 * Resolves a tool path in a (possibly multi-root) workspace. Relative paths are under the primary root, except
 * "<folder name>/..." which addresses another workspace folder when the primary root has no such entry.
 * Absolute paths may point into any workspace folder. Anything else is refused.
 */
export function resolveIn(ctx: { root: string; roots?: WorkspaceRoot[] }, p: string): string {
  const raw = String(p ?? '') || '.';
  const others = (ctx.roots ?? []).filter((r) => !samePath(r.path, ctx.root));
  if (path.isAbsolute(raw)) {
    const abs = path.resolve(raw);
    if (inside(ctx.root, abs) || others.some((r) => inside(path.resolve(r.path), abs))) { return abs; }
    throw new Error(`Path outside workspace: ${p}`);
  }
  const [first, ...rest] = raw.split(/[\\/]+/);
  const named = others.find((r) => r.name.toLowerCase() === first.toLowerCase());
  if (named && !existsSync(path.join(ctx.root, first))) { return resolveSafe(named.path, rest.join('/') || '.'); }
  return resolveSafe(ctx.root, raw);
}

/** resolveIn, plus absolute paths inside ctx.readOnlyRoots (skill folders). Only read tools may call this. */
export function resolveReadable(ctx: { root: string; roots?: WorkspaceRoot[]; readOnlyRoots?: string[] }, p: string): string {
  try { return resolveIn(ctx, p); } catch (e) {
    const raw = String(p ?? '');
    if (path.isAbsolute(raw)) {
      const abs = path.resolve(raw);
      if ((ctx.readOnlyRoots ?? []).some((r) => inside(path.resolve(r), abs))) { return abs; }
    }
    throw e;
  }
}

/** Where a search runs: the folder, the sub-path inside it, and the prefix that makes its results round-trip. */
function searchScope(ctx: ToolCtx, p: unknown): { root: string; rel?: string; prefix: string } {
  if (!p) { return { root: ctx.root, prefix: '' }; }
  const abs = resolveIn(ctx, String(p));
  const r = rootOf(ctx, abs) ?? { name: '', path: ctx.root };
  const primary = samePath(r.path, ctx.root);
  const rel = path.relative(r.path, abs).split(path.sep).join('/');
  return { root: primary ? ctx.root : r.path, rel: rel || undefined, prefix: primary ? '' : `${r.name}/` };
}

export const clip = (s: string, max = MAX_OUT): string =>
  (s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s);

/** Lines worth keeping from the middle of long command output: they usually explain a failure. */
const PROBLEM_LINE = /\b(error|errors|failed|failure|failing|fail|exception|traceback|panic|assert(ion)?|fatal|warning)\b|✗|✖|×|^\s*(at |File ")/i;

/**
 * Shortens long command output for the model. Builds and test runners print their summary and the reason for a
 * failure at the END, so this keeps the start, the end, and the error-looking lines in between, not just the start.
 */
export function clipOutput(s: string, max = MAX_OUT): string {
  if (s.length <= max) { return s; }
  const headBudget = Math.floor(max * 0.25);
  const tailBudget = Math.floor(max * 0.5);
  const midBudget = max - headBudget - tailBudget;
  const cut = (t: string, n: number, fromEnd: boolean): string => {
    if (t.length <= n) { return t; }
    const piece = fromEnd ? t.slice(t.length - n) : t.slice(0, n);
    const nl = fromEnd ? piece.indexOf('\n') : piece.lastIndexOf('\n');
    return nl > 0 && nl < piece.length - 1 ? (fromEnd ? piece.slice(nl + 1) : piece.slice(0, nl)) : piece;
  };
  const head = cut(s, headBudget, false);
  const tail = cut(s, tailBudget, true);
  const middle = s.slice(head.length, s.length - tail.length);
  const picked: string[] = [];
  let used = 0;
  for (const line of middle.split('\n')) {
    if (!PROBLEM_LINE.test(line)) { continue; }
    const l = line.length > 400 ? `${line.slice(0, 400)}…` : line;
    if (used + l.length + 1 > midBudget) { break; }
    picked.push(l);
    used += l.length + 1;
  }
  const omitted = middle.length - used;
  const mid = picked.length
    ? `\n...[${omitted} chars omitted; error-looking lines from the omitted part:]\n${picked.join('\n')}\n...[end of omitted part]\n`
    : `\n...[${omitted} chars omitted]\n`;
  return `${head}${mid}${tail}`;
}

/** Walks the workspace yielding POSIX-style relative file paths. */
export async function* walkFiles(root: string, signal?: AbortSignal, dir = root): AsyncGenerator<string> {
  let ents;
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (signal?.aborted) { return; }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) { continue; }
      yield* walkFiles(root, signal, path.join(dir, e.name));
    } else if (e.isFile()) {
      yield path.relative(root, path.join(dir, e.name)).split(path.sep).join('/');
    }
  }
}

export async function findFiles(root: string, glob: string, limit = 200, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  for await (const f of walkFiles(root, signal)) {
    if (matchesGlob(f, glob)) { out.push(f); if (out.length >= limit) { break; } }
  }
  return out;
}

/** ssh, scp and friends cannot log in from here: they wait for a password prompt nobody can answer. */
export function remoteShellHint(command: unknown): string | undefined {
  const text = String(command ?? '');
  if (!/(^|[;&|(\s])(ssh|scp|sftp|sshpass|plink|pscp)(\.exe)?(\s|$)/i.test(text)) { return undefined; }
  return 'ssh, scp and sftp cannot be used through run_command: they wait for a password prompt that nobody can answer. '
    + 'Use list_servers and remote_exec (or remote_upload / remote_download) instead. If the server is not saved yet, call connect_server with its address: the user enters the credentials in a secure prompt and the server is saved.';
}

export const MAX_COMMAND_TIMEOUT_S = 600;
export const commandTimeoutMs = (seconds: unknown): number => {
  const n = Number(seconds);
  return (Number.isFinite(n) && n > 0 ? Math.min(MAX_COMMAND_TIMEOUT_S, Math.max(1, n)) : 120) * 1000;
};

export function runShell(command: string, ctx: ToolCtx, timeoutMs = 120000, cwd = ctx.root): Promise<string> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    // No input: a command that waits for a password or a key press fails at once instead of hanging.
    // On POSIX the command gets its own process group so the whole tree can be stopped.
    const p = spawn(isWin ? 'powershell.exe' : 'bash', isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !isWin,
    });
    let out = '', note = '', done = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (done) { return; }
      done = true;
      clearTimeout(timer); clearTimeout(grace);
      ctx.signal.removeEventListener('abort', abort);
      // The exit line stays outside the clipping so it is always the last line the model sees.
      resolve(`${clipOutput(`${out}${note}`)}\n[exit ${code}]`);
    };
    // Killing only the shell would leave its children (ssh.exe, servers, watchers) running and holding the output
    // open, so the call would never return. Stop the whole tree, then stop waiting shortly after.
    const killTree = () => {
      if (!p.pid) { return; }
      if (isWin) { spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined); }
      else { try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch { /* already gone */ } } }
    };
    const stop = (why: string) => {
      if (done || grace) { return; }
      note = why;
      killTree();
      grace = setTimeout(() => finish(null), 3000);
    };
    const timer = setTimeout(() => stop(`\n[stopped after ${timeoutMs / 1000}s: the command and every process it started were ended. Run long tasks in the background (for example with run_in_terminal).]`), timeoutMs);
    const abort = () => stop('\n[cancelled]');
    ctx.signal.addEventListener('abort', abort, { once: true });
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    // A child that outlives the shell can keep the pipes open, so 'exit' also ends the wait after a moment.
    p.on('exit', (code) => { if (!done) { setTimeout(() => finish(code), 1500); } });
    p.on('close', (code) => finish(code));
    p.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); ctx.signal.removeEventListener('abort', abort); resolve(`ERROR: ${e.message}`); } });
  });
}

/** Remembers the size and modification time of each file when the agent read it (per agent). */
export class FileReadTracker implements ReadTracker {
  private seen = new Map<string, string>();
  private key(abs: string): string { const p = path.resolve(abs); return process.platform === 'win32' ? p.toLowerCase() : p; }
  private async stamp(abs: string): Promise<string | undefined> {
    try { const s = await fs.stat(abs); return `${s.mtimeMs}:${s.size}`; } catch { return undefined; }
  }
  async markRead(abs: string): Promise<void> { const s = await this.stamp(abs); if (s) { this.seen.set(this.key(abs), s); } }
  async markWritten(abs: string): Promise<void> { return this.markRead(abs); }
  async check(abs: string, display: string): Promise<string | undefined> {
    const now = await this.stamp(abs);
    if (!now) { return undefined; }
    const then = this.seen.get(this.key(abs));
    if (!then) { return `You have not read ${display} yet. Read it with read_file first, so your edit is based on its current contents.`; }
    if (then !== now) { return `${display} changed on disk since you last read it (edited by the user, a tool or another agent). Read it again before editing.`; }
    return undefined;
  }
  clear(): void { this.seen.clear(); }
}

async function ensureFresh(ctx: ToolCtx, abs: string, display: string): Promise<void> {
  const problem = await ctx.reads?.check(abs, display);
  if (problem) { throw new Error(problem); }
}

/** How a file is stored on disk, so an edit can write it back the same way. */
export interface TextFormat { bom: boolean; crlf: boolean }

/** Splits a file's text into its format and LF-only content. */
export function decodeText(raw: string): { text: string; format: TextFormat } {
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  const crlf = (body.match(/\r\n/g)?.length ?? 0) > 0 && (body.match(/\r\n/g)!.length * 2 >= (body.match(/\n/g)?.length ?? 0));
  return { text: body.replace(/\r\n/g, '\n'), format: { bom, crlf } };
}

export function encodeText(text: string, format: TextFormat): string {
  const lf = text.replace(/\r\n/g, '\n');
  return `${format.bom ? '﻿' : ''}${format.crlf ? lf.replace(/\n/g, '\r\n') : lf}`;
}

const lf = (s: unknown): string => String(s ?? '').replace(/\r\n/g, '\n');

/** Finds old (LF text) in text ignoring trailing whitespace on each line. Returns [start, end) offsets of every match. */
function looseMatches(text: string, old: string): Array<[number, number]> {
  const lines = text.split('\n');
  const want = old.split('\n').map((l) => l.trimEnd());
  while (want.length > 1 && want[want.length - 1] === '') { want.pop(); }
  if (!want.some((l) => l.trim())) { return []; }
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) { starts.push(off); off += l.length + 1; }
  const out: Array<[number, number]> = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length && ok; j++) { ok = lines[i + j].trimEnd() === want[j]; }
    if (ok) {
      const last = i + want.length - 1;
      out.push([starts[i], starts[last] + lines[last].length]);
    }
  }
  return out;
}

/** When old_string is not found: show the lines that look most like it, so the model can copy them exactly. */
export function closestMatchHint(text: string, old: string): string {
  const first = old.split('\n').map((l) => l.trim()).find((l) => l.length > 2);
  if (!first) { return ''; }
  const lines = text.split('\n');
  const words = new Set(first.split(/\W+/).filter((w) => w.length > 1));
  let best = -1, bestScore = 0;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (!t) { return; }
    let score = t === first ? 1000 : t.includes(first) || first.includes(t) ? 100 : 0;
    for (const w of t.split(/\W+/)) { if (words.has(w)) { score++; } }
    if (score > bestScore) { bestScore = score; best = i; }
  });
  if (best < 0 || bestScore < Math.min(2, words.size)) { return ''; }
  const span = old.split('\n').length;
  const from = Math.max(0, best - 2), to = Math.min(lines.length, best + span + 2);
  return `\nThe closest text in the file is near line ${best + 1}:\n${lines.slice(from, to).map((l, i) => `${from + i + 1}\t${l}`).join('\n')}\nRead the file again and copy old_string exactly (without the line-number prefixes).`;
}

export interface EditOp { old_string: string; new_string: string; replace_all?: boolean }

/** Applies one edit to LF text. Tolerates CRLF/LF differences and trailing whitespace; throws with a useful hint. */
export function applyEdit(text: string, op: EditOp, label = 'old_string'): string {
  const old = lf(op.old_string);
  const neu = lf(op.new_string);
  if (!old) { throw new Error(`${label} must not be empty.`); }
  if (old === neu) { throw new Error(`${label} and new_string are identical; nothing to change.`); }
  const exact = text.split(old).length - 1;
  if (exact === 1 || (exact > 1 && op.replace_all)) {
    return op.replace_all ? text.split(old).join(neu) : text.replace(old, () => neu);
  }
  if (exact > 1) { throw new Error(`${label} matches ${exact} places; add surrounding lines to make it unique, or set replace_all to change every one.`); }
  const loose = looseMatches(text, old);
  if (loose.length === 1 || (loose.length > 1 && op.replace_all)) {
    let out = text;
    for (const [s, e] of [...loose].reverse()) { out = out.slice(0, s) + neu.replace(/\n$/, '') + out.slice(e); }
    return out;
  }
  if (loose.length > 1) { throw new Error(`${label} matches ${loose.length} places (ignoring trailing spaces); add surrounding lines to make it unique.`); }
  throw new Error(`${label} not found.${closestMatchHint(text, old)}`);
}

async function computeEdits(path_: string, ops: EditOp[], ctx: ToolCtx): Promise<{ abs: string; oldText: string; newText: string }> {
  const abs = resolveIn(ctx, path_);
  await ensureFresh(ctx, abs, path_);
  const oldText = await fs.readFile(abs, 'utf8');
  const { text, format } = decodeText(oldText);
  let cur = text;
  ops.forEach((op, i) => { cur = applyEdit(cur, op, ops.length > 1 ? `edits[${i}].old_string` : 'old_string'); });
  return { abs, oldText, newText: encodeText(cur, format) };
}

const computeEdit = (args: any, ctx: ToolCtx) => computeEdits(args.path, [args], ctx);

function multiOps(args: any): EditOp[] {
  if (!Array.isArray(args.edits) || !args.edits.length) { throw new Error('edits must be a non-empty array of {old_string, new_string}.'); }
  return args.edits;
}

export interface FsToolsOptions {
  index?: FileIndex; rgPath?: string; prefer?: EnginePreference;
  /** Embedding re-ranking for search_code in a workspace folder (hybridSearch.ts); BM25 only when absent. */
  semantic?: (root: string) => SemanticRanker | undefined;
}

const SEARCH_MODES: SearchMode[] = ['content', 'files', 'count'];
const MAX_GLOB_RESULTS = 200;

const MAX_TREE_ENTRIES = 500;

/** An indented folder tree, folders first, capped at MAX_TREE_ENTRIES lines. */
async function listTree(abs: string, depth: number, signal: AbortSignal): Promise<string> {
  const lines: string[] = [];
  let more = 0;
  const walk = async (dir: string, level: number): Promise<void> => {
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
    for (const e of ents) {
      if (signal.aborted) { return; }
      if (lines.length >= MAX_TREE_ENTRIES) { more++; continue; }
      const pad = '  '.repeat(level);
      if (!e.isDirectory()) { lines.push(`${pad}${e.name}`); continue; }
      if (SKIP_DIRS.has(e.name)) { lines.push(`${pad}${e.name}/ (skipped)`); continue; }
      lines.push(`${pad}${e.name}/`);
      if (level + 1 < depth) { await walk(path.join(dir, e.name), level + 1); }
    }
  };
  await walk(abs, 0);
  if (!lines.length) { return '(empty)'; }
  return more ? `${lines.join('\n')}\n[${more} more entries; list a sub-folder or lower depth]` : lines.join('\n');
}

export function createFsTools(opts: FsToolsOptions = {}): Tool[] {
  const indexes = new Map<string, FileIndex>();
  const indexFor = (root: string): FileIndex => {
    if (opts.index && opts.index.root === root) { return opts.index; }
    let idx = indexes.get(root);
    if (!idx) { idx = new FileIndex(root); indexes.set(root, idx); }
    return idx;
  };
  const codeIndexes = new Map<string, CodeIndex>();
  const codeIndexFor = (root: string): CodeIndex => {
    let idx = codeIndexes.get(root);
    if (!idx) { idx = new CodeIndex(root, indexFor(root), opts.semantic?.(root)); codeIndexes.set(root, idx); }
    return idx;
  };
  return [
    {
      kind: 'read',
      spec: fnSpec('read_file', 'Read a text file. Optional 1-based line range.',
        { path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } }, ['path']),
      describe: (a) => `Read ${a.path}`,
      async run(a, ctx) {
        const abs = resolveReadable(ctx, a.path);
        const lines = (await fs.readFile(abs, 'utf8')).split('\n');
        await ctx.reads?.markRead(abs);
        const s = Math.max(1, a.start_line ?? 1), e = Math.min(lines.length, a.end_line ?? lines.length);
        return clip(lines.slice(s - 1, e).map((l, i) => `${s + i}\t${l}`).join('\n'));
      },
    },
    {
      kind: 'edit',
      spec: fnSpec('write_file', 'Create or fully overwrite a file.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
      describe: (a) => `Write ${a.path}`,
      async preview(a, ctx) {
        const abs = resolveIn(ctx, a.path);
        await ensureFresh(ctx, abs, a.path);
        let oldText = '';
        try { oldText = await fs.readFile(abs, 'utf8'); } catch { /* new file */ }
        return { path: a.path, oldText, newText: oldText ? encodeText(String(a.content), decodeText(oldText).format) : String(a.content) };
      },
      async run(a, ctx) {
        const abs = resolveIn(ctx, a.path);
        const base = takeBaseline(ctx.diagnostics, abs, !existsSync(abs));
        await withFileLock(abs, async () => {
          await ensureFresh(ctx, abs, a.path);
          await ctx.snapshot(abs);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          // Overwriting an existing file keeps its line endings and BOM, so the diff shows only real changes.
          let content = String(a.content);
          try { content = encodeText(content, decodeText(await fs.readFile(abs, 'utf8')).format); } catch { /* new file */ }
          await fs.writeFile(abs, content, 'utf8');
          await ctx.reads?.markWritten(abs);
        });
        indexFor(rootOf(ctx, abs)?.path ?? ctx.root).invalidate();
        return `Wrote ${a.path}${await reportNewErrors(ctx.diagnostics, abs, a.path, base, ctx.signal)}`;
      },
    },
    {
      kind: 'edit',
      spec: fnSpec('edit_file',
        'Replace old_string with new_string in a file. old_string must match exactly one place (copy it from read_file without the line-number prefixes; include a few surrounding lines to make it unique). Line endings (CRLF/LF) and trailing spaces are matched loosely, and the file keeps its own line endings. Set replace_all to change every occurrence (e.g. a rename).',
        { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean', description: 'replace every occurrence (default false)' } },
        ['path', 'old_string', 'new_string']),
      describe: (a) => `Edit ${a.path}`,
      async preview(a, ctx) { const e = await computeEdit(a, ctx); return { path: a.path, oldText: e.oldText, newText: e.newText }; },
      async run(a, ctx) {
        // Re-read inside the lock: another agent may have changed the file since the preview.
        const abs = resolveIn(ctx, a.path);
        const base = takeBaseline(ctx.diagnostics, abs);
        await withFileLock(abs, async () => {
          const e = await computeEdit(a, ctx);
          await ctx.snapshot(e.abs);
          await fs.writeFile(e.abs, e.newText, 'utf8');
          await ctx.reads?.markWritten(e.abs);
        });
        return `Edited ${a.path}${await reportNewErrors(ctx.diagnostics, abs, a.path, base, ctx.signal)}`;
      },
    },
    {
      kind: 'edit',
      spec: fnSpec('multi_edit',
        'Make several edits to ONE file in a single step. Edits apply in order, each to the result of the previous one; if any edit fails, none are applied. Same matching rules as edit_file. Prefer this over several edit_file calls on the same file.',
        {
          path: { type: 'string' },
          edits: {
            type: 'array', minItems: 1,
            items: {
              type: 'object',
              properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
              required: ['old_string', 'new_string'],
            },
          },
        }, ['path', 'edits']),
      describe: (a) => `Edit ${a.path} (${Array.isArray(a.edits) ? a.edits.length : 0} changes)`,
      async preview(a, ctx) { const e = await computeEdits(a.path, multiOps(a), ctx); return { path: a.path, oldText: e.oldText, newText: e.newText }; },
      async run(a, ctx) {
        const ops = multiOps(a);
        const abs = resolveIn(ctx, a.path);
        const base = takeBaseline(ctx.diagnostics, abs);
        await withFileLock(abs, async () => {
          const e = await computeEdits(a.path, ops, ctx);
          await ctx.snapshot(e.abs);
          await fs.writeFile(e.abs, e.newText, 'utf8');
          await ctx.reads?.markWritten(e.abs);
        });
        return `Edited ${a.path} (${ops.length} changes)${await reportNewErrors(ctx.diagnostics, abs, a.path, base, ctx.signal)}`;
      },
    },
    {
      kind: 'read',
      spec: fnSpec('list_dir', 'List a folder. depth 1 (default) lists its entries; depth 2-6 shows the folder tree, skipping node_modules, .git and build output.',
        { path: { type: 'string' }, depth: { type: 'number', description: 'levels to show, 1-6 (default 1)' } }, ['path']),
      describe: (a) => `List ${a.path || '.'}${a.depth > 1 ? ` (depth ${a.depth})` : ''}`,
      async run(a, ctx) {
        const abs = resolveReadable(ctx, a.path);
        const depth = Math.min(6, Math.max(1, Math.floor(Number(a.depth) || 1)));
        if (depth === 1) {
          const ents = await fs.readdir(abs, { withFileTypes: true });
          return ents.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') || '(empty)';
        }
        return listTree(abs, depth, ctx.signal);
      },
    },
    {
      kind: 'read',
      spec: fnSpec('glob_files',
        'Find files by glob (e.g. **/*.py, src/**/*.ts) or by a name fragment (e.g. "cmdb_controller"). Respects .gitignore. Best name matches come first.',
        { pattern: { type: 'string' }, path: { type: 'string', description: 'optional sub-directory to search in' } }, ['pattern']),
      describe: (a) => `Find ${a.pattern}`,
      async run(a, ctx) {
        const scope = searchScope(ctx, a.path);
        const all = await indexFor(scope.root).files();
        const prefix = scope.rel && scope.rel !== '.' ? `${scope.rel.replace(/\/+$/, '')}/` : '';
        const files = prefix ? all.filter((f) => f.startsWith(prefix)) : all;
        const pat = String(a.pattern);
        const hits = (hasGlobChars(pat) ? files.filter((f) => matchesGlob(f, pat)) : filterFiles(files, pat, Number.MAX_SAFE_INTEGER)).map((f) => scope.prefix + f);
        if (!hits.length) { return '(no matches)'; }
        const shown = hits.slice(0, MAX_GLOB_RESULTS).join('\n');
        return hits.length > MAX_GLOB_RESULTS ? `${shown}\n[${hits.length - MAX_GLOB_RESULTS} more files; narrow the pattern or pass path]` : shown;
      },
    },
    {
      kind: 'read',
      spec: fnSpec('grep',
        'Fast regex search of file contents (ripgrep). Respects .gitignore. Results are grouped by file with the most relevant files first. For broad questions start with output_mode "files" or "count", then narrow with glob/path and read matches with "content".',
        {
          pattern: { type: 'string', description: 'regular expression' },
          glob: { type: 'string', description: 'file glob, e.g. *.py or src/**/*.ts' },
          path: { type: 'string', description: 'sub-directory to search in' },
          output_mode: { type: 'string', enum: ['content', 'files', 'count'], description: 'default: content' },
          context: { type: 'number', description: 'lines of context around each match (0-5)' },
          ignore_case: { type: 'boolean', description: 'default: true' },
          max_results: { type: 'number', description: 'maximum matches/files to show' },
        }, ['pattern']),
      describe: (a) => `Search "${a.pattern}"${a.glob ? ` in ${a.glob}` : ''}`,
      async run(a, ctx) {
        const scope = searchScope(ctx, a.path);
        const o: SearchOptions = {
          pattern: String(a.pattern), glob: a.glob, path: scope.rel,
          mode: SEARCH_MODES.includes(a.output_mode) ? a.output_mode : 'content',
          context: typeof a.context === 'number' ? a.context : 0,
          ignoreCase: a.ignore_case !== false,
          maxResults: typeof a.max_results === 'number' && a.max_results > 0 ? a.max_results : undefined,
        };
        const res = await search({ root: scope.root, index: indexFor(scope.root), rgPath: opts.rgPath, prefer: opts.prefer }, o, ctx.signal);
        if (scope.prefix) { res.files = res.files.map((f) => ({ ...f, file: scope.prefix + f.file })); }
        return formatSearch(res, { ...o, path: a.path });
      },
    },
    {
      kind: 'read',
      spec: fnSpec('search_code',
        'Find code by what it does when you do not know the exact identifier: describe it in a few words (e.g. "expired session cleanup", "retry http request with backoff"). Ranks ~40-line code regions by word relevance; identifiers are split into words (getUserName matches "user name") and file names count extra. Returns file:line ranges with the matching lines. Use grep instead for an exact name or regex.',
        {
          query: { type: 'string', description: 'words describing the code you are looking for' },
          path: { type: 'string', description: 'optional sub-directory to search in' },
          max_results: { type: 'number', description: 'number of code regions to return (default 8, max 30)' },
        }, ['query']),
      describe: (a) => `Search code for "${a.query}"${a.path ? ` in ${a.path}` : ''}`,
      async run(a, ctx) {
        const scope = searchScope(ctx, a.path);
        const idx = codeIndexFor(scope.root);
        const hits = await idx.search(String(a.query ?? ''), { max: typeof a.max_results === 'number' ? a.max_results : undefined, under: scope.rel, signal: ctx.signal });
        return formatCodeHits(hits, String(a.query ?? ''), idx.truncated, scope.prefix);
      },
    },
    ...createFileOpsTools({ invalidate: (root) => indexFor(root).invalidate() }),
    {
      kind: 'exec',
      spec: fnSpec('run_command',
        `Run a shell command in the workspace root and return its combined output and exit code (default time limit 120s; set timeout_seconds up to 600 for test suites and builds). Long output keeps the start, the end and error lines. ${process.platform === 'win32'
          ? 'Shell: Windows PowerShell 5.1 - chain with ";" or "if ($?) { ... }" (not &&), call curl.exe -sS --max-time 20 (not curl).'
          : 'Shell: bash - chain with &&; curl -sS --max-time 20.'} Several read-only commands sent in one response run in parallel. Never use ssh, scp or sftp here: use the remote_* tools for Linux servers.`,
        {
          command: { type: 'string' },
          timeout_seconds: { type: 'number', description: 'time limit, 1-600 (default 120)' },
          cwd: { type: 'string', description: 'directory to run in (default: the workspace root); in a multi-root workspace, "<folder name>" or a path inside it' },
        }, ['command']),
      describe: (a) => `Run: ${a.command}${a.cwd ? ` (in ${a.cwd})` : ''}`,
      async run(a, ctx) {
        const remote = remoteShellHint(a.command);
        if (remote) { throw new Error(remote); }
        let cwd = ctx.root;
        if (a.cwd) {
          cwd = resolveIn(ctx, String(a.cwd));
          const st = await fs.stat(cwd).catch(() => undefined);
          if (!st?.isDirectory()) { throw new Error(`cwd is not a directory: ${a.cwd}`); }
        }
        const out = await runShell(a.command, ctx, commandTimeoutMs(a.timeout_seconds), cwd);
        indexFor(ctx.root).invalidate();
        if (!samePath(cwd, ctx.root)) { const r = rootOf(ctx, cwd); if (r) { indexFor(r.path).invalidate(); } }
        return out;
      },
    },
  ];
}
