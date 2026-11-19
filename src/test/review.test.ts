import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpDir } from './helpers';
import { CheckpointStore } from '../core/checkpoints';
import { acceptAll, acceptFile, ChangeSource, collectChanges, originalText, revertAll, revertFile } from '../core/changes';
import {
  agentWorktreeId, buildCommitMessages, cleanCommitMessage, commit, createAgentWorktree, currentBranch, defaultBranch, GitError, isGitRepo,
  listAgentWorktrees, mergeAgentWorktree, pruneOrphanWorktrees, pushCurrentBranch, removeAgentWorktree, stagedOrAllDiff, statusSummary, worktreeDiffStat,
} from '../core/git';
import { exportSessionHtml, exportSessionMarkdown, searchSessions } from '../core/sessionSearch';
import { LoadedSession } from '../core/store';

const hasGit = ((): boolean => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const gitTest = (name: string, fn: () => Promise<void>): void => { test(name, { skip: hasGit ? false : 'git is not installed' }, fn); };

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function emptyRepo(): Promise<string> {
  const root = await fs.realpath(await tmpDir('ica-git-'));
  sh(root, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) { sh(root, 'config', k, v); }
  return root;
}

async function repo(files: Record<string, string> = { 'a.txt': 'one\ntwo\nthree\n' }): Promise<string> {
  const root = await emptyRepo();
  for (const [f, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, f)), { recursive: true });
    await fs.writeFile(path.join(root, f), body);
  }
  sh(root, 'add', '-A'); sh(root, 'commit', '-q', '-m', 'init');
  return root;
}

const read = (...p: string[]): Promise<string> => fs.readFile(path.join(...p), 'utf8');
const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false);

async function sources(...ids: string[]): Promise<ChangeSource[]> {
  const dir = await tmpDir('ica-cp-');
  return ids.map((agentId) => ({ agentId, store: new CheckpointStore(path.join(dir, agentId)) }));
}

/* ------------------------------------------------------------------ checkpoints */

test('checkpoints: originalOf returns the earliest capture and trackedFiles lists each file once', async () => {
  const root = await tmpDir(); const [{ store }] = await sources('a');
  const f = path.join(root, 'f.txt');
  await fs.writeFile(f, 'v0');
  await store.snapshot(1, f); await fs.writeFile(f, 'v1');
  await store.snapshot(2, f); await fs.writeFile(f, 'v2');
  assert.equal((await store.originalOf(f))?.data?.toString(), 'v0');
  assert.deepEqual(await store.trackedFiles(), [f]);
  assert.equal((await store.entries(2))[0].abs, f);
  assert.equal(await store.originalOf(path.join(root, 'other')), undefined);
});

test('checkpoints: a full rewind after forgetFile restores the remaining files and leaves the forgotten one alone', async () => {
  const root = await tmpDir(); const [{ store }] = await sources('a');
  const f = path.join(root, 'forget.txt'), g = path.join(root, 'keep.txt'), h = path.join(root, 'only.txt');
  await fs.writeFile(f, 'f0'); await fs.writeFile(g, 'g0'); await fs.writeFile(h, 'h0');
  await store.snapshot(1, f); await store.snapshot(1, g); await fs.writeFile(f, 'f1'); await fs.writeFile(g, 'g1');
  await store.snapshot(2, f); await fs.writeFile(f, 'f2');
  await store.snapshot(3, g); await store.snapshot(3, h); await fs.writeFile(g, 'g2'); await fs.writeFile(h, 'h1');
  assert.equal(await store.forgetFile(f), true);
  assert.equal(await store.forgetFile(f), false);
  assert.deepEqual(await store.turns(), [1, 3], 'a turn left with nothing is removed');
  assert.deepEqual((await store.trackedFiles()).sort(), [g, h].sort());
  await store.restore(1);
  assert.equal(await read(f), 'f2');
  assert.equal(await read(g), 'g0');
  assert.equal(await read(h), 'h0');
  assert.deepEqual(await store.turns(), []);
});

test('checkpoints: parallel snapshots and forgets lose no manifest entries', async () => {
  const root = await tmpDir(); const [{ store }] = await sources('a');
  const files = Array.from({ length: 12 }, (_, i) => path.join(root, `f${i}.txt`));
  await Promise.all(files.map((f) => fs.writeFile(f, 'x')));
  await Promise.all(files.map((f) => store.snapshot(1, f)));
  assert.equal((await store.entries(1)).length, 12);
  await Promise.all(files.slice(0, 6).map((f) => store.forgetFile(f)));
  assert.deepEqual((await store.changedFiles(1)).sort(), files.slice(6).sort());
});

/* ------------------------------------------------------------------ changes */

