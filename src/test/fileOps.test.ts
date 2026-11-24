import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createFsTools } from '../core/fstools';
import { CheckpointStore } from '../core/checkpoints';
import { createScreenshotTool, windowsScript, SCREEN_DIR } from '../core/screenshot';
import { Tool, ToolCtx } from '../core/tool';
import { tmpDir } from './helpers';

const tools = createFsTools();
const tool = (name: string): Tool => tools.find((t) => t.spec.function.name === name)!;

async function workspace() {
  const root = await tmpDir('ica-fops-');
  await fs.mkdir(path.join(root, 'src', 'lib'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const A = 1;\n');
  await fs.writeFile(path.join(root, 'src', 'lib', 'b.ts'), 'export const B = 2;\n');
  const store = new CheckpointStore(path.join(await tmpDir('ica-fops-cp-'), 'cp'));
  const ctx: ToolCtx = { root, signal: new AbortController().signal, snapshot: (abs) => store.snapshot(1, abs) };
  return { root, ctx, store };
}

const read = (p: string) => fs.readFile(p, 'utf8');
const exists = (p: string) => fs.stat(p).then(() => true, () => false);

test('create_dir makes nested folders and is idempotent', async () => {
  const { root, ctx } = await workspace();
  assert.match(await tool('create_dir').run({ path: 'out/x/y' }, ctx), /Created/);
  assert.ok((await fs.stat(path.join(root, 'out', 'x', 'y'))).isDirectory());
  assert.match(await tool('create_dir').run({ path: 'out/x/y' }, ctx), /already exists/);
});

test('move_path renames a file, refuses to overwrite, and rewinds', async () => {
  const { root, ctx, store } = await workspace();
  await tool('move_path').run({ path: 'src/a.ts', destination: 'src/renamed.ts' }, ctx);
  assert.ok(!await exists(path.join(root, 'src', 'a.ts')));
  assert.equal(await read(path.join(root, 'src', 'renamed.ts')), 'export const A = 1;\n');
  await assert.rejects(tool('move_path').run({ path: 'src/renamed.ts', destination: 'src/lib/b.ts' }, ctx), /already exists/);
  await store.restore(1);
  assert.equal(await read(path.join(root, 'src', 'a.ts')), 'export const A = 1;\n');
  assert.ok(!await exists(path.join(root, 'src', 'renamed.ts')));
});

test('move_path into an existing folder moves the folder inside it', async () => {
  const { root, ctx } = await workspace();
  await fs.mkdir(path.join(root, 'pkg'));
  assert.match(await tool('move_path').run({ path: 'src/lib', destination: 'pkg' }, ctx), /Moved src\/lib → pkg\/lib/);
  assert.equal(await read(path.join(root, 'pkg', 'lib', 'b.ts')), 'export const B = 2;\n');
  await assert.rejects(tool('move_path').run({ path: 'pkg', destination: 'pkg/lib/inner' }, ctx), /into itself/);
});

test('move_path overwrite replaces the destination and rewind restores both', async () => {
  const { root, ctx, store } = await workspace();
  await tool('move_path').run({ path: 'src/a.ts', destination: 'src/lib/b.ts', overwrite: true }, ctx);
  assert.equal(await read(path.join(root, 'src', 'lib', 'b.ts')), 'export const A = 1;\n');
  await store.restore(1);
  assert.equal(await read(path.join(root, 'src', 'lib', 'b.ts')), 'export const B = 2;\n');
  assert.equal(await read(path.join(root, 'src', 'a.ts')), 'export const A = 1;\n');
});

test('copy_path copies a folder recursively and rewind removes the copy', async () => {
  const { root, ctx, store } = await workspace();
  assert.match(await tool('copy_path').run({ path: 'src', destination: 'backup' }, ctx), /2 files/);
  assert.equal(await read(path.join(root, 'backup', 'lib', 'b.ts')), 'export const B = 2;\n');
  assert.ok(await exists(path.join(root, 'src', 'a.ts')));
  await store.restore(1);
  assert.ok(!await exists(path.join(root, 'backup', 'lib', 'b.ts')));
});

test('delete_path needs recursive for a full folder, previews, and rewinds', async () => {
  const { root, ctx, store } = await workspace();
  await assert.rejects(tool('delete_path').run({ path: 'src' }, ctx), /recursive: true/);
  const pv = await tool('delete_path').preview!({ path: 'src', recursive: true }, ctx);
  assert.match(pv.oldText, /src\/lib\/b\.ts/);
  assert.match(await tool('delete_path').run({ path: 'src', recursive: true }, ctx), /2 files/);
  assert.ok(!await exists(path.join(root, 'src')));
  await store.restore(1);
  assert.equal(await read(path.join(root, 'src', 'lib', 'b.ts')), 'export const B = 2;\n');
});

test('file ops refuse the workspace root, .git and paths outside the workspace', async () => {
  const { root, ctx } = await workspace();
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref\n');
  await assert.rejects(tool('delete_path').run({ path: '.', recursive: true }, ctx), /workspace folder itself/);
  await assert.rejects(tool('delete_path').run({ path: '.git/HEAD' }, ctx), /\.git/);
  await assert.rejects(tool('move_path').run({ path: 'src/a.ts', destination: '../escape.ts' }, ctx), /outside workspace/);
  await assert.rejects(tool('copy_path').run({ path: 'src', destination: '.git/x' }, ctx), /\.git/);
});

test('file_info reports text files, folders and missing paths', async () => {
  const { ctx } = await workspace();
  const out = await tool('file_info').run({ paths: ['src/a.ts', 'src', 'nope.txt'] }, ctx);
  assert.match(out, /src\/a\.ts: text file, 2 lines/);
  assert.match(out, /src: folder, 2 files, 1 folders/);
  assert.match(out, /nope\.txt: ERROR not found/);
});

test('list_dir depth shows a tree and skips node_modules', async () => {
  const { root, ctx } = await workspace();
  await fs.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
  const flat = await tool('list_dir').run({ path: '.' }, ctx);
  assert.doesNotMatch(flat, /a\.ts/);
  const tree = await tool('list_dir').run({ path: '.', depth: 3 }, ctx);
  assert.match(tree, /^src\/\n {2}lib\/\n {4}b\.ts\n {2}a\.ts/m);
  assert.match(tree, /node_modules\/ \(skipped\)/);
});

test('screenshot saves to the temp screens folder and asks the viewer a question', async () => {
  const { ctx } = await workspace();
  const tmp = await tmpDir('ica-shot-');
  const seen: any[] = [];
  const shot = createScreenshotTool({
    tmpDir: tmp,
    capture: async (req) => { seen.push(req); await fs.writeFile(req.out, 'PNGDATA'); },
    view: async (p, q) => `viewed ${path.basename(p)}: ${q}`,
  });
  const out = await shot.run({ target: 'window', window_title: 'Notepad', question: 'any error?' }, ctx);
  assert.equal(seen[0].target, 'window');
  assert.equal(seen[0].windowTitle, 'Notepad');
  assert.ok(seen[0].out.startsWith(path.join(tmp, SCREEN_DIR)));
  assert.match(out, /viewed screenshot-.*\.png: any error\?/);
});

test('screenshot save_to writes into the workspace; region needs valid numbers', async () => {
  const { root, ctx } = await workspace();
  const shot = createScreenshotTool({ capture: async (req) => { await fs.writeFile(req.out, 'PNG'); } });
  assert.match(await shot.run({ save_to: 'shots/home' }, ctx), /home\.png/);
  assert.ok(await exists(path.join(root, 'shots', 'home.png')));
  await assert.rejects(shot.run({ target: 'region', region: { x: 0, y: 0, width: 0, height: 5 } }, ctx), /positive width/);
  await assert.rejects(shot.run({ save_to: '../x.png' }, ctx), /outside workspace/);
});

test('windowsScript quotes the window title and output path safely', () => {
  const s = windowsScript({ target: 'window', windowTitle: "it's $(evil)", out: "C:\\t\\o'k.png" });
  assert.match(s, /-like '\*it''s \$\(evil\)\*'/);
  assert.match(s, /\$out = 'C:\\t\\o''k\.png'/);
  assert.match(s, /PrintWindow/);
  assert.match(windowsScript({ target: 'screen', out: 'x.png' }), /VirtualScreen/);
});
