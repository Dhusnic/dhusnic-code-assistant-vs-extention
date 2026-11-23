import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createFsTools } from '../core/fstools';
import { DiagEntry, EditDiagnostics, MAX_REPORTED, formatNewErrors, newErrors, waitForRecheck } from '../core/editDiagnostics';
import { Tool, ToolCtx } from '../core/tool';
import { Agent } from '../core/agent';
import { call, fakeLlm, recordingUi, text, tmpDir } from './helpers';

const tool = (name: string): Tool => createFsTools().find((t) => t.spec.function.name === name)!;

/** A fake language server: errors per file before the write, and what it reports once the write is re-checked. */
function fakeDiagnostics(before: DiagEntry[], after: DiagEntry[], known = true) {
  const calls = { baseline: 0, after: 0 };
  const probe: EditDiagnostics = {
    baseline: () => { calls.baseline++; return { known, errors: before }; },
    errorsAfterWrite: async () => { calls.after++; return after; },
  };
  return { probe, calls };
}

async function setup(content = 'const a = 1;\n') {
  const root = await tmpDir('ica-diag-');
  await fs.writeFile(path.join(root, 'a.ts'), content);
  const ctx = (diagnostics?: EditDiagnostics, signal = new AbortController().signal): ToolCtx =>
    ({ root, signal, snapshot: async () => undefined, diagnostics });
  return { root, ctx };
}

test('edit_file: appends only the errors the edit introduced', async () => {
  const { ctx } = await setup();
  const old = { line: 9, message: "Cannot find module 'x'.", source: 'ts' };
  const { probe } = fakeDiagnostics([old], [{ ...old, line: 10 }, { line: 1, message: "Type 'string' is not assignable to type 'number'.", source: 'ts' }]);
  const res = await tool('edit_file').run({ path: 'a.ts', old_string: 'const a = 1;', new_string: "const a: number = '1';" }, ctx(probe));
  assert.equal(res, "Edited a.ts\nNew errors after this edit:\na.ts:1 [Error] Type 'string' is not assignable to type 'number'. (ts)");
  assert.doesNotMatch(res, /Cannot find module/, 'a pre-existing error is not repeated, even after it moved');
});

test('edit_file and multi_edit: nothing is added when the edit introduced no errors', async () => {
  const { ctx } = await setup();
  const old = { line: 3, message: 'old problem' };
  const { probe, calls } = fakeDiagnostics([old], [old]);
  assert.equal(await tool('edit_file').run({ path: 'a.ts', old_string: '1', new_string: '2' }, ctx(probe)), 'Edited a.ts');
  assert.equal(await tool('multi_edit').run({ path: 'a.ts', edits: [{ old_string: '2', new_string: '3' }] }, ctx(probe)), 'Edited a.ts (1 changes)');
  assert.deepEqual(calls, { baseline: 2, after: 2 });
});

test('multi_edit and write_file report new errors; a brand-new file counts every error as new', async () => {
  const { root, ctx } = await setup();
  const err = { line: 2, message: 'boom' };
  const multi = await tool('multi_edit').run({ path: 'a.ts', edits: [{ old_string: '1', new_string: '2' }] }, ctx(fakeDiagnostics([], [err]).probe));
  assert.match(multi, /^Edited a\.ts \(1 changes\)\nNew errors after this edit:\na\.ts:2 \[Error\] boom$/);
  // The editor never saw b.ts (known=false), but it did not exist: its errors are new, not "may predate".
  const created = await tool('write_file').run({ path: 'b.ts', content: 'x' }, ctx(fakeDiagnostics([], [err], false).probe));
  assert.match(created, /^Wrote b\.ts\nNew errors after this edit:\nb\.ts:2 \[Error\] boom$/);
  assert.equal(await fs.readFile(path.join(root, 'b.ts'), 'utf8'), 'x');
});

test('an unknown baseline on an existing file says the errors may predate the edit', async () => {
  const { ctx } = await setup();
  const res = await tool('write_file').run({ path: 'a.ts', content: 'y' }, ctx(fakeDiagnostics([], [{ line: 1, message: 'bad' }], false).probe));
  assert.match(res, /^Wrote a\.ts\nErrors in the file after this edit \(some may predate it\):\na\.ts:1 \[Error\] bad$/);
});

