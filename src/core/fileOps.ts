import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool, ToolCtx, fnSpec } from './tool';
import { SKIP_DIRS } from './glob';
import { resolveIn, resolveReadable, rootOf } from './fstools';

/**
 * File and folder management tools: create_dir, move_path, copy_path, delete_path (kind 'edit', so they go through the
 * same mode rules and approvals as write_file) and file_info (read). They exist so the agent does not reach for
 * mv/cp/rm/mkdir in run_command, which skips approvals and cannot be undone.
 *
 * Undo: before anything changes, every file the operation touches is captured with ctx.snapshot (sources, and the
 * destinations as "did not exist"), so rewinding the turn puts each file back. Empty folders are not tracked, so a
 * rewind can leave an empty folder behind. An operation over more than MAX_FILES files or MAX_BYTES bytes is refused
 * rather than run without a backup. Paths stay inside the workspace folders; a workspace folder itself and anything
 * under .git can never be moved or deleted.
 */
export const FILE_OP_TOOLS = ['create_dir', 'move_path', 'copy_path', 'delete_path'] as const;
export const MAX_FILES = 2000;
export const MAX_BYTES = 200 * 1024 * 1024;
const PREVIEW_TEXT = 200 * 1024;

export interface FileOpsOptions {
  /** Called after files under `root` changed, so search indexes drop stale entries. */
  invalidate?: (root: string) => void;
}

const exists = async (p: string) => !!(await fs.lstat(p).catch(() => undefined));

/** Every file under `abs` (or `abs` itself when it is a file), following no symlinks. */
async function filesUnder(abs: string): Promise<{ files: string[]; bytes: number }> {
  const files: string[] = [];
  let bytes = 0;
  const walk = async (p: string): Promise<void> => {
    const st = await fs.lstat(p);
    if (st.isDirectory()) {
      for (const e of await fs.readdir(p)) { await walk(path.join(p, e)); }
      return;
    }
    files.push(p);
    bytes += st.size;
    if (files.length > MAX_FILES || bytes > MAX_BYTES) { throw new Error(tooBig(abs)); }
  };
  await walk(abs);
  return { files, bytes };
}

const tooBig = (p: string) => `${path.basename(p)} is too large to back up for undo (more than ${MAX_FILES} files or ${MAX_BYTES / 1048576} MB). Ask the user to do it, or use run_command if they agree it cannot be undone.`;

/** Refuses workspace folders themselves and anything inside .git. */
function guard(ctx: ToolCtx, abs: string, raw: string): void {
  const r = rootOf(ctx, abs);
  if (!r || path.relative(path.resolve(r.path), abs) === '') { throw new Error(`Refusing to change a workspace folder itself: ${raw}`); }
  if (path.relative(path.resolve(r.path), abs).split(/[\\/]/).includes('.git')) { throw new Error(`Refusing to change files inside .git: ${raw}`); }
}

const show = (ctx: ToolCtx, abs: string) => {
  const r = rootOf(ctx, abs);
  const rel = r ? path.relative(r.path, abs) : abs;
  const pre = r && path.resolve(r.path) !== path.resolve(ctx.root) ? `${r.name}/` : '';
  return (pre + rel).split(path.sep).join('/') || '.';
};

/** Where `src` lands: inside `dest` when dest is an existing folder (like mv/cp), else at `dest`. */
async function target(src: string, dest: string): Promise<string> {
  const st = await fs.stat(dest).catch(() => undefined);
  return st?.isDirectory() ? path.join(dest, path.basename(src)) : dest;
}

interface Plan { src: string; dst: string; srcFiles: string[]; dstFiles: string[] }

async function planTransfer(a: any, ctx: ToolCtx, move: boolean): Promise<Plan> {
  if (!a.path || !a.destination) { throw new Error('path and destination are required.'); }
  const src = resolveIn(ctx, String(a.path));
  if (!await exists(src)) { throw new Error(`Not found: ${a.path}`); }
  if (move) { guard(ctx, src, a.path); }
  const dst = await target(src, resolveIn(ctx, String(a.destination)));
  guard(ctx, dst, a.destination);
  if (path.resolve(src) === path.resolve(dst)) { throw new Error('Source and destination are the same.'); }
  const rel = path.relative(src, dst);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { throw new Error(`Cannot ${move ? 'move' : 'copy'} a folder into itself: ${a.destination}`); }
  const caseOnly = process.platform === 'win32' && src.toLowerCase() === dst.toLowerCase();
  if (!caseOnly && await exists(dst)) {
    if (a.overwrite !== true) { throw new Error(`${show(ctx, dst)} already exists. Pass overwrite: true to replace it, or pick another destination.`); }
    if ((await fs.stat(src)).isDirectory() !== (await fs.stat(dst)).isDirectory()) { throw new Error(`Cannot overwrite ${show(ctx, dst)}: one is a file and the other a folder.`); }
  }
  const { files: srcFiles } = await filesUnder(src);
  const dstFiles = srcFiles.map((f) => path.join(dst, path.relative(src, f)));
  if (caseOnly) { return { src, dst, srcFiles, dstFiles }; }
  if (await exists(dst)) { dstFiles.push(...(await filesUnder(dst)).files.filter((f) => !dstFiles.includes(f))); }
  return { src, dst, srcFiles, dstFiles };
}

