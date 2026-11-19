import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Agent, AgentUi, buildSystemPrompt, queuedMessageText } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { ChatMessage, LlmFn, StreamResult, ToolCall } from '../core/llm';
import { Tool, fnSpec } from '../core/tool';
import { SessionManager, UiEvent } from '../core/runtime';
import { SessionStore2 } from '../core/store';
import { Serializer, isReadOnlyCommand, planBatches } from '../core/scheduler';
import { environmentSection, shellGuide } from '../core/prompts';
import { recordingUi, tmpDir } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (content: string): StreamResult => ({ content, toolCalls: [] });
const tc = (name: string, args: object, id: string): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const calls = (...c: ToolCall[]): StreamResult => ({ content: '', toolCalls: c });
const OPTS = { mode: 'auto' as const, effort: 'medium' as const, model: 'm' };

/* ------------------------------------------------------------------ scheduler */

test('planBatches: consecutive safe calls group, unsafe calls are barriers, order is kept', () => {
  const safe = (c: string) => c.startsWith('r');
  assert.deepEqual(planBatches(['r1', 'r2', 'e1', 'r3', 'r4', 'r5', 'e2', 'e3', 'r6'], safe),
    [['r1', 'r2'], ['e1'], ['r3', 'r4', 'r5'], ['e2'], ['e3'], ['r6']]);
  assert.deepEqual(planBatches(['r1', 'r2', 'r3', 'r4', 'r5'], safe, 2), [['r1', 'r2'], ['r3', 'r4'], ['r5']]);
  assert.deepEqual(planBatches([], safe), []);
});

test('Serializer: runs one job at a time, in order, and survives a failing job', async () => {
  const s = new Serializer();
  const log: string[] = [];
  let active = 0, peak = 0;
  const job = (n: string, ms: number, fail = false) => s.run(async () => {
    active++; peak = Math.max(peak, active); log.push(`start ${n}`);
    await sleep(ms); active--; log.push(`end ${n}`);
    if (fail) { throw new Error(n); }
    return n;
  });
  const r = await Promise.allSettled([job('a', 30), job('b', 5, true), job('c', 1)]);
  assert.equal(peak, 1);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.deepEqual(r.map((x) => x.status), ['fulfilled', 'rejected', 'fulfilled']);
});

test('isReadOnlyCommand: read-only commands are recognised', () => {
  for (const c of [
    'git status', 'git status --short', 'git log -n 20 --oneline', 'git diff HEAD~1 -- src', 'git branch', 'git branch -a', 'git branch --show-current',
    'git remote -v', 'git stash list', 'git config --get user.name', 'git show HEAD:src/a.ts',
    'ls -la', 'Get-ChildItem -Recurse -Filter *.py | Select-Object -First 20', 'cat package.json', 'Get-Content a.log -Tail 50',
    'rg -n "TODO" src', 'grep -rn foo . | head -20', 'node --version', 'npm ls --depth=0', 'pip show requests',
    'curl.exe -sS --max-time 20 "http://10.0.0.5:8139/health"', 'curl -s -k https://172.16.1.1/api/v1/items | jq ".[0]"',
    'curl -X GET http://x/api', 'Invoke-RestMethod http://x/api | ConvertTo-Json -Depth 4', 'git log --oneline 2>&1',
    'Get-Content a.json | ConvertFrom-Json | Select-Object name', 'find . -name "*.ts"', 'hostname', 'whoami',
  ]) { assert.equal(isReadOnlyCommand(c), true, c); }
});

