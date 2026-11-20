import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpDir } from './helpers';
import { headLabel, parseGitFile, readHeadLabel, resolveGitDirs } from '../core/gitHead';

test('headLabel: branch, nested branch, detached sha, other refs, junk', () => {
  assert.equal(headLabel('ref: refs/heads/main\n'), 'main');
  assert.equal(headLabel('﻿ref: refs/heads/feature/x-1\r\n'), 'feature/x-1');
  assert.equal(headLabel('ref: refs/remotes/origin/main'), 'refs/remotes/origin/main');
  assert.equal(headLabel('0123456789ABCDEF0123456789abcdef01234567\n'), '0123456');
  assert.equal(headLabel('a'.repeat(64)), 'aaaaaaa'); // sha256 repositories
  assert.equal(headLabel(''), '');
  assert.equal(headLabel('not a head'), '');
});

test('parseGitFile: relative and absolute gitdir lines', () => {
  const base = path.resolve('/repo/sub');
  assert.equal(parseGitFile('gitdir: ../.git/modules/sub\n', base), path.resolve(base, '../.git/modules/sub'));
  const abs = path.resolve('/elsewhere/.git/worktrees/wt');
  assert.equal(parseGitFile(`gitdir: ${abs}\r\n`, base), abs);
  assert.equal(parseGitFile('nonsense', base), undefined);
});

test('resolveGitDirs: plain repo from a nested folder, linked worktree, submodule', async () => {
  const root = await fs.realpath(await tmpDir('ica-head-'));
  const main = path.join(root, 'main');
  await fs.mkdir(path.join(main, '.git', 'refs', 'heads'), { recursive: true });
  await fs.writeFile(path.join(main, '.git', 'HEAD'), 'ref: refs/heads/dev\n');
  await fs.mkdir(path.join(main, 'src', 'deep'), { recursive: true });
  assert.deepEqual(await resolveGitDirs(path.join(main, 'src', 'deep')), { workTree: main, gitDir: path.join(main, '.git'), commonDir: path.join(main, '.git') });
  assert.equal(await readHeadLabel(path.join(main, '.git')), 'dev');

  const wtGit = path.join(main, '.git', 'worktrees', 'wt');
  await fs.mkdir(wtGit, { recursive: true });
  await fs.writeFile(path.join(wtGit, 'HEAD'), 'fedcba9876543210fedcba9876543210fedcba98\n');
  await fs.writeFile(path.join(wtGit, 'commondir'), '../..\n');
  const wt = path.join(root, 'wt');
  await fs.mkdir(wt);
  await fs.writeFile(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.deepEqual(await resolveGitDirs(wt), { workTree: wt, gitDir: wtGit, commonDir: path.join(main, '.git') });
  assert.equal(await readHeadLabel(wtGit), 'fedcba9');

  // submodule-style: relative gitdir, no commondir
  const modGit = path.join(main, '.git', 'modules', 'lib');
  await fs.mkdir(modGit, { recursive: true });
  const lib = path.join(main, 'lib');
  await fs.mkdir(lib);
  await fs.writeFile(path.join(lib, '.git'), 'gitdir: ../.git/modules/lib\n');
  assert.deepEqual(await resolveGitDirs(lib), { workTree: lib, gitDir: modGit, commonDir: modGit });
  assert.equal(await readHeadLabel(modGit), '');
});
