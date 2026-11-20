import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Agent } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { SessionManager } from '../core/runtime';
import { searchSessions } from '../core/sessionSearch';
import { AgentRecord, SCHEMA_VERSION, SessionMeta, SessionStore2, summaryOf } from '../core/store';
import {
  EMPTY_WORKSPACE, SessionScope, absolutePathsIn, checkpointPaths, classifyEvidence, isInside, normalizeRoot, sameWorkspace, workspaceKey,
} from '../core/workspaceScope';
import { fakeLlm, text, tmpDir } from './helpers';

const agent = (sid: string, toolArgs: object[] = [], extra: Partial<AgentRecord> = {}): AgentRecord => ({
  v: SCHEMA_VERSION, id: 'a1', sessionId: sid, name: 'Main', createdAt: 1, updatedAt: 2, status: 'idle', model: 'm', mode: 'ask', effort: 'medium',
  history: [
    { role: 'user', content: `hello ${sid}` },
    ...toolArgs.map((a, i) => ({ role: 'assistant' as const, content: null, tool_calls: [{ id: `t${i}`, type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify(a) } }] })),
    { role: 'assistant', content: 'done' },
  ],
  turnStarts: [0], ...extra,
});
async function save(store: SessionStore2, sid: string, opts: { workspace?: string; toolArgs?: object[]; updatedAt?: number; status?: AgentRecord['status'] } = {}): Promise<void> {
  const a = agent(sid, opts.toolArgs, opts.status ? { status: opts.status } : {});
  await store.saveAgent(a);
  const meta: SessionMeta = { v: SCHEMA_VERSION, id: sid, title: `title ${sid}`, createdAt: 1, updatedAt: opts.updatedAt ?? 5, agents: [summaryOf(a)] };
  if (opts.workspace !== undefined) { meta.workspace = opts.workspace; }
  await store.saveMeta(meta);
}

/* ------------------------------------------------------------------ keys */

test('workspace key: normalised, case-insensitive on Windows, trailing separators ignored', () => {
  assert.equal(workspaceKey({ folders: ['D:\\Repos\\App\\'] }, 'win32'), 'd:\\repos\\app');
  assert.equal(workspaceKey({ folders: ['d:/repos/app'] }, 'win32'), 'd:\\repos\\app');
  assert.ok(sameWorkspace('D:\\Repos\\App', 'd:/repos/app/', 'win32'));
  assert.equal(workspaceKey({ folders: ['/home/u/App/'] }, 'linux'), '/home/u/App');
  assert.ok(!sameWorkspace('/home/u/App', '/home/u/app', 'linux'), 'case matters on Linux');
  assert.equal(normalizeRoot('C:\\', 'win32'), 'c:\\', 'a drive root keeps its separator');
  assert.equal(normalizeRoot('/', 'linux'), '/');
});

test('workspace key: multi-root uses the workspace file, else the first folder; an empty window has its own key', () => {
  assert.equal(workspaceKey({ workspaceFile: 'C:\\w\\Team.code-workspace', folders: ['C:\\a', 'C:\\b'] }, 'win32'), 'c:\\w\\team.code-workspace');
  assert.equal(workspaceKey({ folders: ['/a', '/b'] }, 'linux'), '/a');
  assert.equal(workspaceKey({ folders: [] }, 'linux'), EMPTY_WORKSPACE);
  assert.equal(workspaceKey({}, 'win32'), EMPTY_WORKSPACE);
  assert.ok(!sameWorkspace(EMPTY_WORKSPACE, '/a', 'linux'));
  assert.equal(normalizeRoot('vscode-remote://ssh-remote+box/home/u/app/', 'win32'), 'vscode-remote://ssh-remote+box/home/u/app', 'remote URIs are kept as URIs');
});

test('isInside: folder boundaries, not string prefixes', () => {
  assert.ok(isInside('D:\\Repo\\src\\a.ts', 'd:\\repo', 'win32'));
  assert.ok(isInside('d:\\repo', 'D:\\Repo\\', 'win32'));
  assert.ok(!isInside('d:\\repo2\\a.ts', 'd:\\repo', 'win32'));
  assert.ok(isInside('/r/src/x', '/r', 'linux'));
  assert.ok(!isInside('/rx/src', '/r', 'linux'));
});

/* ------------------------------------------------------------------ legacy inference */

