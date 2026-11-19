import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AgentRecord, SCHEMA_VERSION, SessionMeta, SessionStore2, renameWithRetry, repairTurnStarts, summaryOf } from '../core/store';
import { SUMMARY_PREFIX } from '../core/sessions';
import { tmpDir } from './helpers';

const agent = (sid: string, aid: string, extra: Partial<AgentRecord> = {}): AgentRecord => ({
  v: SCHEMA_VERSION, id: aid, sessionId: sid, name: `Agent ${aid}`, createdAt: 1, updatedAt: 2, status: 'idle',
  model: 'm', mode: 'ask', effort: 'medium',
  history: [{ role: 'user', content: `hello from ${aid}` }, { role: 'assistant', content: 'hi' }], turnStarts: [0], ...extra,
});
const meta = (sid: string, agents: AgentRecord[], extra: Partial<SessionMeta> = {}): SessionMeta => ({
  v: SCHEMA_VERSION, id: sid, title: `title ${sid}`, createdAt: 1, updatedAt: 5, agents: agents.map((a) => summaryOf(a)), ...extra,
});
async function save(store: SessionStore2, sid: string, agents: AgentRecord[], m?: Partial<SessionMeta>) {
  for (const a of agents) { await store.saveAgent(a); }
  await store.saveMeta(meta(sid, agents, m));
}

test('store: a session with several agents round-trips exactly', async () => {
  const store = new SessionStore2(await tmpDir());
  const a1 = agent('s1', 'a1', { history: [{ role: 'user', content: 'q', display: 'shown' }, { role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } }] }, { role: 'tool', tool_call_id: 't', content: 'r' }] });
  const a2 = agent('s1', 'a2', { name: 'Reviewer', mode: 'plan' });
  await save(store, 's1', [a1, a2]);
  const back = (await store.loadSession('s1'))!;
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.agents.map((a) => a.id), ['a1', 'a2']);
  assert.deepEqual(back.agents[0].history, a1.history);
  assert.equal(back.agents[1].name, 'Reviewer');
  assert.equal(back.agents[1].mode, 'plan');
  assert.equal(back.meta.title, 'title s1');
});

test('store: list reads only metadata, sorts newest first, totals turns and agents', async () => {
  const store = new SessionStore2(await tmpDir());
  await save(store, 'old', [agent('old', 'a1')], { updatedAt: 1 });
  await save(store, 'new', [agent('new', 'a1', { turnStarts: [0] }), agent('new', 'a2', { history: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }, { role: 'user', content: 'z' }], turnStarts: [0, 2] })], { updatedAt: 9 });
  const l = await store.list();
  assert.deepEqual(l.map((s) => s.id), ['new', 'old']);
  assert.equal(l[0].agents, 2);
  assert.equal(l[0].turns, 3);
  assert.equal(l[0].interrupted, false);
});

test('store: agents saved while running come back as "interrupted"', async () => {
  const store = new SessionStore2(await tmpDir());
  const a = agent('s', 'a1', { status: 'running' });
  await save(store, 's', [a]);
  assert.equal((await store.loadSession('s'))!.agents[0].status, 'interrupted');
  assert.equal((await store.list())[0].interrupted, true);
});

test('store: concurrent saves to the same file never corrupt it and the last write wins', async () => {
  const dir = await tmpDir();
  const store = new SessionStore2(dir);
  const writes = Array.from({ length: 40 }, (_, i) => store.saveAgent(agent('s', 'a1', { name: `v${i}`, history: [{ role: 'user', content: 'x'.repeat(5000 + i) }] })));
  await Promise.all(writes);
  await store.saveMeta(meta('s', [agent('s', 'a1')]));
  const back = (await store.loadSession('s'))!;
  assert.equal(back.agents[0].name, 'v39');
  const files = await fs.readdir(path.join(dir, 's', 'agents'));
  assert.ok(!files.some((f) => f.endsWith('.tmp')), 'no temp files left behind');
});

