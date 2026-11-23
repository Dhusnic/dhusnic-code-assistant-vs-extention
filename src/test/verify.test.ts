import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { detectVerifyCommands, formatVerifyCommands, parseVerifySection, workspaceDirs } from '../core/verify';
import { tmpDir } from './helpers';

async function repo(files: Record<string, string>): Promise<string> {
  const root = await tmpDir('ica-verify-');
  for (const [name, content] of Object.entries(files)) { await fs.writeFile(path.join(root, name), content, 'utf8'); }
  return root;
}
const cmds = async (files: Record<string, string>, platform: NodeJS.Platform = 'linux') =>
  (await detectVerifyCommands(await repo(files), platform)).map((c) => c.command);

test('verify section: fenced block and bullets, stops at the next heading of the same level', () => {
  const md = [
    '# Project', 'intro', '```', 'not-a-command', '```',
    '## Verify', 'Run these:', '```bash', '# comment', 'npm run lint', '', '$ npm test', '```',
    '- `go vet ./...`', '- make check', '### Sub heading', '- `still-in`',
    '## Other', '- `not-in`',
  ].join('\n');
  assert.deepEqual(parseVerifySection(md), ['npm run lint', 'npm test', 'go vet ./...', 'make check', 'still-in']);
  assert.deepEqual(parseVerifySection('### checks\r\n- `a`\r\n## Next\r\n- `b`'), ['a']);
  assert.deepEqual(parseVerifySection('# Nothing here\n- `x`'), []);
});

test('config in INFRAON.md wins over detection', async () => {
  const root = await repo({ 'INFRAON.md': '## Verify\n- `custom check`', 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) });
  assert.deepEqual(await detectVerifyCommands(root, 'linux'), [{ name: 'verify', command: 'custom check', timeoutSeconds: 600, source: 'INFRAON.md' }]);
});

test('a CLAUDE.md without a verify section does not stop detection', async () => {
  assert.deepEqual(await cmds({ 'CLAUDE.md': '# Rules\n- use tabs', 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) }), ['npm run test']);
});

test('package manager follows the lockfile; order is typecheck, lint, test', async () => {
  const pkg = JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .', typecheck: 'tsc --noEmit' } });
  assert.deepEqual(await cmds({ 'package.json': pkg }), ['npm run typecheck', 'npm run lint', 'npm run test']);
  assert.deepEqual(await cmds({ 'package.json': pkg, 'pnpm-lock.yaml': '' }), ['pnpm run typecheck', 'pnpm run lint', 'pnpm run test']);
  assert.deepEqual(await cmds({ 'package.json': pkg, 'yarn.lock': '' }), ['yarn typecheck', 'yarn lint', 'yarn test']);
  assert.deepEqual(await cmds({ 'package.json': pkg, 'bun.lockb': '' }), ['bun run typecheck', 'bun run lint', 'bun run test']);
});

test('npm placeholder test and watch-mode scripts are skipped', async () => {
  assert.deepEqual(await cmds({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }), []);
  assert.deepEqual(await cmds({ 'package.json': JSON.stringify({ scripts: { test: 'vitest --watch', lint: 'eslint . watch' } }) }), []);
});

test('tsc fallback when typescript is a dependency and tsconfig.json exists', async () => {
  const pkg = JSON.stringify({ devDependencies: { typescript: '^5' }, scripts: { test: 'node --test' } });
  assert.deepEqual(await cmds({ 'package.json': pkg, 'tsconfig.json': '{}' }), ['npx tsc --noEmit -p .', 'npm run test']);
  assert.deepEqual(await cmds({ 'package.json': pkg }), ['npm run test']);
});

test('python: pytest, ruff and mypy', async () => {
  assert.deepEqual(await cmds({ 'pyproject.toml': '[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n' }), ['mypy .', 'ruff check .', 'python -m pytest -q -x']);
  assert.deepEqual(await cmds({ 'pytest.ini': '' }), ['python -m pytest -q -x']);
  assert.deepEqual(await cmds({ 'setup.cfg': '[tool:pytest]\n' }), ['python -m pytest -q -x']);
  assert.deepEqual(await cmds({ 'conftest.py': '' }), ['python -m pytest -q -x']);
});

test('go and cargo', async () => {
  assert.deepEqual(await cmds({ 'go.mod': 'module x' }), ['go vet ./...', 'go test ./...']);
  assert.deepEqual(await cmds({ 'Cargo.toml': '[package]' }), ['cargo check', 'cargo test']);
});