test('isReadOnlyCommand: anything that may change state is not', () => {
  for (const c of [
    '', 'git commit -m x', 'git push', 'git checkout main', 'git branch feature-x', 'git branch -D old', 'git stash', 'git stash pop', 'git tag v1',
    'git config user.name bob', 'git -C other status', 'git remote add o url', 'npm install', 'npm test', 'python app.py', 'rm -rf build',
    'Remove-Item x', 'echo hi > out.txt', 'cat a >> b', 'git status; rm -rf /', 'git status && npm i', 'ls | xargs rm', 'ls | ForEach-Object { Remove-Item $_ }',
    'Get-Content $(Remove-Item a)', 'ls `rm a`', 'curl -X POST http://x/api', 'curl -d "a=1" http://x', 'curl --data-binary @f http://x',
    'curl -o out.bin http://x', 'curl -sSo out.bin http://x', 'curl -sSLO http://x/file', 'Invoke-WebRequest http://x -OutFile f', 'Invoke-RestMethod -Method Post http://x',
    'wget http://x/file', 'find . -name "*.tmp" -delete', 'find . -exec rm {} ;', 'sort a.txt -o a.txt', 'hostname evil', 'date -s 2020-01-01',
    'psql -c "DROP TABLE x"', 'echo "unterminated', 'sed -i s/a/b/ f',
  ]) { assert.equal(isReadOnlyCommand(c), false, c); }
});

/* ------------------------------------------------------------------ agent: parallel execution */

function slowTool(name: string, kind: 'read' | 'edit' | 'exec', ms: number, track: { active: number; peak: number; order: string[] }): Tool {
  return {
    kind, spec: fnSpec(name, name, { n: { type: 'string' } }, ['n']), describe: (a) => `${name} ${a.n}`,
    async run(a) {
      track.active++; track.peak = Math.max(track.peak, track.active); track.order.push(`start ${a.n}`);
      await sleep(ms);
      track.active--; track.order.push(`end ${a.n}`);
      return `${name}:${a.n}`;
    },
  };
}

function scripted(steps: StreamResult[]): { fn: LlmFn; seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  let i = 0;
  return { seen, fn: async (_c, msgs, _t, onToken) => { seen.push(msgs.map((m) => ({ ...m }))); const r = steps[Math.min(i++, steps.length - 1)]; if (r.content) { onToken(r.content); } return r; } };
}

function agentWith(root: string, llm: LlmFn, tools: Tool[], extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}): Agent {
  return new Agent({ root, llm, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => tools, ...extra });
}

test('agent: independent reads from one response run in parallel; results keep call order', async () => {
  const t = { active: 0, peak: 0, order: [] as string[] };
  const look = slowTool('look', 'read', 60, t);
  const llm = scripted([calls(tc('look', { n: '1' }, 'a'), tc('look', { n: '2' }, 'b'), tc('look', { n: '3' }, 'c')), text('done')]);
  const agent = agentWith(await tmpDir(), llm.fn, [look]);
  const t0 = Date.now();
  await agent.send('go', OPTS, recordingUi());
  assert.equal(t.peak, 3, 'all three reads were active at once');
  assert.ok(Date.now() - t0 < 150, `took ${Date.now() - t0}ms; sequential would be ≥180ms`);
  assert.deepEqual(agent.history.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content]), [['a', 'look:1'], ['b', 'look:2'], ['c', 'look:3']]);
});

test('agent: an edit between reads is a barrier, so "read, edit, then read" keeps its order', async () => {
  const t = { active: 0, peak: 0, order: [] as string[] };
  const look = slowTool('look', 'read', 30, t);
  const change = slowTool('change', 'edit', 30, t);
  const llm = scripted([calls(tc('look', { n: 'r1' }, 'a'), tc('look', { n: 'r2' }, 'b'), tc('change', { n: 'e' }, 'c'), tc('look', { n: 'r3' }, 'd')), text('ok')]);
  await agentWith(await tmpDir(), llm.fn, [look, change]).send('go', OPTS, recordingUi());
  const pos = (s: string) => t.order.indexOf(s);
  assert.ok(pos('start r2') < pos('end r1'), 'r1 and r2 overlapped');
  assert.ok(pos('end r1') < pos('start e') && pos('end r2') < pos('start e'), 'the edit waited for both reads');
  assert.ok(pos('end e') < pos('start r3'), 'the read after the edit saw the edited state');
});