test('store: concurrent saves of different agents in one session all land', async () => {
  const store = new SessionStore2(await tmpDir());
  const agents = Array.from({ length: 8 }, (_, i) => agent('s', `a${i + 1}`));
  await Promise.all([...agents.map((a) => store.saveAgent(a)), store.saveMeta(meta('s', agents))]);
  assert.equal((await store.loadSession('s'))!.agents.length, 8);
});

test('store: a damaged agent file is recovered from its backup', async () => {
  const dir = await tmpDir();
  const store = new SessionStore2(dir);
  await save(store, 's', [agent('s', 'a1', { name: 'first' })]);
  await store.saveAgent(agent('s', 'a1', { name: 'second' }));
  await fs.writeFile(path.join(dir, 's', 'agents', 'a1.json'), '{"truncated": ');
  const back = (await store.loadSession('s'))!;
  assert.equal(back.agents[0].name, 'first', 'previous good version');
  assert.match(back.warnings.join(), /restored from backup/);
});

test('store: missing session.json is rebuilt from the agent files', async () => {
  const dir = await tmpDir();
  const store = new SessionStore2(dir);
  await save(store, 's', [agent('s', 'a1'), agent('s', 'a2')]);
  await fs.rm(path.join(dir, 's', 'session.json'));
  await fs.rm(path.join(dir, 's', 'session.json.bak'), { force: true });
  const back = (await store.loadSession('s'))!;
  assert.deepEqual(back.agents.map((a) => a.id), ['a1', 'a2']);
  assert.match(back.warnings.join(), /rebuilt/);
  assert.equal((await store.list()).length, 1, 'still listed in History');
});

test('store: an agent file that is not listed in session.json is still loaded', async () => {
  const store = new SessionStore2(await tmpDir());
  await save(store, 's', [agent('s', 'a1')]);
  await store.saveAgent(agent('s', 'a2'));
  assert.deepEqual((await store.loadSession('s'))!.agents.map((a) => a.id), ['a1', 'a2']);
});

test('store: a crash between writing the temp file and renaming it loses nothing', async () => {
  const dir = await tmpDir();
  let fail = false;
  const store = new SessionStore2(dir, async (a, b) => { if (fail) { throw Object.assign(new Error('crash'), { code: 'EIO' }); } await fs.rename(a, b); });
  await save(store, 's', [agent('s', 'a1', { name: 'good' })]);
  fail = true;
  await assert.rejects(store.saveAgent(agent('s', 'a1', { name: 'never-written' })), /crash/);
  fail = false;
  assert.equal((await store.loadSession('s'))!.agents[0].name, 'good');
  assert.ok(!(await fs.readdir(path.join(dir, 's', 'agents'))).some((f) => f.endsWith('.tmp')));
});

test('renameWithRetry: retries Windows lock errors, not real failures', async () => {
  let n = 0;
  await renameWithRetry('a', 'b', async () => { if (++n < 3) { throw Object.assign(new Error('locked'), { code: 'EPERM' }); } });
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(renameWithRetry('a', 'b', async () => { n++; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }), /gone/);
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(renameWithRetry('a', 'b', async () => { n++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }, 3), /busy/);
  assert.equal(n, 3);
});

test('store: legacy v1 chats are migrated, keep their history, and the original is preserved', async () => {
  const dir = await tmpDir();
  const legacy = { id: 'old1', title: 'Legacy chat', createdAt: 10, updatedAt: 20, model: 'qm', mode: 'auto', effort: 'high', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }], turnStarts: [0] };
  await fs.writeFile(path.join(dir, 'old1.json'), JSON.stringify(legacy));
  await fs.writeFile(path.join(dir, 'junk.json'), '{bad');
  const store = new SessionStore2(dir);
  const l = await store.list();
  assert.deepEqual(l.map((s) => [s.id, s.title, s.agents, s.turns]), [['old1', 'Legacy chat', 1, 1]]);
  const s = (await store.loadSession('old1'))!;
  assert.deepEqual(s.agents[0].history, legacy.history);
  assert.equal(s.agents[0].mode, 'auto');
  assert.ok((await fs.readdir(dir)).includes('old1.json.migrated'));
  assert.equal(await store.migrateLegacy(), 0, 'idempotent');
});