test('evidence: absolute paths are taken from tool-call arguments (nested too), relative ones ignored', () => {
  const a = agent('s', [{ path: 'src/a.ts' }, { path: 'D:\\Repo\\b.ts' }, { edits: [{ file: 'D:/Repo/c.ts' }] }, { command: 'echo hi\nD:\\x' }]);
  assert.deepEqual(absolutePathsIn([a], 'win32'), ['D:\\Repo\\b.ts', 'D:/Repo/c.ts']);
  assert.deepEqual(absolutePathsIn([agent('s', [{ path: '/srv/app/x' }, { path: 'rel' }])], 'linux'), ['/srv/app/x']);
  const broken = agent('s');
  broken.history.push({ role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'n', arguments: '{not json' } }] });
  assert.deepEqual(absolutePathsIn([broken], 'linux'), []);
});

test('classification: majority inside the folders = mine, mostly elsewhere = other, no evidence = unassigned', () => {
  const ctx = { roots: ['D:\\A'], ignore: ['C:\\Users\\u\\AppData\\ext'], platform: 'win32' as const };
  assert.equal(classifyEvidence(['d:\\a\\x.ts', 'd:\\a\\y.ts', 'd:\\b\\z.ts'], ctx), 'mine');
  assert.equal(classifyEvidence(['d:\\b\\x.ts', 'd:\\b\\y.ts', 'd:\\a\\z.ts'], ctx), 'other', 'one reference into A does not make B\'s session A\'s');
  assert.equal(classifyEvidence(['d:\\b\\x.ts'], ctx), 'other');
  assert.equal(classifyEvidence([], ctx), 'unassigned');
  assert.equal(classifyEvidence(['C:\\Users\\u\\AppData\\ext\\worktrees\\s\\a2\\f.ts'], ctx), 'unassigned', 'the extension\'s own storage is not evidence');
  assert.equal(classifyEvidence(['d:\\a\\x.ts'], { roots: [], platform: 'win32' }), 'other', 'an empty window never adopts a session that touched a folder');
});

test('checkpoint manifests provide evidence of the files a session edited', async () => {
  const dir = await tmpDir('ws-cp-');
  await fs.mkdir(path.join(dir, 's1', 'a1', 'turn-0'), { recursive: true });
  await fs.writeFile(path.join(dir, 's1', 'a1', 'turn-0', 'manifest.json'), JSON.stringify({ entries: [{ abs: '/repo/a/x.ts', existed: true }] }));
  await fs.mkdir(path.join(dir, 's1', 'a1', 'turn-1'), { recursive: true });
  await fs.writeFile(path.join(dir, 's1', 'a1', 'turn-1', 'manifest.json'), '{broken');
  assert.deepEqual(await checkpointPaths(dir, 's1'), ['/repo/a/x.ts']);
  assert.deepEqual(await checkpointPaths(dir, 'missing'), []);
  assert.deepEqual(await checkpointPaths(dir, '../etc'), []);
});

/* ------------------------------------------------------------------ scope over a real store */

