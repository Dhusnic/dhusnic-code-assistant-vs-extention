import * as fs from 'fs/promises';
import * as path from 'path';
import { CheckpointStore, FileOriginal, fileKey } from './checkpoints';
import { diffText } from './diff';
import { withFileLock } from './locks';

/** Data layer of the changed-files review panel: what the agents of a session changed, compared with the earliest original. */

export type ChangeStatus = 'added' | 'modified' | 'deleted';
export interface ChangedFile {
  abs: string; rel: string; status: ChangeStatus; added: number; removed: number; agents: string[]; binary: boolean;
  /** Two or more agents started editing from the same original, so one may have overwritten the other. */
  conflict: boolean;
}
export interface ChangeSource { agentId: string; store: CheckpointStore }
export interface FileResult { abs: string; ok: boolean; error?: string }

const MAX_COUNT_BYTES = 2 * 1024 * 1024;
const CONCURRENCY = 8;

const isBinary = (b: Buffer): boolean => b.includes(0);
const sameBytes = (a: Buffer | undefined, b: Buffer | undefined): boolean => (a ?? Buffer.alloc(0)).equals(b ?? Buffer.alloc(0));
const sameOriginal = (a: FileOriginal, b: FileOriginal): boolean => a.existed === b.existed && sameBytes(a.data, b.data);
/** Drops the final newline, which `diffText` would otherwise count as an extra empty line. */
const countable = (b: Buffer): string => b.toString('utf8').replace(/\r?\n$/, '');

function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Resolves symlinks too: a link inside the workspace must not let a revert write outside it. */
async function assertInsideRoot(root: string, abs: string): Promise<void> {
  const refuse = (): Error => new Error(`Refusing to touch a path outside the workspace: ${abs}`);
  if (!isInside(path.resolve(root), abs)) { throw refuse(); }
  const realRoot = await fs.realpath(root);
  const link = await fs.lstat(abs).then((s) => s.isSymbolicLink(), () => false);
  let probe = abs;
  for (;;) {
    try { probe = await fs.realpath(probe); break; } catch (e: any) {
      if (e.code !== 'ENOENT' || probe === abs && link || path.dirname(probe) === probe) { throw refuse(); }
      probe = path.dirname(probe);
    }
  }
  if (probe !== realRoot && !isInside(realRoot, probe)) { throw refuse(); }
}

/** File content now: a Buffer, undefined when absent, or 'dir' when a directory occupies the path. */
async function readCurrent(abs: string): Promise<Buffer | undefined | 'dir'> {
  try { return await fs.readFile(abs); } catch (e: any) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') { return undefined; }
    if (e.code === 'EISDIR') { return 'dir'; }
    throw e;
  }
}

/** Each agent's earliest capture of `abs`, oldest first. */
async function capturesOf(sources: ChangeSource[], abs: string): Promise<Array<{ agentId: string; original: FileOriginal }>> {
  const out: Array<{ agentId: string; original: FileOriginal }> = [];
  for (const s of sources) {
    const original = await s.store.originalOf(abs);
    if (original) { out.push({ agentId: s.agentId, original }); }
  }
  return out.sort((a, b) => a.original.at - b.original.at);
}

async function trackedInRoot(root: string, sources: ChangeSource[]): Promise<string[]> {
  const base = path.resolve(root);
  const files = new Map<string, string>();
  for (const s of sources) {
    for (const abs of await s.store.trackedFiles()) {
      if (isInside(base, abs) && !files.has(fileKey(abs))) { files.set(fileKey(abs), abs); }
    }
  }
  return [...files.values()];
}

async function mapLimit<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

