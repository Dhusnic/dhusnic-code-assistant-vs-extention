import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Agent } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { LoopGuard, canonicalArgs, isFailure } from '../core/loopGuard';
import { fnSpec } from '../core/tool';
import { call, fakeLlm, recordingUi, text, tmpDir } from './helpers';

const OPTS = { mode: 'auto', effort: 'medium', model: 'm' } as const;
const J = (o: object) => JSON.stringify(o);

test('canonicalArgs ignores key order at every level and keeps unparseable input', () => {
  assert.equal(canonicalArgs('{"b":1,"a":{"y":2,"x":[{"q":1,"p":2}]}}'), canonicalArgs('{"a":{"x":[{"p":2,"q":1}],"y":2},"b":1}'));
  assert.notEqual(canonicalArgs('{"a":1}'), canonicalArgs('{"a":2}'));
  assert.equal(canonicalArgs('not json '), 'not json');
});

test('isFailure: errors, refusals and non-zero exits fail; output and exit 0 do not', () => {
  assert.equal(isFailure('edit_file', 'ERROR: old_string not found.'), true);
  assert.equal(isFailure('read_file', 'DENIED by user.'), true);
  assert.equal(isFailure('run_command', 'boom\n[exit 1]'), true);
  assert.equal(isFailure('run_command', 'ok\n[exit 0]'), false);
  assert.equal(isFailure('read_file', '1\tERROR in the file text'), false);
});

test('the same call 3 times nudges once, escalates after 2 more, then stays quiet', () => {
  const g = new LoopGuard();
  const args = J({ path: 'a.ts' });
  const levels: Array<number | undefined> = [];
  for (let i = 0; i < 9; i++) { levels.push(g.observe('read_file', i % 2 ? J({ path: 'a.ts' }) : args, 'contents', 'read')?.level); }
  assert.deepEqual(levels, [undefined, undefined, 1, undefined, 2, undefined, undefined, undefined, undefined]);
});

test('key order does not hide a repeat; different arguments do not count', () => {
  const g = new LoopGuard();
  assert.equal(g.observe('grep', '{"pattern":"x","path":"."}', 'r', 'read'), undefined);
  assert.equal(g.observe('grep', '{"path":".","pattern":"x"}', 'r', 'read'), undefined);
  assert.equal(g.observe('grep', '{"path":".","pattern":"y"}', 'r', 'read'), undefined);
  const n = g.observe('grep', '{"pattern":"x","path":"."}', 'r', 'read');
  assert.equal(n?.level, 1);
  assert.match(n!.reminder, /^<system-reminder>.*grep.*3 times.*<\/system-reminder>$/s);
});

test('a successful edit clears repeat counts: re-reading after a change is normal', () => {
  const g = new LoopGuard();
  const read = J({ path: 'a.ts' });
  g.observe('read_file', read, 'v1', 'read');
  g.observe('read_file', read, 'v1', 'read');
  g.observe('edit_file', J({ path: 'a.ts', old_string: 'a', new_string: 'b' }), 'Edited a.ts', 'edit');
  assert.equal(g.observe('read_file', read, 'v2', 'read'), undefined);
  assert.equal(g.observe('read_file', read, 'v2', 'read'), undefined);
  assert.equal(g.observe('read_file', read, 'v2', 'read')?.level, 1);
});

test('edits failing twice on one path nudge to re-read or rewrite; other paths are counted apart', () => {
  const g = new LoopGuard();
  const fail = 'ERROR: old_string not found.';
  assert.equal(g.observe('edit_file', J({ path: 'src/a.ts', old_string: 'x', new_string: 'y' }), fail, 'edit'), undefined);
  assert.equal(g.observe('edit_file', J({ path: 'src/b.ts', old_string: 'x', new_string: 'y' }), fail, 'edit'), undefined);
  const n = g.observe('multi_edit', J({ path: 'src\\a.ts', edits: [{ old_string: 'z', new_string: 'w' }] }), fail, 'edit');
  assert.equal(n?.level, 1);
  assert.match(n!.reminder, /read_file src\/a\.ts/);
  assert.match(n!.reminder, /write_file/);
  assert.match(n!.info, /src\/a\.ts failed 2 times/);
  assert.equal(g.observe('edit_file', J({ path: 'src/a.ts', old_string: 'q', new_string: 'y' }), fail, 'edit'), undefined);
  const strong = g.observe('edit_file', J({ path: 'src/a.ts', old_string: 'r', new_string: 'y' }), fail, 'edit');
  assert.equal(strong?.level, 2);
  assert.match(strong!.reminder, /STOP/);
  assert.equal(g.observe('edit_file', J({ path: 'src/a.ts', old_string: 's', new_string: 'y' }), fail, 'edit'), undefined);
});