test('store: invalid ids are rejected (no path traversal)', async () => {
  const store = new SessionStore2(await tmpDir());
  await assert.rejects(store.saveAgent(agent('../evil', 'a1')), /Invalid session id/);
  await assert.rejects(store.saveAgent(agent('s', '..\\x')), /Invalid agent id/);
  await assert.rejects(store.loadSession('../../etc'), /Invalid session id/);
});

test('store: delete session and delete agent', async () => {
  const store = new SessionStore2(await tmpDir());
  await save(store, 's', [agent('s', 'a1'), agent('s', 'a2')]);
  await store.deleteAgent('s', 'a2');
  await store.saveMeta(meta('s', [agent('s', 'a1')]));
  assert.deepEqual((await store.loadSession('s'))!.agents.map((a) => a.id), ['a1']);
  await store.deleteSession('s');
  assert.equal(await store.loadSession('s'), undefined);
  assert.deepEqual(await store.list(), []);
});

test('repairTurnStarts: keeps valid markers, rebuilds broken ones, skips summary messages', () => {
  const h: any[] = [{ role: 'user', content: `${SUMMARY_PREFIX}\nx` }, { role: 'assistant', content: 'ack' }, { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
  assert.deepEqual(repairTurnStarts(h, [2, 2]), { turnStarts: [2, 2], repaired: false });
  assert.deepEqual(repairTurnStarts(h, [1]), { turnStarts: [2], repaired: true });
  assert.deepEqual(repairTurnStarts(h, [2, 9]), { turnStarts: [2], repaired: true });
  assert.deepEqual(repairTurnStarts(h, [3, 2]), { turnStarts: [2], repaired: true });
});

test('verify: reports ok, repairs damaged files, flags unrecoverable sessions', async () => {
  const dir = await tmpDir();
  const store = new SessionStore2(dir);
  await save(store, 'good', [agent('good', 'a1')]);
  await save(store, 'fixable', [agent('fixable', 'a1', { name: 'v1' })]);
  await store.saveAgent(agent('fixable', 'a1', { name: 'v2' }));
  await fs.writeFile(path.join(dir, 'fixable', 'agents', 'a1.json'), 'garbage');
  await store.saveAgent(agent('fixable', 'a9'));
  await save(store, 'dead', [agent('dead', 'a1')]);
  for (const f of ['a1.json', 'a1.json.bak']) { await fs.writeFile(path.join(dir, 'dead', 'agents', f), 'garbage'); }

  const before = Object.fromEntries((await store.verify(false)).map((r) => [r.id, r]));
  assert.equal(before.good.status, 'ok');
  assert.equal(before.fixable.status, 'corrupt', 'not repaired without permission');
  assert.ok(before.fixable.issues.some((i) => /backup is good/.test(i)));
  assert.ok(before.fixable.issues.some((i) => /a9 exists but is not listed/.test(i)));
  assert.equal(before.dead.status, 'corrupt');

  const fixed = Object.fromEntries((await store.verify(true)).map((r) => [r.id, r]));
  assert.equal(fixed.fixable.status, 'repaired');
  const again = Object.fromEntries((await store.verify(false)).map((r) => [r.id, r]));
  assert.equal(again.fixable.status, 'ok', 'repair is durable');
  assert.deepEqual((await store.loadSession('fixable'))!.agents.map((a) => [a.id, a.name]), [['a1', 'v1'], ['a9', 'Agent a9']]);
  assert.equal(again.dead.status, 'corrupt');
});

test('selfTest: write → read → compare → delete succeeds and leaves nothing behind', async () => {
  const dir = await tmpDir();
  const store = new SessionStore2(dir);
  const r = await store.selfTest();
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(await store.list(), []);
});

test('selfTest: reports a broken disk instead of throwing', async () => {
  const store = new SessionStore2(await tmpDir(), async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  const r = await store.selfTest();
  assert.equal(r.ok, false);
  assert.match(r.detail, /disk full/);
});