test('maven and gradle on windows and linux', async () => {
  assert.deepEqual(await cmds({ 'pom.xml': '<project/>' }), ['mvn -q -B test']);
  assert.deepEqual(await cmds({ 'build.gradle': '', 'gradlew.bat': '', gradlew: '' }, 'win32'), ['.\\gradlew.bat test']);
  assert.deepEqual(await cmds({ 'build.gradle.kts': '', 'gradlew.bat': '', gradlew: '' }, 'linux'), ['./gradlew test']);
  assert.deepEqual(await cmds({ 'build.gradle': '' }, 'win32'), ['gradle test']);
});

test('Makefile test target is used only when nothing else is found', async () => {
  assert.deepEqual(await cmds({ Makefile: 'build:\n\tcc x\ntest:\n\t./run' }), ['make test']);
  assert.deepEqual(await cmds({ Makefile: 'test:\n\t./run', 'go.mod': 'module x' }), ['go vet ./...', 'go test ./...']);
});

test('ecosystems combine, checks come before tests, capped at 5', async () => {
  const pkg = JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .', typecheck: 'tsc' } });
  const out = await cmds({ 'package.json': pkg, 'go.mod': 'module x', 'Cargo.toml': '' });
  assert.equal(out.length, 5);
  assert.deepEqual(out, ['npm run typecheck', 'npm run lint', 'go vet ./...', 'cargo check', 'npm run test']);
});

test('broken package.json and empty folders give no commands and never throw', async () => {
  assert.deepEqual(await cmds({ 'package.json': '{ not json' }), []);
  assert.deepEqual(await cmds({}), []);
  assert.deepEqual(await detectVerifyCommands(path.join(await tmpDir(), 'missing')), []);
});

test('formatVerifyCommands', () => {
  assert.equal(formatVerifyCommands([]), '');
  assert.equal(formatVerifyCommands([{ name: 'test', command: 'npm test', timeoutSeconds: 600, source: 'package.json' }]), '- test: `npm test` (from package.json)');
});

/* ------------------------------------------------------------------ workspace type checks */

async function writeJson(file: string, obj: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj));
}

test('workspaces: each TypeScript package is type-checked when the root has no type check', async () => {
  const root = await tmpDir('verify-ws-');
  await writeJson(path.join(root, 'package.json'), { workspaces: ['server', 'client', 'docs'], scripts: { lint: 'eslint .', test: 'npm run test --prefix server' } });
  await writeJson(path.join(root, 'client', 'package.json'), { devDependencies: { typescript: '^5' } });
  await writeJson(path.join(root, 'client', 'tsconfig.json'), {});
  await writeJson(path.join(root, 'server', 'package.json'), { devDependencies: { typescript: '^5' } });
  await writeJson(path.join(root, 'server', 'tsconfig.json'), {});
  await writeJson(path.join(root, 'docs', 'package.json'), {});
  const cmds = await detectVerifyCommands(root);
  assert.deepEqual(cmds.map((c) => c.command), ['npx tsc --noEmit -p client', 'npx tsc --noEmit -p server', 'npm run lint', 'npm run test']);
  assert.equal(cmds[0].name, 'typecheck client');
});

test('workspaces: a root type check wins; globs list package folders; odd patterns are skipped', async () => {
  const root = await tmpDir('verify-ws2-');
  await writeJson(path.join(root, 'package.json'), { workspaces: { packages: ['packages/*', '!packages/skip', '../outside', 'apps/{a,b}'] }, scripts: { typecheck: 'tsc -b' } });
  await writeJson(path.join(root, 'packages', 'one', 'package.json'), {});
  await writeJson(path.join(root, 'packages', 'two', 'package.json'), {});
  await fs.mkdir(path.join(root, 'packages', 'not-a-package'), { recursive: true });
  assert.deepEqual(await workspaceDirs(root, JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))), ['packages/one', 'packages/two']);
  const cmds = await detectVerifyCommands(root);
  assert.deepEqual(cmds.map((c) => c.command), ['npm run typecheck']);
});

test('workspaces: pnpm-workspace.yaml is read', async () => {
  const root = await tmpDir('verify-ws3-');
  await writeJson(path.join(root, 'package.json'), {});
  await fs.writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'web'\n  - \"api\" # the API\n");
  await writeJson(path.join(root, 'web', 'package.json'), {});
  await writeJson(path.join(root, 'api', 'package.json'), {});
  assert.deepEqual(await workspaceDirs(root, {}), ['api', 'web']);
});