test('agent: commands run in parallel only when read-only; others stay sequential', async () => {
  const t = { active: 0, peak: 0, order: [] as string[] };
  const cmd: Tool = { ...slowTool('run_command', 'exec', 40, t), spec: fnSpec('run_command', 'x', { command: { type: 'string' } }, ['command']), describe: (a) => a.command, async run(a) { t.active++; t.peak = Math.max(t.peak, t.active); t.order.push(`start ${a.command}`); await sleep(40); t.active--; t.order.push(`end ${a.command}`); return 'ok'; } };
  const ro = scripted([calls(tc('run_command', { command: 'git status' }, 'a'), tc('run_command', { command: 'git log -n 5' }, 'b')), text('ok')]);
  await agentWith(await tmpDir(), ro.fn, [cmd]).send('go', OPTS, recordingUi());
  assert.equal(t.peak, 2, 'git status and git log ran together');
  t.peak = 0; t.order = [];
  const rw = scripted([calls(tc('run_command', { command: 'npm run build' }, 'a'), tc('run_command', { command: 'npm test' }, 'b')), text('ok')]);
  await agentWith(await tmpDir(), rw.fn, [cmd]).send('go', OPTS, recordingUi());
  assert.equal(t.peak, 1, 'build then test ran one after another');
  assert.deepEqual(t.order, ['start npm run build', 'end npm run build', 'start npm test', 'end npm test']);
});

test('agent: parallel calls that need approval ask the user one at a time', async () => {
  const t = { active: 0, peak: 0, order: [] as string[] };
  const look = slowTool('look', 'read', 10, t);
  const llm = scripted([calls(tc('look', { n: '1' }, 'a'), tc('look', { n: '2' }, 'b'), tc('look', { n: '3' }, 'c')), text('ok')]);
  let open = 0, peakOpen = 0;
  const ui: AgentUi = { ...recordingUi(), approve: async () => { open++; peakOpen = Math.max(peakOpen, open); await sleep(20); open--; return true; } };
  const agent = agentWith(await tmpDir(), llm.fn, [look], { guard: { decide: () => ({ effect: 'ask' }) } });
  await agent.send('go', OPTS, ui);
  assert.equal(peakOpen, 1, 'never two approval prompts at once');
  assert.equal(agent.history.filter((m) => m.role === 'tool' && /^look:/.test(m.content ?? '')).length, 3);
});

test('agent: cancelling during a parallel batch leaves a valid history', async () => {
  const t = { active: 0, peak: 0, order: [] as string[] };
  const look: Tool = { ...slowTool('look', 'read', 0, t), async run(_a, ctx) { await new Promise((_r, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('Cancelled')))); return ''; } };
  const llm = scripted([calls(tc('look', { n: '1' }, 'a'), tc('look', { n: '2' }, 'b')), text('never')]);
  const agent = agentWith(await tmpDir(), llm.fn, [look]);
  const run = agent.send('go', OPTS, recordingUi());
  await sleep(30);
  agent.cancel();
  await run;
  const ids = agent.history.filter((m) => m.role === 'tool').map((m) => m.tool_call_id).sort();
  assert.deepEqual(ids, ['a', 'b'], 'every tool call has exactly one reply');
});

/* ------------------------------------------------------------------ agent: queued user messages */

test('agent: a queued message is added after the tool results and before the next model call', async () => {
  const t = { active: 0, peak: 0, order: [] as string[] };
  const llm = scripted([calls(tc('look', { n: '1' }, 'a')), text('adjusted')]);
  const agent = agentWith(await tmpDir(), llm.fn, [slowTool('look', 'read', 5, t)]);
  const queue = [{ text: 'also check the tests', display: 'also check the tests' }];
  let calls_ = 0;
  agent.pendingInput = () => (++calls_ === 2 ? queue.splice(0) : []);
  const injected: string[] = [];
  await agent.send('fix it', OPTS, { ...recordingUi(), userInjected: (items) => injected.push(...items.map((i) => i.display)) });
  const second = llm.seen[1];
  const last = second[second.length - 1];
  assert.equal(second[second.length - 2].role, 'tool', 'tool result first');
  assert.equal(last.role, 'user');
  assert.match(last.content!, /while you were working:\n<user-message>\nalso check the tests\n<\/user-message>/);
  assert.equal((last as any).display, 'also check the tests');
  assert.deepEqual(injected, ['also check the tests']);
  assert.equal(agent.turnCount, 1, 'still the same turn');
});

