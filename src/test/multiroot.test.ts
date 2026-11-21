import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createFsTools, resolveIn, rootOf } from '../core/fstools';
import { environmentSection } from '../core/prompts';
import { Tool, ToolCtx } from '../core/tool';
import { tmpDir } from './helpers';

/** A two-folder workspace: "app" (primary) and "api". */
async function workspace() {
  const base = await tmpDir('ica-mr-');
  const app = path.join(base, 'app');
  const api = path.join(base, 'api');
  await fs.mkdir(path.join(app, 'src'), { recursive: true });
  await fs.mkdir(path.join(api, 'server'), { recursive: true });
  await fs.writeFile(path.join(app, 'src', 'main.ts'), 'export const APP = 1;\n');
  await fs.writeFile(path.join(api, 'server', 'routes.py'), 'API_ROUTE = "/v1"\n');
  const roots = [{ name: 'app', path: app }, { name: 'api', path: api }];
  const ctx: ToolCtx = { root: app, roots, signal: new AbortController().signal, snapshot: async () => undefined };
  return { base, app, api, roots, ctx };
}

const tools = createFsTools();
const tool = (name: string): Tool => tools.find((t) => t.spec.function.name === name)!;

test('resolveIn: relative paths stay under the primary root', async () => {
  const { app, ctx } = await workspace();
  assert.equal(resolveIn(ctx, 'src/main.ts'), path.join(app, 'src', 'main.ts'));
  assert.equal(resolveIn(ctx, ''), app);
});

test('resolveIn: "<folder name>/path" addresses another workspace folder', async () => {
  const { api, ctx } = await workspace();
  assert.equal(resolveIn(ctx, 'api/server/routes.py'), path.join(api, 'server', 'routes.py'));
  assert.equal(resolveIn(ctx, 'API\\server\\routes.py'), path.join(api, 'server', 'routes.py'));
  assert.equal(resolveIn(ctx, 'api'), api);
});

test('resolveIn: a real folder in the primary root wins over a workspace folder with the same name', async () => {
  const { app, ctx } = await workspace();
  await fs.mkdir(path.join(app, 'api'));
  assert.equal(resolveIn(ctx, 'api/x.ts'), path.join(app, 'api', 'x.ts'));
});

test('resolveIn: absolute paths inside any folder are allowed; outside all of them, refused', async () => {
  const { base, api, ctx } = await workspace();
  assert.equal(resolveIn(ctx, path.join(api, 'server')), path.join(api, 'server'));
  assert.throws(() => resolveIn(ctx, path.join(base, 'elsewhere.txt')), /Path outside workspace/);
  assert.throws(() => resolveIn(ctx, '../api/server/routes.py'), /Path outside workspace/);
  assert.throws(() => resolveIn(ctx, 'api/../../secret.txt'), /Path outside workspace/);
});

test('resolveIn: a single-root workspace behaves exactly as before', async () => {
  const { app, api } = await workspace();
  const single = { root: app };
  assert.equal(resolveIn(single, 'src/main.ts'), path.join(app, 'src', 'main.ts'));
  assert.throws(() => resolveIn(single, path.join(api, 'server')), /Path outside workspace/);
  assert.equal(path.resolve(resolveIn(single, 'api/x')), path.join(app, 'api', 'x'));
});

test('rootOf: finds the folder that contains a path', async () => {
  const { app, api, ctx } = await workspace();
  assert.equal(rootOf(ctx, path.join(api, 'server', 'routes.py'))?.name, 'api');
  assert.equal(rootOf(ctx, path.join(app, 'src'))?.path, app);
  assert.equal(rootOf(ctx, path.dirname(app)), undefined);
});

test('read and edit a file in the second folder through its name', async () => {
  const { api, ctx } = await workspace();
  assert.match(await tool('read_file').run({ path: 'api/server/routes.py' }, ctx), /API_ROUTE = "\/v1"/);
  assert.equal(await tool('edit_file').run({ path: 'api/server/routes.py', old_string: '/v1', new_string: '/v2' }, ctx), 'Edited api/server/routes.py');
  assert.equal(await fs.readFile(path.join(api, 'server', 'routes.py'), 'utf8'), 'API_ROUTE = "/v2"\n');
  assert.match(await tool('list_dir').run({ path: 'api/server' }, ctx), /routes\.py/);
});

test('glob_files and grep in the second folder return paths that round-trip', async () => {
  const { ctx } = await workspace();
  const globbed = await tool('glob_files').run({ pattern: '**/*.py', path: 'api' }, ctx);
  assert.equal(globbed.trim(), 'api/server/routes.py');
  const grepped = await tool('grep').run({ pattern: 'API_ROUTE', path: 'api', output_mode: 'files' }, ctx);
  assert.match(grepped, /^api\/server\/routes\.py$/m);
  assert.match(await tool('read_file').run({ path: 'api/server/routes.py' }, ctx), /API_ROUTE/);
  // Without a path, search stays in the primary folder as before.
  assert.equal((await tool('glob_files').run({ pattern: '**/*.py' }, ctx)).trim(), '(no matches)');
  assert.match(await tool('grep').run({ pattern: 'APP', output_mode: 'files' }, ctx), /^src\/main\.ts$/m);
});

test('run_command runs in another folder with cwd; bad cwd is refused', async () => {
  const { api, base, ctx } = await workspace();
  const cmd = process.platform === 'win32' ? '(Get-Location).Path' : 'pwd';
  const out = await tool('run_command').run({ command: cmd, cwd: 'api' }, ctx);
  // Compare real paths: a temp folder may be reported in 8.3 short form (C:UsersRUNNER~1...) while the shell prints the long one.
  const real = (await fs.realpath(api)).toLowerCase();
  assert.ok(out.toLowerCase().includes(real), `${out} should contain ${real}`);
  assert.match(out, /\[exit 0\]$/);
  await assert.rejects(tool('run_command').run({ command: cmd, cwd: 'api/server/routes.py' }, ctx), /not a directory/);
  await assert.rejects(tool('run_command').run({ command: cmd, cwd: base }, ctx), /Path outside workspace/);
});

test('environmentSection lists the folders only in a multi-root workspace', async () => {
  const { app, roots } = await workspace();
  const multi = environmentSection(app, { platform: process.platform, roots });
  assert.match(multi, /Workspace folders \(multi-root\):/);
  assert.ok(multi.includes(`- app: ${app} (primary)`));
  assert.match(multi, /- api: .*api\n/);
  assert.match(multi, /run_command's cwd/);
  const single = environmentSection(app, { platform: process.platform, roots: [roots[0]] });
  assert.doesNotMatch(single, /Workspace folders/);
  assert.equal(single, environmentSection(app, { platform: process.platform }));
});