test('without a provider, or when it is off or fails, edit results are unchanged', async () => {
  const { ctx } = await setup();
  assert.equal(await tool('edit_file').run({ path: 'a.ts', old_string: '1', new_string: '2' }, ctx()), 'Edited a.ts');
  const off: EditDiagnostics = { baseline: () => undefined, errorsAfterWrite: async () => { throw new Error('must not be called'); } };
  assert.equal(await tool('edit_file').run({ path: 'a.ts', old_string: '2', new_string: '3' }, ctx(off)), 'Edited a.ts');
  const broken: EditDiagnostics = { baseline: () => { throw new Error('x'); }, errorsAfterWrite: async () => [] };
  assert.equal(await tool('write_file').run({ path: 'a.ts', content: 'z' }, ctx(broken)), 'Wrote a.ts');
  const rejects: EditDiagnostics = { baseline: () => ({ known: true, errors: [] }), errorsAfterWrite: async () => { throw new Error('x'); } };
  assert.equal(await tool('write_file').run({ path: 'a.ts', content: 'w' }, ctx(rejects)), 'Wrote a.ts');
});

test('an aborted run still applies the edit but skips the diagnostics wait', async () => {
  const { root, ctx } = await setup();
  const ac = new AbortController();
  const { probe, calls } = fakeDiagnostics([], [{ line: 1, message: 'x' }]);
  probe.errorsAfterWrite = async () => { calls.after++; ac.abort(); return [{ line: 1, message: 'x' }]; };
  assert.equal(await tool('edit_file').run({ path: 'a.ts', old_string: '1', new_string: '2' }, ctx(probe, ac.signal)), 'Edited a.ts');
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'const a = 2;\n');
});

test('newErrors counts duplicates; formatNewErrors sorts by line and caps the list', () => {
  const e = (line: number, message = 'dup') => ({ line, message });
  assert.deepEqual(newErrors([e(1)], [e(5), e(7)]), [e(7)]);
  assert.equal(formatNewErrors('f.ts', [], true), '');
  const many = Array.from({ length: MAX_REPORTED + 3 }, (_, i) => e(100 - i, `m${i}`));
  const out = formatNewErrors('f.ts', many, true).split('\n');
  assert.equal(out.length, 1 + 1 + MAX_REPORTED + 1);
  assert.equal(out[2], 'f.ts:88 [Error] m12');
  assert.equal(out.at(-1), '...and 3 more');
});

function source() {
  const s = { listener: undefined as undefined | (() => void), disposed: 0, fire: () => s.listener?.() };
  const subscribe = (fn: () => void) => { s.listener = fn; return { dispose: () => { s.disposed++; s.listener = undefined; } }; };
  return { s, subscribe };
}

test('waitForRecheck: unchanged without events, settled after the first change goes quiet, aborts at once', async () => {
  const a = source();
  assert.equal(await waitForRecheck(a.subscribe, { firstMs: 30, quietMs: 20, maxMs: 1000 }), 'unchanged');
  assert.equal(a.s.disposed, 1);

  const b = source();
  const t0 = Date.now();
  const p = waitForRecheck(b.subscribe, { firstMs: 1000, quietMs: 40, maxMs: 2000 });
  setTimeout(() => b.s.fire(), 20);
  setTimeout(() => b.s.fire(), 50);
  assert.equal(await p, 'settled');
  assert.ok(Date.now() - t0 < 900, 'finishes early once quiet');

  const c = source();
  const iv = setInterval(() => c.s.fire(), 10);
  try { assert.equal(await waitForRecheck(c.subscribe, { firstMs: 1000, quietMs: 50, maxMs: 120 }), 'timeout'); } finally { clearInterval(iv); }

  const ac = new AbortController();
  const d = source();
  const q = waitForRecheck(d.subscribe, { firstMs: 1000, quietMs: 50, maxMs: 2000, signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  assert.equal(await q, 'aborted');
  assert.equal(d.s.disposed, 1);
});

test('agent: the diagnostics dependency reaches the edit tool, and the model sees the new errors', async () => {
  const { root } = await setup();
  const llm = fakeLlm([
    call('read_file', { path: 'a.ts' }, 'r1'),
    call('edit_file', { path: 'a.ts', old_string: '1', new_string: '2' }, 'e1'),
    text('done'),
  ]);
  const agent = new Agent({
    root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }),
    tools: () => createFsTools(), diagnostics: fakeDiagnostics([], [{ line: 1, message: 'broke it' }]).probe,
  });
  await agent.send('edit', { mode: 'auto', effort: 'medium', model: 'm' }, recordingUi());
  const toolMsg = agent.history.find((m: any) => m.role === 'tool' && m.tool_call_id === 'e1') as any;
  assert.match(String(toolMsg?.content), /^Edited a\.ts\nNew errors after this edit:\na\.ts:1 \[Error\] broke it/);
});
