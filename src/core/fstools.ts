import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { Tool, ToolCtx, fnSpec } from './tool';
import { withFileLock } from './locks';
import { SKIP_DIRS, filterFiles, globToRegex, hasGlobChars, matchesGlob } from './glob';
import { EnginePreference, FileIndex, SearchMode, SearchOptions, formatSearch, search } from './search';

export { SKIP_DIRS, globToRegex, matchesGlob };

export const MAX_OUT = 20000;

export function resolveSafe(root: string, p: string): string {
  const abs = path.resolve(root, p || '.');
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { throw new Error(`Path outside workspace: ${p}`); }
  return abs;
}

export const clip = (s: string, max = MAX_OUT): string =>
  (s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s);

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

export function runShell(command: string, ctx: ToolCtx, timeoutMs = 120000): Promise<string> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const p = spawn(isWin ? 'powershell.exe' : 'bash', isWin ? ['-NoProfile', '-Command', command] : ['-lc', command], { cwd: ctx.root });
    let out = '';
    const timer = setTimeout(() => { p.kill(); out += `\n[timeout after ${timeoutMs / 1000}s]`; }, timeoutMs);
    const abort = () => p.kill();
    ctx.signal.addEventListener('abort', abort, { once: true });
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => { clearTimeout(timer); ctx.signal.removeEventListener('abort', abort); resolve(clip(`${out}\n[exit ${code}]`)); });
    p.on('error', (e) => { clearTimeout(timer); resolve(`ERROR: ${e.message}`); });
  });
}

async function computeEdit(args: any, ctx: ToolCtx): Promise<{ abs: string; oldText: string; newText: string }> {
  const abs = resolveSafe(ctx.root, args.path);
  const oldText = await fs.readFile(abs, 'utf8');
  const count = oldText.split(args.old_string).length - 1;
  if (!args.old_string) { throw new Error('old_string must not be empty.'); }
  if (count === 0) { throw new Error('old_string not found.'); }
  if (count > 1) { throw new Error(`old_string matches ${count} places; make it unique.`); }
  return { abs, oldText, newText: oldText.replace(args.old_string, () => args.new_string) };
}

export interface FsToolsOptions { index?: FileIndex; rgPath?: string; prefer?: EnginePreference }

const SEARCH_MODES: SearchMode[] = ['content', 'files', 'count'];
const MAX_GLOB_RESULTS = 200;

export function createFsTools(opts: FsToolsOptions = {}): Tool[] {
  const indexes = new Map<string, FileIndex>();
  const indexFor = (root: string): FileIndex => {
    if (opts.index && opts.index.root === root) { return opts.index; }
    let idx = indexes.get(root);
    if (!idx) { idx = new FileIndex(root); indexes.set(root, idx); }
    return idx;
  };
  return [
    {
      kind: 'read',
      spec: fnSpec('read_file', 'Read a text file. Optional 1-based line range.',
        { path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } }, ['path']),
      describe: (a) => `Read ${a.path}`,
      async run(a, ctx) {
        const lines = (await fs.readFile(resolveSafe(ctx.root, a.path), 'utf8')).split('\n');
        const s = Math.max(1, a.start_line ?? 1), e = Math.min(lines.length, a.end_line ?? lines.length);
        return clip(lines.slice(s - 1, e).map((l, i) => `${s + i}\t${l}`).join('\n'));
      },
    },
    {
      kind: 'edit',
      spec: fnSpec('write_file', 'Create or fully overwrite a file.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
      describe: (a) => `Write ${a.path}`,
      async preview(a, ctx) {
        const abs = resolveSafe(ctx.root, a.path);
        let oldText = '';
        try { oldText = await fs.readFile(abs, 'utf8'); } catch { /* new file */ }
        return { path: a.path, oldText, newText: String(a.content) };
      },
      async run(a, ctx) {
        const abs = resolveSafe(ctx.root, a.path);
        await withFileLock(abs, async () => {
          await ctx.snapshot(abs);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, String(a.content), 'utf8');
        });
        indexFor(ctx.root).invalidate();
        return `Wrote ${a.path}`;
      },
    },
    {
      kind: 'edit',
      spec: fnSpec('edit_file', 'Replace one exact occurrence of old_string with new_string in a file. old_string must be unique.',
        { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, ['path', 'old_string', 'new_string']),
      describe: (a) => `Edit ${a.path}`,
      async preview(a, ctx) { const e = await computeEdit(a, ctx); return { path: a.path, oldText: e.oldText, newText: e.newText }; },
      async run(a, ctx) {
        // Re-read inside the lock: another agent may have changed the file since the preview.
        await withFileLock(resolveSafe(ctx.root, a.path), async () => {
          const e = await computeEdit(a, ctx);
          await ctx.snapshot(e.abs);
          await fs.writeFile(e.abs, e.newText, 'utf8');
        });
        return `Edited ${a.path}`;
      },
    },
    {
      kind: 'read',
      spec: fnSpec('list_dir', 'List entries of a directory (non-recursive).', { path: { type: 'string' } }, ['path']),
      describe: (a) => `List ${a.path || '.'}`,
      async run(a, ctx) {
        const ents = await fs.readdir(resolveSafe(ctx.root, a.path), { withFileTypes: true });
        return ents.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') || '(empty)';
      },
    },
    {
      kind: 'read',
      spec: fnSpec('glob_files',
        'Find files by glob (e.g. **/*.py, src/**/*.ts) or by a name fragment (e.g. "cmdb_controller"). Respects .gitignore. Best name matches come first.',
        { pattern: { type: 'string' }, path: { type: 'string', description: 'optional sub-directory to search in' } }, ['pattern']),
      describe: (a) => `Find ${a.pattern}`,
      async run(a, ctx) {
        if (a.path) { resolveSafe(ctx.root, a.path); }
        const all = await indexFor(ctx.root).files();
        const prefix = a.path ? `${String(a.path).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')}/` : '';
        const files = prefix ? all.filter((f) => f.startsWith(prefix)) : all;
        const pat = String(a.pattern);
        const hits = hasGlobChars(pat) ? files.filter((f) => matchesGlob(f, pat)) : filterFiles(files, pat, Number.MAX_SAFE_INTEGER);
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
        if (a.path) { resolveSafe(ctx.root, a.path); }
        const o: SearchOptions = {
          pattern: String(a.pattern), glob: a.glob, path: a.path,
          mode: SEARCH_MODES.includes(a.output_mode) ? a.output_mode : 'content',
          context: typeof a.context === 'number' ? a.context : 0,
          ignoreCase: a.ignore_case !== false,
          maxResults: typeof a.max_results === 'number' && a.max_results > 0 ? a.max_results : undefined,
        };
        const res = await search({ root: ctx.root, index: indexFor(ctx.root), rgPath: opts.rgPath, prefer: opts.prefer }, o, ctx.signal);
        return formatSearch(res, o);
      },
    },
    {
      kind: 'exec',
      spec: fnSpec('run_command',
        `Run a shell command in the workspace root and return its combined output and exit code (time limit 120s). ${process.platform === 'win32'
          ? 'Shell: Windows PowerShell 5.1 - chain with ";" or "if ($?) { ... }" (not &&), call curl.exe -sS --max-time 20 (not curl).'
          : 'Shell: bash - chain with &&; curl -sS --max-time 20.'} Several read-only commands sent in one response run in parallel.`,
        { command: { type: 'string' } }, ['command']),
      describe: (a) => `Run: ${a.command}`,
      async run(a, ctx) {
        const out = await runShell(a.command, ctx);
        indexFor(ctx.root).invalidate();
        return out;
      },
    },
  ];
}