/** Which source files the agent has read (and not changed since). Checked before the move: afterwards they are gone. */
async function readSources(ctx: ToolCtx, from: string[]): Promise<boolean[]> {
  const out: boolean[] = [];
  for (const f of from) { out.push(!!ctx.reads && !await ctx.reads.check(f, f)); }
  return out;
}

/** A moved or copied file counts as read only when its source was: its contents are what the agent already saw. */
async function markMoved(ctx: ToolCtx, wasRead: boolean[], to: string[]): Promise<void> {
  for (let i = 0; i < to.length; i++) { if (wasRead[i]) { await ctx.reads?.markWritten(to[i]); } }
}

export function createFileOpsTools(opts: FileOpsOptions = {}): Tool[] {
  const touched = (ctx: ToolCtx, ...abs: string[]) => {
    for (const a of abs) { opts.invalidate?.(rootOf(ctx, a)?.path ?? ctx.root); }
  };
  return [
    {
      kind: 'edit',
      spec: fnSpec('create_dir', 'Create a folder (and any missing parent folders). write_file already creates the folders a new file needs; use this for an empty folder.',
        { path: { type: 'string' } }, ['path']),
      describe: (a) => `Create folder ${a.path}`,
      async run(a, ctx) {
        const abs = resolveIn(ctx, String(a.path ?? ''));
        guard(ctx, abs, a.path);
        const st = await fs.stat(abs).catch(() => undefined);
        if (st?.isDirectory()) { return `${a.path} already exists.`; }
        if (st) { throw new Error(`${a.path} exists and is a file.`); }
        await fs.mkdir(abs, { recursive: true });
        return `Created folder ${a.path}`;
      },
    },
    {
      kind: 'edit',
      spec: fnSpec('move_path',
        'Move or rename a file or folder inside the workspace. If destination is an existing folder, the item goes inside it. Refuses to replace an existing item unless overwrite is true. Undoable. Does not update imports: grep for references afterwards (for code symbols, rename_symbol does that).',
        { path: { type: 'string', description: 'file or folder to move' }, destination: { type: 'string', description: 'new path, or an existing folder to move into' }, overwrite: { type: 'boolean', description: 'replace an existing destination (default false)' } },
        ['path', 'destination']),
      describe: (a) => `Move ${a.path} → ${a.destination}`,
      async run(a, ctx) {
        const p = await planTransfer(a, ctx, true);
        const wasRead = await readSources(ctx, p.srcFiles);
        for (const f of [...p.srcFiles, ...p.dstFiles]) { await ctx.snapshot(f); }
        const caseOnly = process.platform === 'win32' && p.src.toLowerCase() === p.dst.toLowerCase();
        if (!caseOnly && a.overwrite === true) { await fs.rm(p.dst, { recursive: true, force: true }); }
        await fs.mkdir(path.dirname(p.dst), { recursive: true });
        try { await fs.rename(p.src, p.dst); } catch (e: any) {
          if (e.code !== 'EXDEV') { throw e; }
          await fs.cp(p.src, p.dst, { recursive: true, errorOnExist: true, force: false });
          await fs.rm(p.src, { recursive: true, force: true });
        }
        await markMoved(ctx, wasRead, p.srcFiles.map((f) => path.join(p.dst, path.relative(p.src, f))));
        touched(ctx, p.src, p.dst);
        return `Moved ${show(ctx, p.src)} → ${show(ctx, p.dst)}${p.srcFiles.length > 1 ? ` (${p.srcFiles.length} files)` : ''}`;
      },
    },
    {
      kind: 'edit',
      spec: fnSpec('copy_path',
        'Copy a file or folder (recursively) inside the workspace. If destination is an existing folder, the copy goes inside it. Refuses to replace an existing item unless overwrite is true. Undoable.',
        { path: { type: 'string' }, destination: { type: 'string' }, overwrite: { type: 'boolean', description: 'replace an existing destination (default false)' } },
        ['path', 'destination']),
      describe: (a) => `Copy ${a.path} → ${a.destination}`,
      async run(a, ctx) {
        const p = await planTransfer(a, ctx, false);
        const wasRead = await readSources(ctx, p.srcFiles);
        for (const f of p.dstFiles) { await ctx.snapshot(f); }
        if (a.overwrite === true) { await fs.rm(p.dst, { recursive: true, force: true }); }
        await fs.mkdir(path.dirname(p.dst), { recursive: true });
        await fs.cp(p.src, p.dst, { recursive: true, errorOnExist: true, force: false });
        await markMoved(ctx, wasRead, p.srcFiles.map((f) => path.join(p.dst, path.relative(p.src, f))));
        touched(ctx, p.dst);
        return `Copied ${show(ctx, p.src)} → ${show(ctx, p.dst)}${p.srcFiles.length > 1 ? ` (${p.srcFiles.length} files)` : ''}`;
      },
    },
    {
      kind: 'edit',
      spec: fnSpec('delete_path',
        'Delete a file or folder in the workspace. A folder that is not empty needs recursive: true. Undoable with the turn\'s rewind (empty folders are not restored). Never use rm/del in run_command for this.',
        { path: { type: 'string' }, recursive: { type: 'boolean', description: 'required to delete a folder that is not empty' } }, ['path']),
      describe: (a) => `Delete ${a.path}${a.recursive ? ' (recursive)' : ''}`,
      async preview(a, ctx) {
        const abs = resolveIn(ctx, String(a.path ?? ''));
        guard(ctx, abs, a.path);
        const st = await fs.lstat(abs).catch(() => undefined);
        if (!st) { throw new Error(`Not found: ${a.path}`); }
        if (!st.isDirectory()) {
          const buf = st.size <= PREVIEW_TEXT ? await fs.readFile(abs) : undefined;
          const text = buf && !buf.subarray(0, 8000).includes(0) ? buf.toString('utf8') : `(${st.size} bytes, not shown)`;
          return { path: String(a.path), oldText: text, newText: '' };
        }
        const { files } = await filesUnder(abs);
        return { path: String(a.path), oldText: files.map((f) => show(ctx, f)).join('\n') || '(empty folder)', newText: '' };
      },
      async run(a, ctx) {
        const abs = resolveIn(ctx, String(a.path ?? ''));
        guard(ctx, abs, a.path);
        const st = await fs.lstat(abs).catch(() => undefined);
        if (!st) { throw new Error(`Not found: ${a.path}`); }
        if (st.isDirectory() && a.recursive !== true && (await fs.readdir(abs)).length) {
          throw new Error(`${a.path} is a folder that is not empty; pass recursive: true to delete it and everything in it.`);
        }
        const { files } = await filesUnder(abs);
        for (const f of files) { await ctx.snapshot(f); }
        await fs.rm(abs, { recursive: true, force: false });
        touched(ctx, abs);
        return `Deleted ${show(ctx, abs)}${st.isDirectory() ? ` (folder, ${files.length} files)` : ''}`;
      },
    },
    {
      kind: 'read',
      spec: fnSpec('file_info',
        'Facts about one or more files or folders without reading them: type, size, modified time, line count of text files, and for folders the number of files and total size.',
        { paths: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['paths']),
      describe: (a) => `Info ${Array.isArray(a.paths) ? a.paths.join(', ') : ''}`,
      async run(a, ctx) {
        const list: string[] = Array.isArray(a.paths) ? a.paths.map(String).slice(0, 50) : [String(a.path ?? '.')];
        const out: string[] = [];
        for (const p of list) {
          try { out.push(`${p}: ${await describePath(resolveReadable(ctx, p), ctx.signal)}`); } catch (e: any) { out.push(`${p}: ERROR ${e.code === 'ENOENT' ? 'not found' : e.message ?? e}`); }
        }
        return out.join('\n');
      },
    },
  ];
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function describePath(abs: string, signal: AbortSignal): Promise<string> {
  const st = await fs.lstat(abs);
  const when = `modified ${st.mtime.toISOString().replace('T', ' ').slice(0, 19)}`;
  if (st.isSymbolicLink()) { return `symlink → ${await fs.readlink(abs)}, ${when}`; }
  if (st.isDirectory()) {
    let files = 0, dirs = 0, bytes = 0, capped = false;
    const walk = async (p: string): Promise<void> => {
      for (const e of await fs.readdir(p, { withFileTypes: true })) {
        if (signal.aborted || files > 20000) { capped = true; return; }
        if (e.isDirectory()) { dirs++; if (!SKIP_DIRS.has(e.name)) { await walk(path.join(p, e.name)); } } else if (e.isFile()) {
          files++;
          bytes += (await fs.stat(path.join(p, e.name)).catch(() => ({ size: 0 }))).size;
        }
      }
    };
    await walk(abs);
    return `folder, ${files}${capped ? '+' : ''} files, ${dirs} folders, ${size(bytes)} (skips ${[...SKIP_DIRS].slice(0, 3).join(', ')}…), ${when}`;
  }
  let kind = 'file';
  if (st.size <= 5 * 1048576) {
    const buf = await fs.readFile(abs);
    if (!buf.subarray(0, 8000).includes(0)) {
      const lines = buf.length ? buf.toString('utf8').split('\n').length : 0;
      kind = `text file, ${lines} lines${buf.includes(13) ? ', CRLF' : ''}`;
    } else { kind = 'binary file'; }
  }
  return `${kind}, ${size(st.size)}, ${when}`;
}
