import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { diffText } from '../core/diff';
import { CheckpointStore } from '../core/checkpoints';
import { Agent } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { call, fakeLlm, recordingUi, text, tmpDir } from './helpers';

test('diff: identical text has no changes', () => {
  const d = diffText('a\nb\nc', 'a\nb\nc');
  assert.equal(d.added, 0); assert.equal(d.removed, 0); assert.deepEqual(d.lines, []);
});

test('diff: single line replacement', () => {
  const d = diffText('a\nb\nc', 'a\nX\nc');
  assert.equal(d.added, 1); assert.equal(d.removed, 1);
  assert.deepEqual(d.lines.map((l) => l.t), ['ctx', 'del', 'add', 'ctx']);
  assert.equal((d.lines[1] as any).text, 'b');
  assert.equal((d.lines[2] as any).text, 'X');
});

test('diff: new file is all additions, deleted file all removals', () => {
  const n = diffText('', 'x\ny');
  assert.equal(n.added, 2); assert.equal(n.removed, 0);
  const r = diffText('x\ny', '');
  assert.equal(r.removed, 2); assert.equal(r.added, 0);
});

test('diff: collapses long unchanged regions into a gap marker', () => {
  const base = Array.from({ length: 30 }, (_, i) => `line${i}`);
  const changed = [...base]; changed[0] = 'FIRST'; changed[29] = 'LAST';
  const d = diffText(base.join('\n'), changed.join('\n'), 2);
  assert.ok(d.lines.some((l) => l.t === 'gap'));
  assert.equal(d.added, 2);
  assert.ok(d.lines.length < 20);
});

test('diff: insertion in the middle keeps surrounding context and line numbers', () => {
  const d = diffText('a\nb\nc\nd', 'a\nb\nNEW\nc\nd');
  const add = d.lines.find((l) => l.t === 'add') as any;
  assert.equal(add.text, 'NEW'); assert.equal(add.n, 3);
});

test('diff: CRLF vs LF does not create spurious changes', () => {
  assert.equal(diffText('a\r\nb', 'a\nb').added, 0);
});

test('diff: huge unrelated inputs fall back safely', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
  const d = diffText(a, b);
  assert.equal(d.removed, 3000); assert.equal(d.added, 3000);
});

test('checkpoints: restore modified file, remove created file', async () => {
  const root = await tmpDir(); const store = new CheckpointStore(path.join(await tmpDir(), 'cp'));
  const f = path.join(root, 'a.txt'), g = path.join(root, 'new.txt');
  await fs.writeFile(f, 'original');
  await store.snapshot(0, f); await fs.writeFile(f, 'changed');
  await store.snapshot(0, g); await fs.writeFile(g, 'created');
  assert.deepEqual((await store.changedFiles(0)).sort(), [f, g].sort());
  await store.restore(0);
  assert.equal(await fs.readFile(f, 'utf8'), 'original');
  await assert.rejects(fs.stat(g));
  assert.deepEqual(await store.turns(), []);
});

test('checkpoints: only the first snapshot per turn counts', async () => {
  const root = await tmpDir(); const store = new CheckpointStore(path.join(await tmpDir(), 'cp'));
  const f = path.join(root, 'a.txt');
  await fs.writeFile(f, 'v0');
  await store.snapshot(0, f); await fs.writeFile(f, 'v1');
  await store.snapshot(0, f); await fs.writeFile(f, 'v2');
  await store.restore(0);
  assert.equal(await fs.readFile(f, 'utf8'), 'v0');
});

test('checkpoints: restoring an early turn undoes later turns too, in the right order', async () => {
  const root = await tmpDir(); const store = new CheckpointStore(path.join(await tmpDir(), 'cp'));
  const f = path.join(root, 'a.txt');
  await fs.writeFile(f, 'v0');
  await store.snapshot(0, f); await fs.writeFile(f, 'v1');
  await store.snapshot(1, f); await fs.writeFile(f, 'v2');
  await store.restore(1);
  assert.equal(await fs.readFile(f, 'utf8'), 'v1');
  assert.deepEqual(await store.turns(), [0]);
  await store.restore(0);
  assert.equal(await fs.readFile(f, 'utf8'), 'v0');
});

test('checkpoints: restore recreates a file deleted after snapshot', async () => {
  const root = await tmpDir(); const store = new CheckpointStore(path.join(await tmpDir(), 'cp'));
  const f = path.join(root, 'sub', 'a.txt');
  await fs.mkdir(path.dirname(f)); await fs.writeFile(f, 'keep');
  await store.snapshot(0, f); await fs.rm(path.dirname(f), { recursive: true });
  await store.restore(0);
  assert.equal(await fs.readFile(f, 'utf8'), 'keep');
});

function agentWithCheckpoints(root: string, store: CheckpointStore, llm: ReturnType<typeof fakeLlm>) {
  return new Agent({
    root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }),
    tools: () => createFsTools(), snapshot: (t, abs) => store.snapshot(t, abs), restore: (t) => store.restore(t),
  });
}
const AUTO = { mode: 'auto', effort: 'medium', model: 'm' } as const;

test('agent: rewind restores files and truncates the conversation', async () => {
  const root = await tmpDir(); const store = new CheckpointStore(path.join(await tmpDir(), 'cp'));
  await fs.writeFile(path.join(root, 'a.txt'), 'start');
  const llm = fakeLlm([
    call('write_file', { path: 'a.txt', content: 'turn0' }, 'x1'), text('t0 done'),
    call('write_file', { path: 'b.txt', content: 'turn1' }, 'x2'), text('t1 done'),
  ]);
  const agent = agentWithCheckpoints(root, store, llm);
  await agent.send('first', AUTO, recordingUi());
  await agent.send('second', AUTO, recordingUi());
  assert.equal(agent.turnCount, 2);

  await agent.rewind(1);
  assert.equal(agent.turnCount, 1);
  assert.equal(agent.history.at(-1)!.content, 't0 done');
  await assert.rejects(fs.stat(path.join(root, 'b.txt')));
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'turn0');

  await agent.rewind(0);
  assert.equal(agent.history.length, 0);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'start');
  await assert.rejects(agent.rewind(5), /No such turn/);
});

test('agent: edit previews reach the UI even when no approval is needed', async () => {
  const root = await tmpDir(); await fs.writeFile(path.join(root, 'f.txt'), 'hello world');
  const llm = fakeLlm([call('edit_file', { path: 'f.txt', old_string: 'world', new_string: 'there' }), text('ok')]);
  const previews: any[] = [];
  const ui = recordingUi(); const orig = ui.toolStart;
  ui.toolStart = (id, n, k, a, d, p) => { previews.push(p); orig(id, n, k, a, d, p); };
  await agentWithCheckpoints(root, new CheckpointStore(path.join(await tmpDir(), 'cp')), llm).send('e', AUTO, ui);
  assert.equal(previews[0].newText, 'hello there');
});

test('agent: a failing edit (no match) never asks approval and never writes', async () => {
  const root = await tmpDir(); await fs.writeFile(path.join(root, 'f.txt'), 'abc');
  const llm = fakeLlm([call('edit_file', { path: 'f.txt', old_string: 'zzz', new_string: 'y' }), text('ok')]);
  const ui = recordingUi(true);
  await agentWithCheckpoints(root, new CheckpointStore(path.join(await tmpDir(), 'cp')), llm).send('e', { ...AUTO, mode: 'ask' }, ui);
  assert.equal(ui.approvals.length, 0);
  assert.ok(ui.events.some((e) => e.includes('not found')));
  assert.equal(await fs.readFile(path.join(root, 'f.txt'), 'utf8'), 'abc');
});