test('changes: statuses, counts, omission of unchanged files, sorting', async () => {
  const root = await tmpDir(); const src = await sources('a');
  const p = (n: string): string => path.join(root, n);
  await fs.writeFile(p('mod.txt'), 'one\ntwo\n'); await fs.writeFile(p('del.txt'), 'x\ny\n'); await fs.writeFile(p('same.txt'), 'same\n');
  for (const n of ['mod.txt', 'del.txt', 'same.txt', 'new.txt']) { await src[0].store.snapshot(1, p(n)); }
  await fs.writeFile(p('mod.txt'), 'one\nTWO\nthree\n'); await fs.rm(p('del.txt')); await fs.writeFile(p('new.txt'), 'a\nb\n');
  const list = await collectChanges(root, src);
  assert.deepEqual(list.map((f) => [f.rel, f.status, f.added, f.removed]), [
    ['del.txt', 'deleted', 0, 2], ['mod.txt', 'modified', 2, 1], ['new.txt', 'added', 2, 0],
  ]);
});

test('changes: the earliest original across agents wins, whatever the turn numbers or source order', async () => {
  const root = await tmpDir(); const [a, b] = await sources('a', 'b');
  const f = path.join(root, 'shared.txt');
  await fs.writeFile(f, 'base\n');
  await b.store.snapshot(9, f); await fs.writeFile(f, 'base\nfrom b\n');
  await a.store.snapshot(1, f); await fs.writeFile(f, 'base\nfrom b\nfrom a\n');
  const [c] = await collectChanges(root, [a, b]);
  assert.deepEqual([...c.agents].sort(), ['a', 'b']);
  assert.equal(c.added, 2);
  assert.equal(c.conflict, false, 'b finished before a started, so a built on b');
  assert.equal(await originalText([a, b], f), 'base\n');
  await revertFile([a, b], f, root);
  assert.equal(await read(f), 'base\n');
  assert.deepEqual(await collectChanges(root, [a, b]), []);
});

test('changes: agents that started from the same original are flagged as a conflict', async () => {
  const root = await tmpDir(); const [a, b] = await sources('a', 'b');
  const f = path.join(root, 'race.txt');
  await fs.writeFile(f, 'base\n');
  await a.store.snapshot(1, f); await b.store.snapshot(1, f);
  await fs.writeFile(f, 'last writer\n');
  assert.equal((await collectChanges(root, [a, b]))[0].conflict, true);
});

test('changes: revert of an added file deletes it, accept keeps it, both leave the list', async () => {
  const root = await tmpDir(); const src = await sources('a');
  const f = path.join(root, 'dir with space', 'añadido.txt'), g = path.join(root, 'kept.txt');
  await src[0].store.snapshot(1, f); await src[0].store.snapshot(1, g);
  await fs.mkdir(path.dirname(f)); await fs.writeFile(f, 'new'); await fs.writeFile(g, 'new');
  assert.equal((await collectChanges(root, src))[0].rel, 'dir with space/añadido.txt');
  assert.equal(await originalText(src, f), '');
  await revertFile(src, f, root);
  assert.equal(await exists(f), false);
  await acceptFile(src, g);
  assert.equal(await read(g), 'new');
  assert.deepEqual(await collectChanges(root, src), []);
  assert.deepEqual(await src[0].store.trackedFiles(), []);
});

test('changes: binary files are detected, never decoded, and restored byte for byte', async () => {
  const root = await tmpDir(); const src = await sources('a');
  const f = path.join(root, 'b.bin'), bytes = Buffer.from([0, 255, 254, 0, 10, 13, 128]);
  await fs.writeFile(f, bytes); await src[0].store.snapshot(1, f);
  await fs.writeFile(f, Buffer.from([0, 1, 2]));
  const [c] = await collectChanges(root, src);
  assert.deepEqual([c.binary, c.added, c.removed, c.status], [true, 0, 0, 'modified']);
  assert.equal(await originalText(src, f), undefined);
  await revertFile(src, f, root);
  assert.deepEqual(await fs.readFile(f), bytes);
});

test('changes: files over 2MB are listed without line counts', async () => {
  const root = await tmpDir(); const src = await sources('a');
  const f = path.join(root, 'big.txt');
  await fs.writeFile(f, 'small\n'); await src[0].store.snapshot(1, f);
  await fs.writeFile(f, 'line\n'.repeat(500_000));
  const [c] = await collectChanges(root, src);
  assert.deepEqual([c.status, c.added, c.removed, c.binary], ['modified', 0, 0, false]);
});

test('changes: revert refuses paths outside the root and keeps the checkpoint', async () => {
  const root = await tmpDir(), outside = await tmpDir(); const src = await sources('a');
  const f = path.join(outside, 'secret.txt');
  await fs.writeFile(f, 'v0'); await src[0].store.snapshot(1, f); await fs.writeFile(f, 'v1');
  await assert.rejects(revertFile(src, f, root), /outside the workspace/);
  await assert.rejects(revertFile(src, path.join(root, '..', path.basename(outside), 'secret.txt'), root), /outside the workspace/);
  assert.equal(await read(f), 'v1');
  assert.deepEqual(await src[0].store.trackedFiles(), [f]);
  assert.deepEqual(await collectChanges(root, src), [], 'outside files are not listed');
});

