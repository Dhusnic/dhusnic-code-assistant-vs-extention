import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { withFileLock } from './locks';
import { renameWithRetry } from './store';

/** `at` orders captures across stores (turn numbers are per agent); manifests written before it existed lack it. */
export interface CheckpointEntry { abs: string; existed: boolean; backup?: string; at?: number }
type Entry = CheckpointEntry;
interface Manifest { entries: Entry[] }
export interface FileOriginal { existed: boolean; data?: Buffer; at: number }

/** Identity of a path for comparisons: normalized, and case-insensitive on Windows (same rule as locks.ts). */
export const fileKey = (abs: string): string => {
  const p = path.normalize(abs);
  return process.platform === 'win32' ? p.toLowerCase() : p;
};

let lastTick = 0;
/** Strictly increasing clock, so two captures in the same millisecond still have an order. */
const tick = (): number => (lastTick = Math.max(lastTick + 1, Date.now()));

/**
 * Per-session file checkpoints. `snapshot` captures a file's original content the first time
 * it is touched in a turn; `restore(turn)` rolls every file back to how it was before that turn.
 */
export class CheckpointStore {
  constructor(private dir: string) {}

  private turnDir(turn: number): string { return path.join(this.dir, `turn-${turn}`); }

  async turns(): Promise<number[]> {
    try {
      return (await fs.readdir(this.dir)).map((n) => /^turn-(\d+)$/.exec(n)?.[1]).filter((x): x is string => !!x).map(Number).sort((a, b) => a - b);
    } catch { return []; }
  }

  private async readManifest(turn: number): Promise<Manifest> {
    try { return JSON.parse(await fs.readFile(path.join(this.turnDir(turn), 'manifest.json'), 'utf8')); } catch { return { entries: [] }; }
  }

  async snapshot(turn: number, abs: string): Promise<void> {
    const dir = this.turnDir(turn);
    await withFileLock(path.join(dir, 'manifest.json'), async () => {
      await fs.mkdir(path.join(dir, 'files'), { recursive: true });
      const manifest = await this.readManifest(turn);
      if (manifest.entries.some((e) => e.abs === abs)) { return; }
      let data: Buffer | undefined;
      try { data = await fs.readFile(abs); } catch (e: any) {
        // Only a missing file counts as "did not exist". Recording a locked or unreadable file that way would make a
        // later rewind delete it, so the error propagates and the edit is refused before anything is written.
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') { throw new Error(`Could not back up ${abs} before changing it: ${e.message ?? e}`); }
      }
      let entry: Entry = { abs, existed: false, at: tick() };
      if (data) {
        const backup = path.join('files', createHash('sha1').update(abs).digest('hex'));
        await fs.writeFile(path.join(dir, backup), data);
        entry = { abs, existed: true, backup, at: tick() };
      }
      manifest.entries.push(entry);
      await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    });
  }

  async changedFiles(turn: number): Promise<string[]> { return (await this.readManifest(turn)).entries.map((e) => e.abs); }

  async entries(turn: number): Promise<CheckpointEntry[]> { return (await this.readManifest(turn)).entries; }

  /** Every file captured in any turn, once each, in first-captured order. */
  async trackedFiles(): Promise<string[]> {
    const seen = new Map<string, string>();
    for (const t of await this.turns()) {
      for (const e of (await this.readManifest(t)).entries) { if (!seen.has(fileKey(e.abs))) { seen.set(fileKey(e.abs), e.abs); } }
    }
    return [...seen.values()];
  }

  /** The earliest capture of `abs`, or undefined if it is not tracked. Rejects if that capture's backup is unreadable. */
  async originalOf(abs: string): Promise<FileOriginal | undefined> {
    const key = fileKey(abs);
    for (const t of await this.turns()) {
      const e = (await this.readManifest(t)).entries.find((x) => fileKey(x.abs) === key);
      if (!e) { continue; }
      const at = e.at ?? await this.legacyTime(t, e);
      if (!e.existed || !e.backup) { return { existed: false, at }; }
      return { existed: true, data: await fs.readFile(path.join(this.turnDir(t), e.backup)), at };
    }
    return undefined;
  }

  private async legacyTime(turn: number, e: Entry): Promise<number> {
    const dir = this.turnDir(turn);
    for (const f of [e.backup, 'manifest.json']) {
      if (!f) { continue; }
      try { return (await fs.stat(path.join(dir, f))).mtimeMs; } catch { /* try the next one */ }
    }
    return 0;
  }

  /**
   * Drops `abs` from every turn so a later rewind leaves it alone. The manifest is replaced before its backups go,
   * so a crash can only orphan a backup, never leave `restore` pointing at a missing one. Returns whether it was tracked.
   */
  async forgetFile(abs: string): Promise<boolean> {
    const key = fileKey(abs);
    let found = false;
    for (const t of await this.turns()) {
      const dir = this.turnDir(t), file = path.join(dir, 'manifest.json');
      await withFileLock(file, async () => {
        const { entries } = await this.readManifest(t);
        const gone = entries.filter((e) => fileKey(e.abs) === key);
        if (!gone.length) { return; }
        found = true;
        const rest = entries.filter((e) => fileKey(e.abs) !== key);
        if (!rest.length) { await fs.rm(dir, { recursive: true, force: true }); return; }
        const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
        try {
          await fs.writeFile(tmp, JSON.stringify({ entries: rest }));
          await renameWithRetry(tmp, file);
        } catch (e: any) {
          await fs.rm(tmp, { force: true });
          if (e.code === 'ENOENT') { return; } // a concurrent rewind removed this turn
          throw e;
        }
        for (const e of gone) { if (e.backup) { await fs.rm(path.join(dir, e.backup), { force: true }); } }
      });
    }
    return found;
  }

  /** Rolls back `turn` and every later turn (latest first, so the earliest original wins). Returns restored paths. */
  async restore(turn: number): Promise<string[]> {
    const restored: string[] = [];
    const targets = (await this.turns()).filter((t) => t >= turn).sort((a, b) => b - a);
    for (const t of targets) {
      const { entries } = await this.readManifest(t);
      for (const e of [...entries].reverse()) {
        if (e.existed && e.backup) {
          await fs.mkdir(path.dirname(e.abs), { recursive: true });
          await fs.copyFile(path.join(this.turnDir(t), e.backup), e.abs);
        } else {
          await fs.rm(e.abs, { force: true });
        }
        restored.push(e.abs);
      }
      await fs.rm(this.turnDir(t), { recursive: true, force: true });
    }
    return [...new Set(restored)];
  }

  async clear(): Promise<void> { await fs.rm(this.dir, { recursive: true, force: true }); }
}
