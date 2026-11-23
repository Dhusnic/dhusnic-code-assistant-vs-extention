/**
 * Local edit statistics (core/editStats.ts): reason codes are checked against the real fstools error messages, the
 * report must never contain paths or file contents, and the agent records outcomes with the model of the run.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { EditStats, classifyEditError, extensionOf, formatEditStats } from '../core/editStats';
import { FileReadTracker, applyEdit, createFsTools } from '../core/fstools';
import { Tool, ToolCtx } from '../core/tool';
import { Agent } from '../core/agent';
import { call, fakeLlm, recordingUi, text, tmpDir } from './helpers';

const tool = (name: string): Tool => createFsTools().find((t) => t.spec.function.name === name)!;
const errorOf = (fn: () => unknown): string => { try { fn(); } catch (e: any) { return e.message; } return ''; };
const errorOfAsync = async (p: Promise<unknown>): Promise<string> => { try { await p; } catch (e: any) { return e.message; } return ''; };

test('classifyEditError: reasons come from the real fstools error messages', async () => {
  const text_ = 'a\nb\na\n';
  assert.equal(classifyEditError(errorOf(() => applyEdit(text_, { old_string: 'zzz qqq', new_string: 'x' }))), 'no_match');
  assert.equal(classifyEditError(errorOf(() => applyEdit(text_, { old_string: 'a', new_string: 'x' }))), 'multiple_matches');
  assert.equal(classifyEditError(errorOf(() => applyEdit(text_, { old_string: '', new_string: 'x' }))), 'empty_old_string');
  assert.equal(classifyEditError(errorOf(() => applyEdit(text_, { old_string: 'b', new_string: 'b' }))), 'no_change');
  assert.equal(classifyEditError(errorOf(() => applyEdit(text_, { old_string: 'zzz qqq', new_string: 'x' }, 'edits[2].old_string'))), 'no_match');

  const root = await tmpDir('ica-estats-');
  await fs.writeFile(path.join(root, 'a.ts'), 'const a = 1;\n');
  const reads = new FileReadTracker();
  const ctx: ToolCtx = { root, signal: new AbortController().signal, snapshot: async () => undefined, reads };
  const edit = tool('edit_file');
  assert.equal(classifyEditError(await errorOfAsync(edit.run({ path: 'a.ts', old_string: '1', new_string: '2' }, ctx))), 'not_read_first');
  await reads.markRead(path.join(root, 'a.ts'));
  await new Promise((r) => setTimeout(r, 20));
  await fs.writeFile(path.join(root, 'a.ts'), 'const a = 10;\n');
  assert.equal(classifyEditError(await errorOfAsync(edit.run({ path: 'a.ts', old_string: '1', new_string: '2' }, ctx))), 'stale_file');
  assert.equal(classifyEditError(await errorOfAsync(edit.run({ path: '../x.ts', old_string: '1', new_string: '2' }, ctx))), 'outside_workspace');
  assert.equal(classifyEditError(await errorOfAsync(edit.run({ path: 'missing.ts', old_string: '1', new_string: '2' }, { ...ctx, reads: undefined }))), 'file_missing');
  assert.equal(classifyEditError(await errorOfAsync(tool('multi_edit').run({ path: 'a.ts', edits: [] }, ctx))), 'bad_arguments');
  assert.equal(classifyEditError('EPERM: operation not permitted, open'), 'permission');
  assert.equal(classifyEditError('something else entirely'), 'other');
});

test('extensionOf: keeps only a lower-cased extension, never the path', () => {
  assert.equal(extensionOf('src/Secret/Thing.TS'), '.ts');
  assert.equal(extensionOf('C:\\repo\\a.min.js'), '.js');
  assert.equal(extensionOf('Makefile'), '(none)');
  assert.equal(extensionOf(undefined), '(none)');
  assert.equal(extensionOf('a.weird ext with spaces'), '(none)');
});

test('EditStats: counts by tool, model, extension and reason; the report holds no paths or contents', () => {
  const s = new EditStats(() => new Date('2026-01-01T00:00:00Z'));
  s.record({ tool: 'edit_file', model: 'qwen', path: 'src/private/a.ts' });
  s.record({ tool: 'edit_file', model: 'qwen', path: 'src/private/b.ts', error: 'old_string not found.\nThe closest text in the file is near line 3:\n3\tSECRET_TOKEN = 1' });
  s.record({ tool: 'multi_edit', model: 'llama', path: 'x.py', error: 'edits[0].old_string matches 2 places; add surrounding lines' });
  s.record({ tool: 'write_file', model: '', path: 'README.md' });
  s.record({ tool: 'read_file', model: 'qwen', path: 'a.ts' });
  const snap = s.snapshot();
  assert.deepEqual(snap.total, { ok: 2, failed: 2, reasons: { no_match: 1, multiple_matches: 1 } });
  assert.deepEqual(snap.byModel.qwen, { ok: 1, failed: 1, reasons: { no_match: 1 } });
  assert.deepEqual(snap.byModel['(default)'], { ok: 1, failed: 0, reasons: {} });
  assert.deepEqual(snap.byExtension['.ts'], { ok: 1, failed: 1, reasons: { no_match: 1 } });
  assert.deepEqual(snap.byTool.multi_edit, { ok: 0, failed: 1, reasons: { multiple_matches: 1 } });
  assert.equal(snap.byTool.read_file, undefined, 'other tools are not counted');

  const report = formatEditStats(snap);
  assert.match(report, /Total: 4 calls, 2 ok, 2 failed \(50%\)/);
  assert.match(report, /qwen\s+1\s+1\s+50%\s+no_match 1/);
  assert.match(report, /\.py\s+0\s+1\s+100%\s+multiple_matches 1/);
  assert.doesNotMatch(report, /SECRET_TOKEN|private|closest text|README/);

  s.reset();
  assert.match(formatEditStats(s.snapshot()), /No edit_file, multi_edit or write_file calls yet/);
});

test('EditStats: distinct keys are capped', () => {
  const s = new EditStats();
  for (let i = 0; i < 150; i++) { s.record({ tool: 'edit_file', model: `m${i}`, path: 'a.ts' }); }
  const models = s.snapshot().byModel;
  assert.equal(Object.keys(models).length, 101);
  assert.equal(models['(other)'].ok, 50);
});

test('agent: edit tool outcomes reach the stats with the run model; other tools are not counted', async () => {
  const root = await tmpDir('ica-estats-agent-');
  await fs.writeFile(path.join(root, 'a.ts'), 'const a = 1;\n');
  const llm = fakeLlm([
    call('edit_file', { path: 'a.ts', old_string: '1', new_string: '2' }, 'e0'),
    call('read_file', { path: 'a.ts' }, 'r1'),
    call('edit_file', { path: 'a.ts', old_string: 'nope nope', new_string: '2' }, 'e1'),
    call('edit_file', { path: 'a.ts', old_string: '1', new_string: '2' }, 'e2'),
    text('done'),
  ]);
  const stats = new EditStats();
  const agent = new Agent({
    root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }),
    tools: () => createFsTools(), editStats: stats,
  });
  await agent.send('edit', { mode: 'auto', effort: 'medium', model: 'model-x' }, recordingUi());
  const snap = stats.snapshot();
  assert.deepEqual(snap.byModel['model-x'], { ok: 1, failed: 2, reasons: { not_read_first: 1, no_match: 1 } });
  assert.deepEqual(Object.keys(snap.byTool), ['edit_file']);
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'const a = 2;\n');
});
