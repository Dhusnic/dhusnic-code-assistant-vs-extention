import * as fs from 'fs/promises';
import * as path from 'path';

/** Reading where a repository keeps HEAD, without running git: used to watch for branch switches. */

export interface GitDirs {
  /** Folder that holds `.git` (the work tree root). */
  workTree: string;
  /** Per-work-tree git dir: has HEAD. For a linked worktree or submodule this is not `<workTree>/.git`. */
  gitDir: string;
  /** Shared git dir: has refs/ and packed-refs. Same as gitDir for a normal repository. */
  commonDir: string;
}

/** The target of a `.git` file (`gitdir: <path>`, used by worktrees and submodules), resolved against the folder holding it. */
export function parseGitFile(content: string, baseDir: string): string | undefined {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content.replace(/^﻿/, ''));
  return m ? path.resolve(baseDir, m[1]) : undefined;
}

/** Label for HEAD's contents: the branch name for `ref: refs/heads/x`, the short sha when detached, '' when unreadable. */
export function headLabel(content: string): string {
  const t = content.replace(/^﻿/, '').trim();
  const ref = /^ref:\s*(\S+)/.exec(t);
  if (ref) { return ref[1].replace(/^refs\/heads\//, ''); }
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(t) ? t.slice(0, 7).toLowerCase() : '';
}

/** Finds the git dirs for `start` or its nearest ancestor that has a `.git` folder or file. */
export async function resolveGitDirs(start: string): Promise<GitDirs | undefined> {
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    const st = await fs.stat(dotGit).catch(() => undefined);
    if (st?.isDirectory()) { return { workTree: dir, gitDir: dotGit, commonDir: dotGit }; }
    if (st?.isFile()) {
      const gitDir = parseGitFile(await fs.readFile(dotGit, 'utf8').catch(() => ''), dir);
      if (!gitDir) { return undefined; }
      const common = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
      return { workTree: dir, gitDir, commonDir: common ? path.resolve(gitDir, common) : gitDir };
    }
    const up = path.dirname(dir);
    if (up === dir) { return undefined; }
    dir = up;
  }
}

/** Current HEAD label read straight from the git dir ('' if it cannot be read). */
export async function readHeadLabel(gitDir: string): Promise<string> {
  return headLabel(await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => ''));
}