async function inspect(root: string, sources: ChangeSource[], abs: string): Promise<ChangedFile | undefined> {
  const captures = await capturesOf(sources, abs);
  if (!captures.length) { return undefined; }
  const base = captures[0].original;
  const now = await readCurrent(abs);
  if (now === 'dir') { return undefined; }
  if (!base.existed && !now) { return undefined; }
  if (base.existed && now && sameBytes(base.data, now)) { return undefined; }
  const status: ChangeStatus = !base.existed ? 'added' : now ? 'modified' : 'deleted';
  const before = base.data ?? Buffer.alloc(0), after = now ?? Buffer.alloc(0);
  const binary = isBinary(before) || isBinary(after);
  let added = 0, removed = 0;
  if (!binary && before.length <= MAX_COUNT_BYTES && after.length <= MAX_COUNT_BYTES) {
    ({ added, removed } = diffText(countable(before), countable(after), 0));
  }
  return {
    abs, rel: path.relative(path.resolve(root), abs).split(path.sep).join('/'), status, added, removed, binary,
    agents: [...new Set(captures.map((c) => c.agentId))],
    conflict: captures.filter((c) => sameOriginal(c.original, base)).length > 1,
  };
}

/** Everything that differs from its earliest original, sorted by relative path. Files outside `root` are not listed. */
export async function collectChanges(root: string, sources: ChangeSource[]): Promise<ChangedFile[]> {
  const files = await trackedInRoot(root, sources);
  const found = await mapLimit(files, (abs) => inspect(root, sources, abs).catch(() => undefined));
  return found.filter((f): f is ChangedFile => !!f).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** The original as text: '' if the file did not exist, undefined if it is untracked or binary. */
export async function originalText(sources: ChangeSource[], abs: string): Promise<string | undefined> {
  const first = (await capturesOf(sources, abs))[0]?.original;
  if (!first) { return undefined; }
  if (!first.existed || !first.data) { return ''; }
  return isBinary(first.data) ? undefined : first.data.toString('utf8');
}

async function forget(sources: ChangeSource[], abs: string): Promise<void> {
  for (const s of sources) { await s.store.forgetFile(abs); }
}

/** Keeps the file as it is now and removes it from the review list. */
export async function acceptFile(sources: ChangeSource[], abs: string): Promise<void> {
  const file = path.resolve(abs);
  await withFileLock(file, () => forget(sources, file));
}

/** Puts back the earliest original (deleting the file if there was none), then forgets it. Refuses paths outside `root`. */
export async function revertFile(sources: ChangeSource[], abs: string, root: string): Promise<void> {
  const file = path.resolve(abs);
  await withFileLock(file, async () => {
    await assertInsideRoot(root, file);
    const base = (await capturesOf(sources, file))[0]?.original;
    if (!base) { throw new Error(`No checkpoint for ${file}`); }
    if (!base.existed) {
      await fs.rm(file, { force: true });
    } else {
      const data = base.data ?? Buffer.alloc(0);
      const now = await readCurrent(file);
      if (now === 'dir') { await fs.rmdir(file); }
      if (now === 'dir' || !now || !data.equals(now)) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, data);
      }
    }
    await forget(sources, file);
  });
}

async function settle(abs: string, fn: () => Promise<void>): Promise<FileResult> {
  try { await fn(); return { abs, ok: true }; } catch (e: any) { return { abs, ok: false, error: e?.message ?? String(e) }; }
}

/** Accepts `files` (default: everything tracked under `root`). One failure never stops the rest. */
export async function acceptAll(root: string, sources: ChangeSource[], files?: string[]): Promise<FileResult[]> {
  const out: FileResult[] = [];
  for (const abs of files ?? await trackedInRoot(root, sources)) { out.push(await settle(abs, () => acceptFile(sources, abs))); }
  return out;
}

/**
 * Reverts `files` (default: everything tracked under `root`). One failure never stops the rest. Files that did not
 * exist go first, so a file the agent turned into a directory (or the reverse) can be put back.
 */
export async function revertAll(root: string, sources: ChangeSource[], files?: string[]): Promise<FileResult[]> {
  const list = files ?? await trackedInRoot(root, sources);
  const created = await mapLimit(list, async (abs) => {
    const first = await capturesOf(sources, abs).then((c) => c[0]?.original, () => undefined);
    return !!first && !first.existed;
  });
  const order = list.map((abs, i) => ({ abs, created: created[i] })).sort((a, b) => Number(b.created) - Number(a.created));
  const out: FileResult[] = [];
  for (const { abs } of order) { out.push(await settle(abs, () => revertFile(sources, abs, root))); }
  return out;
}