test('agent: a message queued during the final reply makes the agent continue and answer it', async () => {
  const llm = scripted([text('first answer'), text('answer to the follow-up')]);
  const agent = agentWith(await tmpDir(), llm.fn, []);
  let n = 0;
  agent.pendingInput = () => (++n === 2 ? [{ text: 'and in French?', display: 'and in French?' }] : []);
  await agent.send('hello', OPTS, recordingUi());
  assert.equal(llm.seen.length, 2);
  assert.deepEqual(agent.history.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.match(agent.history[2].content!, /and in French\?/);
});

test('queuedMessageText: singular and plural wording', () => {
  assert.match(queuedMessageText(['a']), /this message while you were working/);
  assert.match(queuedMessageText(['a', 'b']), /these messages[\s\S]*<user-message>\na\n<\/user-message>\n<user-message>\nb/);
});

/* ------------------------------------------------------------------ runtime: queue end to end */

async function manager(llm: LlmFn) {
  const root = await tmpDir('pq-root-');
  const events: UiEvent[] = [];
  const mgr = new SessionManager({
    store: new SessionStore2(await tmpDir('pq-store-')),
    createAgent: () => new Agent({ root, llm, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => createFsTools() }),
    defaults: () => ({ mode: 'auto', effort: 'medium', model: 'm' }),
    onEvent: (_s, _a, e) => events.push(e),
    newSessionId: () => 's1', saveThrottleMs: 10,
  });
  return { mgr, root, events };
}

test('runtime: sending while busy queues the message and delivers it at the next step', async () => {
  const seen: ChatMessage[][] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let i = 0;
  const llm: LlmFn = async (_c, msgs) => {
    seen.push([...msgs]);
    if (i++ === 0) { await gate; return calls(tc('list_dir', { path: '.' }, 'l1')); }
    return text('done, including the README');
  };
  const { mgr, events } = await manager(llm);
  const s = mgr.newSession();
  const first = mgr.sendOrQueue(s.id, 'a1', 'summarize the repo');
  assert.equal(first.queued, false);
  await sleep(10);
  const q = mgr.sendOrQueue(s.id, 'a1', 'look at the README too', { display: 'look at the README too' });
  assert.equal(q.queued, true);
  assert.deepEqual(mgr.queued(s.id, 'a1').map((x) => x.display), ['look at the README too']);
  assert.ok(events.some((e) => e.type === 'queue' && e.items.length === 1));
  release();
  if (!first.queued) { await first.run; }
  assert.equal(seen.length, 2);
  assert.match(seen[1][seen[1].length - 1].content!, /look at the README too/);
  assert.deepEqual(mgr.queued(s.id, 'a1'), []);
  const mid = mgr.transcript(s.id, 'a1').events.filter((e) => e.type === 'userMsg');
  assert.deepEqual(mid.map((e) => [e.text, !!e.midTurn]), [['summarize the repo', false], ['look at the README too', true]]);
  assert.equal(mgr.agent(s.id, 'a1').agent.turnCount, 1);
});

test('runtime: a message queued after the last model call becomes the next turn', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let i = 0;
  const prompts: string[] = [];
  const llm: LlmFn = async (_c, msgs) => {
    prompts.push(String(msgs[msgs.length - 1].content));
    if (i++ === 0) { await gate; }
    return text(`reply ${i}`);
  };
  const { mgr } = await manager(llm);
  const s = mgr.newSession();
  const first = mgr.sendOrQueue(s.id, 'a1', 'one');
  await sleep(10);
  // The agent's loop polls the queue before its model call, so put the message in after that call started.
  mgr.sendOrQueue(s.id, 'a1', 'two');
  const rt = mgr.agent(s.id, 'a1');
  const pending = rt.agent.pendingInput!;
  rt.agent.pendingInput = () => []; // simulate the race: the final reply was already being generated
  release();
  if (!first.queued) { await first.run; }
  rt.agent.pendingInput = pending;
  for (let k = 0; k < 50 && rt.agent.turnCount < 2; k++) { await sleep(10); }
  while (rt.busy) { await sleep(10); }
  assert.equal(rt.agent.turnCount, 2, 'delivered as a new turn');
  assert.equal(prompts[1], 'two');
});