test('scope: each window lists only its own workspace\'s sessions; legacy ones are attributed or flagged', async () => {
  const store = new SessionStore2(await tmpDir('ws-store-'));
  const cps = await tmpDir('ws-cps-');
  const A = '/work/repo-a', B = '/work/repo-b', C = '/work/repo-c';
  await save(store, 'a-new', { workspace: A, status: 'running' });   // running in A's window right now
  await save(store, 'b-new', { workspace: B });
  await save(store, 'empty', { workspace: EMPTY_WORKSPACE });
  await save(store, 'a-legacy', { toolArgs: [{ path: '/work/repo-a/src/x.ts' }] });
  await save(store, 'b-legacy', { toolArgs: [{ path: 'rel.ts' }] });
  await fs.mkdir(path.join(cps, 'b-legacy', 'a1', 'turn-0'), { recursive: true });
  await fs.writeFile(path.join(cps, 'b-legacy', 'a1', 'turn-0', 'manifest.json'), JSON.stringify({ entries: [{ abs: '/work/repo-b/y.ts' }] }));
  await save(store, 'chat-legacy');

  const scopeFor = (key: string, roots: string[]) => new SessionScope(store, () => ({ key, roots, platform: 'linux' }), cps);
  const ids = async (scope: SessionScope) => (await scope.filter(await store.list())).map((s) => `${s.id}${s.unassigned ? '?' : ''}`).sort();

  const inC = scopeFor(C, [C]);
  assert.deepEqual(await ids(inC), ['chat-legacy?'], 'a third repo sees none of A\'s or B\'s sessions, running or not');
  assert.equal(await inC.allows('a-new'), false, 'A\'s running session cannot be opened from C');
  assert.equal(await inC.allows('a-legacy'), false);

  const inA = scopeFor(A, [A]);
  assert.deepEqual(await ids(inA), ['a-legacy', 'a-new', 'chat-legacy?']);
  assert.equal((await store.list()).find((s) => s.id === 'a-legacy')!.workspace, A, 'an attributed legacy session is claimed once, on disk');

  const inB = scopeFor(B, [B]);
  assert.deepEqual(await ids(inB), ['b-legacy', 'b-new', 'chat-legacy?'], 'checkpoint evidence attributes b-legacy to B');

  const inEmpty = scopeFor(EMPTY_WORKSPACE, []);
  assert.deepEqual(await ids(inEmpty), ['chat-legacy?', 'empty'], 'empty windows keep their own sessions');

  // Opening the unattributed chat in A claims it: it then disappears from every other window.
  await inA.claim('chat-legacy');
  assert.deepEqual(await ids(scopeFor(B, [B])), ['b-legacy', 'b-new']);
  assert.deepEqual(await ids(scopeFor(A, [A])), ['a-legacy', 'a-new', 'chat-legacy']);
  await inB.claim('a-new');
  assert.equal((await store.list()).find((s) => s.id === 'a-new')!.workspace, A, 'claim never moves a session that already has a workspace');
});

test('scope: Windows keys match whatever the case or separators of the folder path', async () => {
  const store = new SessionStore2(await tmpDir('ws-win-'));
  await save(store, 's1', { workspace: 'd:\\product\\app' });
  const scope = new SessionScope(store, () => ({ key: workspaceKey({ folders: ['D:/Product/App/'] }, 'win32'), roots: ['D:/Product/App/'], platform: 'win32' }));
  assert.equal(await scope.ownership('s1'), 'mine');
  assert.equal(await scope.ownership('s1', 'D:\\PRODUCT\\APP'), 'mine');
});

test('search: the include filter keeps other workspaces\' sessions out of the results', async () => {
  const store = new SessionStore2(await tmpDir('ws-search-'));
  await save(store, 'mine', { workspace: '/a' });
  await save(store, 'theirs', { workspace: '/b' });
  const scope = new SessionScope(store, () => ({ key: '/a', roots: ['/a'], platform: 'linux' }));
  assert.deepEqual((await searchSessions(store.dir, 'hello')).map((h) => h.sessionId).sort(), ['mine', 'theirs']);
  const include = async (sid: string) => (await scope.ownership(sid)) !== 'other';
  assert.deepEqual((await searchSessions(store.dir, 'hello', { include })).map((h) => h.sessionId), ['mine']);
  assert.deepEqual((await searchSessions(store.dir, 'hello', { include: () => { throw new Error('x'); } })).map((h) => h.sessionId), [], 'a failing filter hides');
});

/* ------------------------------------------------------------------ the manager records the workspace */

test('manager: new sessions are saved with the window\'s workspace; reopened legacy ones are claimed on their next save', async () => {
  const store = new SessionStore2(await tmpDir('ws-mgr-'));
  const root = await tmpDir('ws-root-');
  const { fn } = fakeLlm([text('ok')]);
  let n = 0;
  const mgr = new SessionManager({
    store,
    createAgent: () => new Agent({ root, llm: fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => createFsTools() }),
    defaults: () => ({ mode: 'ask', effort: 'medium', model: 'm' }),
    newSessionId: () => `s${++n}`, saveThrottleMs: 5,
    workspace: () => '/work/a',
  });
  const s = mgr.newSession();
  await mgr.send(s.id, 'a1', 'hi');
  await mgr.shutdown();
  assert.equal((await store.list()).find((x) => x.id === s.id)!.workspace, '/work/a');

  await save(store, 'old');
  const re = (await mgr.open('old'))!;
  assert.equal(re.workspace, '/work/a');
  await mgr.send('old', re.main().id, 'again');
  await mgr.shutdown();
  assert.equal((await store.list()).find((x) => x.id === 'old')!.workspace, '/work/a');

  await save(store, 'foreign', { workspace: '/work/b' });
  assert.equal((await mgr.open('foreign'))!.workspace, '/work/b', 'opening never rewrites a recorded workspace');
});
