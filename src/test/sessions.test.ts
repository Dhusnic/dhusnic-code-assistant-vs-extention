import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Session, SessionStore, historyToUi, titleFrom } from '../core/sessions';
import { Agent } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { fakeLlm, recordingUi, text, tmpDir } from './helpers';

const mk = (id: string, updatedAt: number, extra: Partial<Session> = {}): Session => ({
  id, title: `t-${id}`, createdAt: 1, updatedAt, model: 'm', mode: 'ask', effort: 'medium',
  history: [{ role: 'user', content: 'hi' }], turnStarts: [0], ...extra,
});

test('sessions: save/load round-trip', async () => {
  const store = new SessionStore(await tmpDir());
  const s = mk('a1', 10, { history: [{ role: 'user', content: 'x', display: 'shown' }, { role: 'assistant', content: 'y' }] });
  await store.save(s);
  assert.deepEqual(await store.load('a1'), s);
});

test('sessions: list is newest-first and reports turn counts', async () => {
  const store = new SessionStore(await tmpDir());
  await store.save(mk('old', 1)); await store.save(mk('new', 99, { turnStarts: [0, 2, 4] }));
  const l = await store.list();
  assert.deepEqual(l.map((x) => x.id), ['new', 'old']);
  assert.equal(l[0].turns, 3);
});

test('sessions: corrupt and foreign files are skipped, never crash listing', async () => {
  const dir = await tmpDir(); const store = new SessionStore(dir);
  await store.save(mk('good', 5));
  await fs.writeFile(path.join(dir, 'bad.json'), '{not json');
  await fs.writeFile(path.join(dir, 'shape.json'), JSON.stringify({ id: 'shape' }));
  await fs.writeFile(path.join(dir, 'note.txt'), 'x');
  assert.deepEqual((await store.list()).map((s) => s.id), ['good']);
  assert.equal(await store.load('bad'), undefined);
  assert.equal(await store.load('missing'), undefined);
});

test('sessions: path traversal ids are rejected', async () => {
  const store = new SessionStore(await tmpDir());
  await assert.rejects(store.save(mk('../evil', 1)), /Invalid session id/);
  await assert.rejects(store.delete('..\\..\\x'), /Invalid session id/);
  assert.equal(await store.load('../../etc/passwd'), undefined);
});

test('sessions: delete removes and is idempotent', async () => {
  const store = new SessionStore(await tmpDir());
  await store.save(mk('d1', 1));
  await store.delete('d1'); await store.delete('d1');
  assert.deepEqual(await store.list(), []);
});

test('sessions: save leaves no temp files behind', async () => {
  const dir = await tmpDir(); const store = new SessionStore(dir);
  await store.save(mk('s', 1)); await store.save(mk('s', 2));
  assert.deepEqual(await fs.readdir(dir), ['s.json']);
});

test('titleFrom: collapses whitespace, truncates, falls back', () => {
  assert.equal(titleFrom('  hello\n\n  world '), 'hello world');
  assert.equal(titleFrom('x'.repeat(100)).length, 60);
  assert.ok(titleFrom('x'.repeat(100)).endsWith('…'));
  assert.equal(titleFrom('   '), 'New chat');
});

test('historyToUi: rebuilds user/assistant/tool items with turn numbers', () => {
  const history: any[] = [
    { role: 'user', content: 'expanded text', display: 'original' },
    { role: 'assistant', content: 'looking', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '1\tcode' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'run_command', arguments: '{bad' } }] },
    { role: 'tool', tool_call_id: 'c2', content: 'DENIED by user.' },
  ];
  const items = historyToUi(history, [0, 4], (n, a) => `${n}:${a.path ?? ''}`);
  assert.deepEqual(items.map((i) => i.type), ['user', 'assistant', 'tool', 'assistant', 'user', 'tool']);
  assert.deepEqual(items[0], { type: 'user', text: 'original', turn: 0 });
  assert.equal((items[4] as any).turn, 1);
  const t1 = items[2] as any, t2 = items[5] as any;
  assert.equal(t1.detail, 'read_file:a.ts'); assert.equal(t1.ok, true);
  assert.equal(t2.ok, false, 'denied tool shown as failed');
});

test('agent: export/restore keeps a conversation resumable', async () => {
  const root = await tmpDir();
  const llm = fakeLlm([text('first answer'), text('second answer')]);
  const deps = { root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => createFsTools() };
  const a = new Agent(deps);
  await a.send('one', { mode: 'ask', effort: 'low', model: 'm' }, recordingUi());
  const snap = a.exportState();

  const b = new Agent(deps);
  b.loadState(JSON.parse(JSON.stringify(snap)));
  assert.equal(b.turnCount, 1);
  await b.send('two', { mode: 'ask', effort: 'low', model: 'm' }, recordingUi());
  const sent = llm.calls[1].map((m) => m.content);
  assert.ok(sent.includes('first answer') && sent.includes('one') && sent.includes('two'), 'prior context reaches the model');
  assert.equal(b.turnCount, 2);
});

test('agent: loadState rejects nothing silently — repairs dangling tool calls', () => {
  const a = new Agent({ root: '.', llm: fakeLlm([text('x')]).fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => [] });
  a.loadState({
    history: [{ role: 'user', content: 'q' }, { role: 'assistant', content: null, tool_calls: [{ id: 'z', type: 'function', function: { name: 'x', arguments: '{}' } }] }],
    turnStarts: [0],
  });
  assert.equal(a.history.at(-1)!.role, 'tool');
  assert.equal(a.history.at(-1)!.tool_call_id, 'z');
});