test('the same command failing with the same output nudges on the second failure', () => {
  const g = new LoopGuard();
  const cmd = J({ command: 'npm test' });
  assert.equal(g.observe('run_command', cmd, 'FAIL x.test (12 ms)\n[exit 1]', 'exec'), undefined);
  const n = g.observe('run_command', cmd, 'FAIL x.test (15 ms)\n[exit 1]', 'exec');
  assert.equal(n?.level, 1);
  assert.match(n!.reminder, /npm test/);
  assert.match(n!.reminder, /Read the error/);
});

test('the same command failing 3 times with different output nudges; passing runs do not count as failures', () => {
  const g = new LoopGuard();
  const cmd = J({ command: 'make' });
  assert.equal(g.observe('run_command', cmd, 'error A\n[exit 2]', 'exec'), undefined);
  assert.equal(g.observe('run_command', cmd, 'error B\n[exit 2]', 'exec'), undefined);
  assert.equal(g.observe('run_command', cmd, 'error C\n[exit 2]', 'exec')?.level, 1);
  assert.equal(g.observe('run_command', cmd, 'error D\n[exit 2]', 'exec'), undefined);
  assert.equal(g.observe('run_command', cmd, 'error E\n[exit 2]', 'exec')?.level, 2);

  const h = new LoopGuard();
  assert.equal(h.observe('run_command', J({ command: 'ls' }), 'a\n[exit 0]', 'exec'), undefined);
  assert.equal(h.observe('run_command', J({ command: 'ls' }), 'b\n[exit 0]', 'exec'), undefined);
});

test('rounds in which every call failed nudge after 4 in a row; one success resets the streak', () => {
  const g = new LoopGuard();
  const failRound = (i: number) => { g.observe('read_file', J({ path: `missing${i}` }), 'ERROR: ENOENT', 'read'); return g.endRound(); };
  assert.equal(failRound(1), undefined);
  assert.equal(failRound(2), undefined);
  assert.equal(failRound(3), undefined);
  g.observe('read_file', J({ path: 'ok' }), 'text', 'read');
  assert.equal(g.endRound(), undefined);
  for (let i = 10; i < 13; i++) { assert.equal(failRound(i), undefined); }
  const n = failRound(13);
  assert.equal(n?.level, 1);
  assert.match(n!.reminder, /last 4 rounds failed/);
  assert.equal(g.endRound(), undefined, 'a round with no calls does not count');
});

test('Agent: a repeated failing edit reaches the model as a reminder in the tool result, and the user sees it', async () => {
  const root = await tmpDir('loop-');
  const fs = await import('fs/promises');
  const path = await import('path');
  await fs.writeFile(path.join(root, 'a.txt'), 'hello world\n');
  const bad = { path: 'a.txt', old_string: 'goodbye', new_string: 'x' };
  const llm = fakeLlm([
    call('read_file', { path: 'a.txt' }, 'R1'),
    call('edit_file', bad, 'E1'),
    call('edit_file', { ...bad, old_string: 'Hello' }, 'E2'),
    text('gave up'),
  ]);
  const agent = new Agent({ root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => createFsTools() });
  const ui = recordingUi();
  await agent.send('change it', OPTS, ui);
  const tools = agent.history.filter((m) => m.role === 'tool');
  assert.doesNotMatch(String(tools[1].content), /system-reminder/);
  assert.match(String(tools[2].content), /^ERROR: .*not found[\s\S]*<system-reminder>edit_file has failed 2 times on a\.txt/);
  // The model's next request carried the reminder.
  const sent = llm.calls[3].filter((m: any) => m.role === 'tool').map((m: any) => String(m.content)).join('\n');
  assert.match(sent, /read_file a\.txt to see its current contents/);
  assert.equal(ui.events.filter((e) => /^info:Edits to a\.txt failed 2 times/.test(e)).length, 1);
});