test('changes: revert refuses to write through a symlink that leaves the root', async (t) => {
  const root = await tmpDir(), outside = await tmpDir(); const src = await sources('a');
  try { await fs.symlink(outside, path.join(root, 'link'), 'junction'); } catch { t.skip('symlinks are not available'); return; }
  const f = path.join(root, 'link', 'x.txt');
  await fs.writeFile(f, 'v0'); await src[0].store.snapshot(1, f); await fs.writeFile(f, 'v1');
  await assert.rejects(revertFile(src, f, root), /outside the workspace/);
  assert.equal(await read(outside, 'x.txt'), 'v1');
});

test('changes: revertAll reports each file and does not stop at a failure', async () => {
  const root = await tmpDir(); const src = await sources('a');
  const bad = path.join(root, 'blocked'), good = path.join(root, 'good.txt');
  await fs.writeFile(bad, 'b0'); await fs.writeFile(good, 'g0');
  await src[0].store.snapshot(1, bad); await src[0].store.snapshot(1, good);
  await fs.rm(bad); await fs.mkdir(bad); await fs.writeFile(path.join(bad, 'occupied'), 'x'); await fs.writeFile(good, 'g1');
  const res = await revertAll(root, src);
  assert.equal(res.find((r) => r.abs === bad)?.ok, false);
  assert.ok(res.find((r) => r.abs === bad)?.error);
  assert.equal(res.find((r) => r.abs === good)?.ok, true);
  assert.equal(await read(good), 'g0');
  assert.deepEqual(await src[0].store.trackedFiles(), [bad], 'the failed file keeps its checkpoint');
});

test('changes: revertAll undoes a file that an agent replaced with a directory', async () => {
  const root = await tmpDir(); const src = await sources('a');
  const f = path.join(root, 'thing'), inner = path.join(f, 'inner.txt');
  await fs.writeFile(f, 'file'); await src[0].store.snapshot(1, f); await fs.rm(f);
  await src[0].store.snapshot(1, inner); await fs.mkdir(f); await fs.writeFile(inner, 'x');
  assert.ok((await revertAll(root, src)).every((r) => r.ok));
  assert.equal(await read(f), 'file');
});

test('changes: acceptAll clears everything and keeps the content', async () => {
  const root = await tmpDir(); const src = await sources('a', 'b');
  const f = path.join(root, 'x.txt');
  await fs.writeFile(f, '0'); await src[0].store.snapshot(1, f); await src[1].store.snapshot(1, f); await fs.writeFile(f, '1');
  assert.deepEqual(await acceptAll(root, src), [{ abs: f, ok: true }]);
  assert.equal(await read(f), '1');
  assert.deepEqual(await collectChanges(root, src), []);
});

/* ------------------------------------------------------------------ git: basics */

gitTest('git: unborn branch', async () => {
  const root = await emptyRepo();
  assert.equal(await isGitRepo(root), true);
  assert.equal(await currentBranch(root), 'main');
  await fs.writeFile(path.join(root, 'n.txt'), 'x');
  const s = await statusSummary(root);
  assert.deepEqual([s.branch, s.detached, s.untracked, s.staged], ['main', false, 1, 0]);
  sh(root, 'add', '-A');
  const d = await stagedOrAllDiff(root);
  assert.equal(d.source, 'staged');
  assert.match(d.diff, /n\.txt/);
  await assert.rejects(createAgentWorktree(root, path.join(root, '..', 'wt'), 's', 'a'), (e: GitError) => e.code === 'NO_COMMITS');
});

gitTest('git: detached HEAD gives the short sha', async () => {
  const root = await repo();
  sh(root, 'checkout', '-q', '--detach');
  const short = sh(root, 'rev-parse', '--short', 'HEAD');
  assert.equal(await currentBranch(root), short);
  const s = await statusSummary(root);
  assert.deepEqual([s.branch, s.detached], [short, true]);
  await assert.rejects(pushCurrentBranch(root), (e: GitError) => e.code === 'DETACHED');
});

gitTest('git: not a repository, errors carry code and stderr', async () => {
  const dir = await tmpDir();
  assert.equal(await isGitRepo(dir), false);
  await assert.rejects(statusSummary(dir), (e: GitError) => e instanceof GitError && e.code === 128 && /not a git repository/i.test(e.stderr));
});

gitTest('git: an aborted signal rejects before running', async () => {
  const root = await repo(); const ac = new AbortController(); ac.abort();
  await assert.rejects(statusSummary(root, { signal: ac.signal }), (e: GitError) => e.code === 'ABORTED');
});

gitTest('git: status counts with spaces, unicode and renames', async () => {
  const root = await repo({ 'old name.txt': 'a\n', 'ünï çødé.txt': 'b\n', 'c.txt': 'c\n' });
  sh(root, 'mv', 'old name.txt', 'new name.txt');
  await fs.writeFile(path.join(root, 'ünï çødé.txt'), 'changed\n');
  await fs.writeFile(path.join(root, 'nuevo archivo ñ.txt'), 'x');
  const s = await statusSummary(root);
  assert.deepEqual([s.staged, s.unstaged, s.untracked, s.ahead, s.behind], [1, 1, 1, 0, 0]);
});