test('runtime: stopping hands queued messages back instead of sending them', async () => {
  const llm: LlmFn = async (_c, _m, _t, _o, signal) => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('Cancelled'))));
  const { mgr, events } = await manager(llm);
  const s = mgr.newSession();
  const first = mgr.sendOrQueue(s.id, 'a1', 'long task');
  await sleep(10);
  mgr.sendOrQueue(s.id, 'a1', 'actually do X', { display: 'actually do X' });
  mgr.stop(s.id, 'a1');
  if (!first.queued) { await first.run; }
  await sleep(30);
  assert.deepEqual(mgr.queued(s.id, 'a1'), []);
  assert.ok(events.some((e) => e.type === 'queueReturned' && e.texts[0] === 'actually do X'));
  assert.equal(mgr.agent(s.id, 'a1').agent.turnCount, 1, 'the queued message was not sent');
});

test('runtime: unqueue removes one message', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { mgr } = await manager(async () => { await gate; return text('ok'); });
  const s = mgr.newSession();
  const first = mgr.sendOrQueue(s.id, 'a1', 'go');
  await sleep(5);
  const a = mgr.sendOrQueue(s.id, 'a1', 'keep');
  const b = mgr.sendOrQueue(s.id, 'a1', 'drop');
  assert.ok(a.queued && b.queued);
  assert.equal(mgr.unqueue(s.id, 'a1', b.queued ? b.id : '')?.display, 'drop');
  assert.equal(mgr.unqueue(s.id, 'a1', 'nope'), undefined);
  assert.deepEqual(mgr.queued(s.id, 'a1').map((q) => q.display), ['keep']);
  release();
  if (!first.queued) { await first.run; }
});

/* ------------------------------------------------------------------ prompts */

test('prompt: environment names the real shell so commands work first time', () => {
  const win = environmentSection('C:\\repo', { platform: 'win32', date: new Date('2026-11-19T00:00:00Z') });
  assert.match(win, /Windows PowerShell 5\.1/);
  assert.match(win, /"&&" and "\|\|" are syntax errors/);
  assert.match(win, /curl\.exe/);
  assert.match(win, /Today's date: 2026-11-19/);
  assert.match(win, /Workspace root: C:\\repo/);
  const lin = shellGuide('linux');
  assert.match(lin, /bash/);
  assert.doesNotMatch(lin, /PowerShell/);
});

test('prompt: teaches parallel calls, search, HTTP, databases and safe defaults', () => {
  const p = buildSystemPrompt('auto', 'medium', '/w', '');
  for (const re of [/call several tools in ONE response/, /run at the same time/, /one regex alternation/, /always set a timeout/, /LIMIT \/ \.limit\(\)/,
    /Never run writes, schema changes/, /SCAN instead of KEYS/, /Do not print passwords/, /inside the company network/, /# Environment/]) {
    assert.match(p, re);
  }
});

test('ui: the composer queues while busy and shows the queue', async () => {
  const js = await fs.readFile(path.join(__dirname, '..', '..', 'media', 'session.js'), 'utf8');
  assert.doesNotMatch(js, /\|\| busy\) \{ return; \}/, 'send is not blocked while busy');
  assert.match(js, /case 'queue': renderQueue/);
  assert.match(js, /case 'queueReturned'/);
  assert.match(js, /m\.midTurn/);
  assert.match(js, /type: 'unqueue'/);
});