test('Agent: identical calls are nudged once per turn, and a new turn starts fresh', async () => {
  const root = await tmpDir('loop-');
  const same = (id: string) => call('grep', { pattern: 'zzz' }, id);
  const llm = fakeLlm([same('a1'), same('a2'), same('a3'), text('done'), same('b1'), same('b2'), text('done')]);
  const agent = new Agent({ root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => createFsTools() });
  await agent.send('find it', OPTS, recordingUi());
  const nudged = () => agent.history.filter((m) => m.role === 'tool' && /<system-reminder>You have now called grep/.test(String(m.content))).length;
  assert.equal(nudged(), 1);
  await agent.send('again', OPTS, recordingUi());
  assert.equal(nudged(), 1, 'the second turn has only 2 repeats: no new nudge');
});

test('Agent: a command failing the same way twice is nudged (fake run_command)', async () => {
  const root = await tmpDir('loop-');
  const runCommand = { kind: 'exec' as const, spec: fnSpec('run_command', '', {}, []), describe: (a: any) => `Run: ${a.command}`, run: async () => 'Cannot find module x\n[exit 1]' };
  const llm = fakeLlm([call('run_command', { command: 'node app.js' }, 'c1'), call('run_command', { command: 'node app.js' }, 'c2'), text('stop')]);
  const agent = new Agent({ root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => [runCommand] });
  const ui = recordingUi();
  await agent.send('run it', OPTS, ui);
  const last = agent.history.filter((m) => m.role === 'tool').at(-1)!;
  assert.match(String(last.content), /<system-reminder>The command `node app\.js` keeps failing/);
  assert.ok(ui.events.some((e) => /^info:The command `node app\.js` keeps failing/.test(e)));
});

test('after the escalation an identical call is blocked, and two blocked calls mark the turn stuck', () => {
  const g = new LoopGuard();
  const args = J({ command: 'git log --oneline -1000' });
  for (let i = 0; i < 5; i++) { assert.equal(g.blocks('run_command', args), false); g.observe('run_command', args, 'abc\n[exit 0]'); }
  assert.equal(g.blocks('run_command', args), true, 'escalated at 5: the next identical call is refused');
  assert.equal(g.blocks('run_command', J({ command: 'git log -5' })), false, 'other arguments still run');
  assert.match(g.block('run_command'), /^BLOCKED: not run/);
  assert.equal(g.stuck, false);
  g.block('run_command');
  assert.equal(g.stuck, true);
});

test('Agent: a call repeated after the escalation is not run, and the turn stops once it keeps going', async () => {
  const root = await tmpDir('loop-');
  let runs = 0;
  const runCommand = { kind: 'read' as const, spec: fnSpec('run_command', '', {}, []), describe: (a: any) => `Run: ${a.command}`, run: async () => { runs++; return 'abc123 fix\n[exit 0]'; } };
  const same = (id: string) => call('run_command', { command: 'git log --oneline -1000' }, id);
  const llm = fakeLlm([...Array.from({ length: 10 }, (_, i) => same(`c${i}`)), text('never reached')]);
  const agent = new Agent({ root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => [runCommand] });
  const ui = recordingUi();
  await agent.send('investigate', OPTS, ui);
  assert.equal(runs, 5, 'runs until the escalation, then is refused');
  assert.equal(llm.calls.length, 7, 'two refused calls, then the turn ends');
  assert.equal(agent.history.filter((m) => m.role === 'tool' && /^BLOCKED: not run/.test(String(m.content))).length, 2);
  assert.ok(ui.events.some((e) => /^info:Stopped: the agent kept repeating/.test(e)));
});