gitTest('git: ahead is read from the upstream; a non-fast-forward push is rejected, not forced', async () => {
  const remote = await fs.realpath(await tmpDir('ica-remote-'));
  sh(remote, 'init', '-q', '--bare', '-b', 'main');
  const root = await repo();
  sh(root, 'remote', 'add', 'origin', remote);
  assert.deepEqual(await pushCurrentBranch(root), { remote: 'origin', branch: 'main' });
  await fs.writeFile(path.join(root, 'a.txt'), 'later\n');
  await commit(root, 'later', { stageAll: true });
  assert.equal((await statusSummary(root)).ahead, 1);
  sh(root, 'fetch', '-q', 'origin');
  assert.equal(await defaultBranch(root), 'main');
  sh(root, 'reset', '-q', '--hard', 'HEAD~1');
  await fs.writeFile(path.join(root, 'b.txt'), 'diverged\n');
  await commit(root, 'diverged', { stageAll: true });
  await pushCurrentBranch(root);
  sh(root, 'reset', '-q', '--hard', 'HEAD~1');
  await fs.writeFile(path.join(root, 'c.txt'), 'rejected\n');
  await commit(root, 'rejected', { stageAll: true });
  await assert.rejects(pushCurrentBranch(root), GitError, 'a non-fast-forward push must fail, not force');
});

gitTest('git: diff prefers staged, leaves out lockfiles and clips on a file boundary', async () => {
  const root = await repo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'sub/package-lock.json': '{}\n', 'yarn.lock': 'x\n' });
  await fs.writeFile(path.join(root, 'a.txt'), `${'A'.repeat(300)}\n`);
  await fs.writeFile(path.join(root, 'b.txt'), `${'B'.repeat(300)}\n`);
  await fs.writeFile(path.join(root, 'sub/package-lock.json'), '{"a":1}\n');
  await fs.writeFile(path.join(root, 'yarn.lock'), 'y\n');
  const all = await stagedOrAllDiff(root);
  assert.equal(all.source, 'worktree');
  assert.doesNotMatch(all.diff, /package-lock|yarn\.lock/);
  const clipped = await stagedOrAllDiff(root, 500);
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.omittedFiles, 1);
  assert.equal(clipped.diff.match(/^diff --git /gm)?.length, 1);
  assert.ok(clipped.diff.endsWith('\n') && clipped.diff.includes('A'.repeat(300)));
  sh(root, 'add', 'b.txt');
  const staged = await stagedOrAllDiff(root);
  assert.equal(staged.source, 'staged');
  assert.match(staged.diff, /b\.txt/);
  assert.doesNotMatch(staged.diff, /a\.txt/);
});

gitTest('git: commit sends the message on stdin and runs hooks', async () => {
  const root = await repo();
  const message = 'feat: "quoted" $HOME `tick` ; rm -rf /\n\nBody ünï';
  await fs.writeFile(path.join(root, 'file with space.txt'), 'x');
  const res = await commit(root, message, { stageAll: true });
  assert.equal(sh(root, 'log', '-1', '--format=%B'), message);
  assert.equal(res.sha, sh(root, 'rev-parse', 'HEAD'));
  await assert.rejects(commit(root, '   '), (e: GitError) => e.code === 'EMPTY_MESSAGE');
  await fs.writeFile(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho blocked >&2\nexit 1\n', { mode: 0o755 });
  await fs.writeFile(path.join(root, 'y.txt'), 'y');
  await assert.rejects(commit(root, 'should fail', { stageAll: true }), (e: GitError) => /blocked/.test(e.stderr));
});

test('git: cleanCommitMessage strips wrapping and limits the subject', () => {
  assert.equal(cleanCommitMessage('<think>plan\nmore</think>\n```text\nfix: a bug  \n\n\n\nbody line   \n```\n'), 'fix: a bug\n\nbody line');
  assert.equal(cleanCommitMessage('"add feature"'), 'add feature');
  assert.equal(cleanCommitMessage("'`add feature`'"), 'add feature');
  assert.equal(cleanCommitMessage('"a" and "b" differ'), '"a" and "b" differ');
  assert.equal(cleanCommitMessage('<thinking>never closed'), '');
  assert.equal(cleanCommitMessage('Commit message: tidy up'), 'tidy up');
  const subject = cleanCommitMessage(`update ${'word '.repeat(40)}`).split('\n')[0];
  assert.ok(subject.length <= 72 && !subject.endsWith(' ') && subject.endsWith('word'));
  assert.ok(cleanCommitMessage('x'.repeat(200)).length <= 72);
});

test('git: buildCommitMessages carries the diff, branch and recent subjects', () => {
  const [system, user] = buildCommitMessages('diff --git a b', ['first', 'second'], 'feature/x');
  assert.equal(system.role, 'system');
  assert.equal(user.role, 'user');
  for (const part of ['feature/x', 'first', 'second', 'diff --git a b']) { assert.ok(user.content?.includes(part)); }
});

/* ------------------------------------------------------------------ git: worktrees */

const wtBase = async (): Promise<string> => fs.realpath(await tmpDir('ica-wts-'));

gitTest('worktree: create is idempotent, names are sanitised, and list finds it', async () => {
  const root = await repo(); const base = await wtBase();
  const wt = await createAgentWorktree(root, base, 'sess 1', '../a~b');
  assert.match(wt.branch, /^infraon\/[A-Za-z0-9._-]+$/);
  assert.equal(path.dirname(wt.path), base);
  assert.equal(wt.base, sh(root, 'rev-parse', 'HEAD'));
  assert.equal(sh(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD'), wt.branch);
  const again = await createAgentWorktree(root, base, 'sess 1', '../a~b');
  assert.deepEqual([path.normalize(again.path), again.branch, again.base], [path.normalize(wt.path), wt.branch, wt.base]);
  const listed = await listAgentWorktrees(root);
  assert.deepEqual(listed.map((w) => w.branch), [wt.branch]);
  const parallel = await Promise.all(['x', 'y', 'z'].map((a) => createAgentWorktree(root, base, 's', a)));
  assert.equal(new Set(parallel.map((w) => w.path)).size, 3);
});

gitTest('worktree: merge commits uncommitted work, including spaces and unicode in names', async () => {
  const root = await repo(); const wt = await createAgentWorktree(root, await wtBase(), 's', 'a');
  await fs.writeFile(path.join(wt.path, 'a.txt'), 'one\ntwo\nthree\nfour\n');
  await fs.writeFile(path.join(wt.path, 'nuevo ñandú 文件.txt'), 'l1\nl2\n');
  const stat = await worktreeDiffStat(root, wt);
  assert.deepEqual(stat.files.map((f) => [f.path, f.added, f.removed, f.untracked]), [['a.txt', 1, 0, false], ['nuevo ñandú 文件.txt', 2, 0, true]]);
  assert.deepEqual(await mergeAgentWorktree(root, wt), { ok: true, conflicts: [], merged: true });
  assert.equal(await read(root, 'nuevo ñandú 文件.txt'), 'l1\nl2\n');
  assert.equal(sh(root, 'status', '--porcelain'), '');
  assert.deepEqual(await mergeAgentWorktree(root, wt), { ok: true, conflicts: [], merged: false }, 'merging again changes nothing');
  await removeAgentWorktree(root, wt, { deleteBranch: true });
  assert.equal(await exists(wt.path), false);
  assert.equal(sh(root, 'branch', '--list', wt.branch), '');
});

gitTest('worktree: a conflicting merge is aborted and the main tree is left untouched', async () => {
  const root = await repo(); const wt = await createAgentWorktree(root, await wtBase(), 's', 'a');
  await fs.writeFile(path.join(wt.path, 'a.txt'), 'agent\n');
  await fs.writeFile(path.join(root, 'a.txt'), 'human\n');
  sh(root, 'commit', '-qam', 'human edit');
  await fs.writeFile(path.join(root, 'unrelated local.txt'), 'keep me\n');
  const head = sh(root, 'rev-parse', 'HEAD');
  const res = await mergeAgentWorktree(root, wt);
  assert.deepEqual([res.ok, res.merged, res.reason, res.conflicts], [false, false, 'conflict', ['a.txt']]);
  assert.equal(sh(root, 'rev-parse', 'HEAD'), head);
  assert.equal(await read(root, 'a.txt'), 'human\n');
  assert.equal(await read(root, 'unrelated local.txt'), 'keep me\n');
  assert.equal(await exists(path.join(root, '.git', 'MERGE_HEAD')), false);
  assert.equal(sh(root, 'status', '--porcelain'), '?? "unrelated local.txt"');
  assert.equal(sh(wt.path, 'log', '-1', '--format=%s'), `Agent work on ${wt.branch}`, 'the agent work is safe on its branch');
});

gitTest('worktree: refuses when the main tree is dirty in the same files', async () => {
  const root = await repo({ 'my file.txt': 'base\n', 'other.txt': 'base\n' }); const wt = await createAgentWorktree(root, await wtBase(), 's', 'a');
  await fs.writeFile(path.join(wt.path, 'my file.txt'), 'agent\n');
  await fs.writeFile(path.join(root, 'my file.txt'), 'uncommitted human work\n');
  const head = sh(root, 'rev-parse', 'HEAD');
  const res = await mergeAgentWorktree(root, wt);
  assert.deepEqual([res.ok, res.merged, res.reason, res.conflicts], [false, false, 'dirty', ['my file.txt']]);
  assert.equal(await read(root, 'my file.txt'), 'uncommitted human work\n');
  assert.equal(sh(root, 'rev-parse', 'HEAD'), head);
});

gitTest('worktree: an untracked main file at the same path also blocks the merge', async () => {
  const root = await repo(); const wt = await createAgentWorktree(root, await wtBase(), 's', 'a');
  await fs.writeFile(path.join(wt.path, 'clash.txt'), 'agent\n');
  await fs.writeFile(path.join(root, 'clash.txt'), 'human\n');
  const res = await mergeAgentWorktree(root, wt);
  assert.deepEqual([res.ok, res.reason, res.conflicts], [false, 'dirty', ['clash.txt']]);
  assert.equal(await read(root, 'clash.txt'), 'human\n');
});

gitTest('worktree: unrelated local changes do not block a merge and survive it', async () => {
  const root = await repo({ 'a.txt': 'a\n', 'b.txt': 'b\n' }); const wt = await createAgentWorktree(root, await wtBase(), 's', 'a');
  await fs.writeFile(path.join(wt.path, 'a.txt'), 'agent\n');
  await fs.writeFile(path.join(root, 'b.txt'), 'local\n');
  assert.equal((await mergeAgentWorktree(root, wt)).merged, true);
  assert.equal(await read(root, 'a.txt'), 'agent\n');
  assert.equal(await read(root, 'b.txt'), 'local\n');
});

gitTest('worktree: a merge the user already started is never aborted', async () => {
  const root = await repo(); const wt = await createAgentWorktree(root, await wtBase(), 's', 'a');
  await fs.writeFile(path.join(wt.path, 'z.txt'), 'agent\n');
  sh(root, 'checkout', '-q', '-b', 'side');
  await fs.writeFile(path.join(root, 'a.txt'), 'side\n'); sh(root, 'commit', '-qam', 'side');
  sh(root, 'checkout', '-q', 'main');
  await fs.writeFile(path.join(root, 'a.txt'), 'main\n'); sh(root, 'commit', '-qam', 'main');
  assert.throws(() => sh(root, 'merge', 'side'));
  const res = await mergeAgentWorktree(root, wt);
  assert.deepEqual([res.ok, res.reason], [false, 'busy']);
  assert.equal(await exists(path.join(root, '.git', 'MERGE_HEAD')), true);
});

gitTest('worktree: removal refuses dirty work unless forced', async () => {
  const root = await repo(); const wt = await createAgentWorktree(root, await wtBase(), 's', 'a');
  await fs.writeFile(path.join(wt.path, 'wip.txt'), 'wip');
  await assert.rejects(removeAgentWorktree(root, wt), GitError);
  assert.equal(await exists(path.join(wt.path, 'wip.txt')), true);
  await removeAgentWorktree(root, wt, { force: true, deleteBranch: true });
  assert.deepEqual(await listAgentWorktrees(root), []);
  await removeAgentWorktree(root, wt, { deleteBranch: true });
});

gitTest('worktree: prune removes clean orphans only and keeps unmerged commits', async () => {
  const root = await repo(); const base = await wtBase();
  const live = await createAgentWorktree(root, base, 'sess', 'live');
  const clean = await createAgentWorktree(root, base, 'sess', 'clean');
  const dirty = await createAgentWorktree(root, base, 'sess', 'dirty');
  const committed = await createAgentWorktree(root, base, 'sess', 'committed');
  sh(root, 'branch', 'infraon-not-mine');
  await fs.writeFile(path.join(dirty.path, 'wip.txt'), 'wip');
  await fs.writeFile(path.join(committed.path, 'done.txt'), 'done');
  await commit(committed.path, 'done', { stageAll: true });
  const res = await pruneOrphanWorktrees(root, [agentWorktreeId('sess', 'live')]);
  assert.deepEqual(res.removed.sort(), [clean.branch, committed.branch].sort());
  assert.deepEqual(res.kept.map((k) => k.branch), [dirty.branch]);
  assert.equal(await exists(live.path), true);
  assert.equal(await exists(path.join(dirty.path, 'wip.txt')), true);
  assert.equal(await exists(clean.path), false);
  assert.equal(sh(root, 'branch', '--list', clean.branch), '', 'a merged branch goes with its worktree');
  assert.notEqual(sh(root, 'branch', '--list', committed.branch), '', 'unmerged commits survive');
  assert.notEqual(sh(root, 'branch', '--list', 'infraon-not-mine'), '');
});

/* ------------------------------------------------------------------ session search */

interface Msg { role: string; content: string | null; display?: string }

async function saveSession(dir: string, id: string, title: string, updatedAt: number, agents: Record<string, Msg[]>): Promise<void> {
  await fs.mkdir(path.join(dir, id, 'agents'), { recursive: true });
  await fs.writeFile(path.join(dir, id, 'session.json'), JSON.stringify({ v: 2, id, title, createdAt: updatedAt, updatedAt, agents: [] }));
  for (const [aid, history] of Object.entries(agents)) {
    const turnStarts = history.flatMap((m, i) => (m.role === 'user' ? [i] : []));
    await fs.writeFile(path.join(dir, id, 'agents', `${aid}.json`), JSON.stringify({ v: 2, id: aid, sessionId: id, name: aid, updatedAt, status: 'idle', history, turnStarts }));
  }
}

const NOW = Date.now();
const DAY = 86_400_000;

test('search: case-insensitive, AND across the whole session, phrases', async () => {
  const dir = await tmpDir();
  await saveSession(dir, 's1', 'Chat', NOW, { a1: [{ role: 'user', content: 'The QUICK brown fox' }], a2: [{ role: 'assistant', content: 'a lazy dog' }] });
  await saveSession(dir, 's2', 'Chat', NOW, { a1: [{ role: 'user', content: 'quick only' }] });
  await saveSession(dir, 's3', 'Chat', NOW, { a1: [{ role: 'user', content: 'brown\nquick fox' }] });
  assert.deepEqual((await searchSessions(dir, 'quick LAZY')).map((h) => h.sessionId), ['s1']);
  assert.deepEqual((await searchSessions(dir, '"quick brown"')).map((h) => h.sessionId), ['s1']);
  assert.deepEqual((await searchSessions(dir, '"brown quick"')).map((h) => h.sessionId), ['s3'], 'a phrase spans a line break');
  assert.deepEqual(await searchSessions(dir, '   '), []);
  assert.deepEqual(await searchSessions(path.join(dir, 'missing'), 'x'), []);
});

test('search: title hits and recency rank higher', async () => {
  const dir = await tmpDir();
  await saveSession(dir, 'body-new', 'Chat', NOW, { a1: [{ role: 'user', content: 'deploy '.repeat(30) }] });
  await saveSession(dir, 'title-old', 'Deploy plan', NOW - 200 * DAY, { a1: [{ role: 'user', content: 'nothing here' }] });
  await saveSession(dir, 'body-old', 'Chat', NOW - 200 * DAY, { a1: [{ role: 'user', content: 'deploy '.repeat(30) }] });
  const hits = await searchSessions(dir, 'deploy');
  assert.deepEqual(hits.map((h) => h.sessionId), ['title-old', 'body-new', 'body-old']);
  assert.ok(hits[0].score > hits[1].score && hits[1].score > hits[2].score);
  assert.deepEqual(hits[0].matches, []);
  assert.equal(hits[0].title, 'Deploy plan');
  assert.equal((await searchSessions(dir, 'deploy', { limit: 1 })).length, 1);
});

test('search: reads display over content, tool results, and never system messages', async () => {
  const dir = await tmpDir();
  await saveSession(dir, 's', 'Chat', NOW, { a1: [
    { role: 'system', content: 'systemsecret' },
    { role: 'user', content: 'expandedmention body', display: 'shown text' },
    { role: 'assistant', content: null },
    { role: 'tool', content: 'toolresultword' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'replyword' },
  ] });
  assert.deepEqual(await searchSessions(dir, 'systemsecret'), []);
  assert.deepEqual(await searchSessions(dir, 'expandedmention'), []);
  assert.deepEqual(await searchSessions(dir, 'shown systemsecret'), [], 'a system message cannot satisfy a term');
  assert.deepEqual((await searchSessions(dir, 'shown'))[0].matches.map((m) => [m.role, m.turn]), [['user', 0]]);
  assert.deepEqual((await searchSessions(dir, 'toolresultword'))[0].matches.map((m) => [m.role, m.turn]), [['tool', 0]]);
  assert.deepEqual((await searchSessions(dir, 'replyword'))[0].matches.map((m) => [m.agentId, m.role, m.turn]), [['a1', 'assistant', 1]]);
});

test('search: terms that JSON escapes are still found', async () => {
  const dir = await tmpDir();
  await saveSession(dir, 's', 'Chat', NOW, { a1: [{ role: 'user', content: 'open C:\\temp\\file and say "hi there" ñandú' }] });
  assert.equal((await searchSessions(dir, 'C:\\temp\\file')).length, 1);
  assert.equal((await searchSessions(dir, '"hi there"')).length, 1);
  assert.equal((await searchSessions(dir, 'ÑANDÚ')).length, 1);
  assert.equal((await searchSessions(dir, 'a.c(')).length, 0, 'regex characters are literal');
});

test('search: skips .bak and .tmp, tolerates corrupt files', async () => {
  const dir = await tmpDir();
  await saveSession(dir, 'good', 'Chat', NOW, { a1: [{ role: 'user', content: 'needle' }] });
  await fs.writeFile(path.join(dir, 'good', 'agents', 'a1.json.bak'), JSON.stringify({ id: 'a1', history: [{ role: 'user', content: 'onlyinbak' }] }));
  await fs.writeFile(path.join(dir, 'good', 'agents', 'a1.json.1.ab.tmp'), JSON.stringify({ id: 'a1', history: [{ role: 'user', content: 'onlyintmp' }] }));
  await fs.writeFile(path.join(dir, 'good', 'agents', 'broken.json'), '{"history":[{"role":"user","content":"needle');
  await fs.writeFile(path.join(dir, 'good', 'agents', 'shape.json'), '{"history":"needle"}');
  await saveSession(dir, 'nometa', 'x', NOW, { a1: [{ role: 'user', content: 'needle' }] });
  await fs.writeFile(path.join(dir, 'nometa', 'session.json'), 'not json');
  await fs.mkdir(path.join(dir, 'empty'));
  await fs.writeFile(path.join(dir, 'stray.json'), 'needle');
  assert.deepEqual(await searchSessions(dir, 'onlyinbak'), []);
  assert.deepEqual(await searchSessions(dir, 'onlyintmp'), []);
  const hits = await searchSessions(dir, 'needle');
  assert.deepEqual(hits.map((h) => h.sessionId).sort(), ['good', 'nometa']);
  assert.equal(hits.find((h) => h.sessionId === 'nometa')?.title, '(untitled)');
});

test('search: snippets stay short, cut on words, and ranges point at the match', async () => {
  const dir = await tmpDir();
  const long = `${'alpha beta gamma '.repeat(40)}Target${' delta epsilon zeta'.repeat(40)}`;
  await saveSession(dir, 's', 'Chat', NOW, { a1: [{ role: 'assistant', content: long }, { role: 'assistant', content: 'one\n\n  two   target' }] });
  const hits = await searchSessions(dir, 'target', { perSession: 5 });
  const [wide, short] = [...hits[0].matches].sort((a, b) => b.snippet.length - a.snippet.length);
  assert.ok(wide.snippet.length <= 160);
  assert.ok(wide.snippet.startsWith('…') && wide.snippet.endsWith('…'));
  assert.match(wide.snippet, /^…(alpha|beta|gamma) /);
  assert.match(wide.snippet, / (delta|epsilon|zeta)…$/);
  const [from, to] = wide.ranges[0];
  assert.equal(wide.snippet.slice(from, to), 'Target');
  assert.equal(short.snippet, 'one two target');
  assert.equal(short.snippet.slice(...short.ranges[0]), 'target');
});

test('search: perSession caps matches, onResult streams, abort rejects', async () => {
  const dir = await tmpDir();
  for (let i = 0; i < 12; i++) {
    await saveSession(dir, `s${i}`, 'Chat', NOW - i * DAY, { a1: Array.from({ length: 6 }, () => ({ role: 'user', content: 'word' })) });
  }
  const seen: string[] = [];
  const hits = await searchSessions(dir, 'word', { perSession: 2, concurrency: 3, onResult: (h) => seen.push(h.sessionId) });
  assert.equal(hits.length, 12);
  assert.ok(hits.every((h) => h.matches.length === 2));
  assert.ok((await searchSessions(dir, 'word', { perSession: 0 })).every((h) => h.matches.length === 0));
  assert.deepEqual([...seen].sort(), hits.map((h) => h.sessionId).sort());
  assert.deepEqual(hits.slice(0, 3).map((h) => h.sessionId), ['s0', 's1', 's2']);
  const ac = new AbortController();
  await assert.rejects(searchSessions(dir, 'word', { signal: ac.signal, concurrency: 1, onResult: () => ac.abort() }), /Cancelled/);
});

/* ------------------------------------------------------------------ export */

function loadedSession(title: string, history: any[]): LoadedSession {
  const agent = { v: 2, id: 'a1', sessionId: 's', name: 'Agent <1>', createdAt: 0, updatedAt: 0, status: 'idle', model: 'm', mode: 'ask', effort: 'low', history, turnStarts: [0] };
  return { meta: { v: 2, id: 's', title, createdAt: 0, updatedAt: 0, agents: [] }, agents: [agent as any, { ...agent, id: 'a2', name: 'Second' } as any], warnings: [] };
}

const XSS = '<script>alert("x")</script><img src=x onerror=alert(1)>&';

test('export: HTML escapes everything and is self-contained', () => {
  const html = exportSessionHtml(loadedSession(`T ${XSS}`, [
    { role: 'system', content: 'hidden system prompt' },
    { role: 'user', content: 'raw', display: XSS },
    { role: 'assistant', content: XSS, tool_calls: [{ id: 'c', type: 'function', function: { name: '<b>tool</b>', arguments: XSS } }] },
    { role: 'tool', tool_call_id: 'c', content: XSS },
  ]), { includeTools: true });
  assert.doesNotMatch(html, /<script|<img|<b>|onerror=alert\(1\)>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /Agent &lt;1&gt;/);
  assert.doesNotMatch(html, /hidden system prompt/);
  assert.doesNotMatch(html, /https?:\/\/|@import|url\(|\bsrc=["']/);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /color-scheme:light dark/);
});

test('export: tools are optional and a bad timestamp does not throw', () => {
  const session = loadedSession('Plain', [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'read_file', arguments: '{"p":1}' } }] },
    { role: 'tool', tool_call_id: 'c', content: 'tool output' },
    { role: 'assistant', content: 'done' },
  ]);
  (session.meta as any).updatedAt = 'nonsense';
  for (const render of [exportSessionHtml, exportSessionMarkdown]) {
    assert.doesNotMatch(render(session, { includeTools: false }), /read_file|tool output/);
    assert.match(render(session, { includeTools: true }), /read_file[\s\S]*tool output/);
  }
});

test('export: Markdown fences cannot be closed by the content', () => {
  const md = exportSessionMarkdown(loadedSession('Fence\nTitle', [
    { role: 'user', content: 'x' },
    { role: 'tool', tool_call_id: 'c', content: 'before\n```\nescaped\n```' },
  ]), { includeTools: true });
  assert.ok(md.startsWith('# Fence Title\n'));
  assert.match(md, /\n````\nbefore\n```\nescaped\n```\n````\n/);
});
