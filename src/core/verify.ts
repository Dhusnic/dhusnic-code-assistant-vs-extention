import * as fs from 'fs/promises';
import * as path from 'path';

/** A command that checks the project after code changes (type check, lint or tests). */
export interface VerifyCommand {
  name: string; command: string; timeoutSeconds: number; source: string;
  /** A faster form that checks only what the changed files affect: {files} = changed source files, {dirs} = their folders as ./dir. */
  related?: string;
}

const MAX_COMMANDS = 5;
const CONFIG_FILES = ['INFRAON.md', 'CLAUDE.md', 'AGENTS.md'];
const SECTION_RE = /^(#{1,6})\s+(verify|verification|checks)\b/i;

/**
 * Parses a "## Verify" (or "## Checks") section of a project instructions file. Commands come from the lines of
 * fenced code blocks and from bullet items (`- \`cmd\`` or `- cmd`). Stops at the next heading of the same or higher level.
 */
export function parseVerifySection(markdown: string): string[] {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let level = 0;
  let inFence = false;
  for (const line of lines) {
    const fence = /^\s*(```|~~~)/.test(line);
    if (!level) {
      if (inFence) { if (fence) { inFence = false; } continue; }
      if (fence) { inFence = true; continue; }
      const m = SECTION_RE.exec(line);
      if (m) { level = m[1].length; }
      continue;
    }
    if (fence) { inFence = !inFence; continue; }
    if (inFence) {
      const cmd = line.trim();
      if (cmd && !cmd.startsWith('#')) { out.push(cmd.replace(/^\$\s+/, '')); }
      continue;
    }
    const h = /^(#{1,6})\s/.exec(line);
    if (h) {
      if (h[1].length <= level) { break; }
      continue;
    }
    const b = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (!b) { continue; }
    const item = b[1].trim();
    const code = /^`([^`]+)`/.exec(item);
    const cmd = (code ? code[1] : item).trim();
    if (cmd && !cmd.startsWith('#')) { out.push(cmd); }
  }
  return out;
}

async function readText(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, 'utf8'); } catch { return undefined; }
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

const isWatch = (script: string): boolean => /--watch\b|\swatch\b/.test(` ${script}`);

async function fromPackageJson(root: string): Promise<VerifyCommand[]> {
  const raw = await readText(path.join(root, 'package.json'));
  if (raw === undefined) { return []; }
  let pkg: any;
  try { pkg = JSON.parse(raw); } catch { return []; }
  if (!pkg || typeof pkg !== 'object') { return []; }
  const scripts: Record<string, unknown> = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const pm = (await exists(path.join(root, 'pnpm-lock.yaml'))) ? 'pnpm'
    : (await exists(path.join(root, 'yarn.lock'))) ? 'yarn'
      : (await exists(path.join(root, 'bun.lockb'))) ? 'bun' : 'npm';
  const run = (s: string): string => (pm === 'yarn' ? `yarn ${s}` : `${pm} run ${s}`);
  const usable = (s: string): boolean => typeof scripts[s] === 'string' && !isWatch(String(scripts[s]));
  const out: VerifyCommand[] = [];
  const tc = ['typecheck', 'type-check', 'tsc', 'check-types'].find(usable);
  if (tc) {
    out.push({ name: 'typecheck', command: run(tc), timeoutSeconds: 300, source: 'package.json' });
  } else {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if ('typescript' in deps && (await exists(path.join(root, 'tsconfig.json')))) {
      out.push({ name: 'typecheck', command: 'npx tsc --noEmit -p .', timeoutSeconds: 300, source: 'tsconfig.json' });
    }
  }
  if (usable('lint')) { out.push({ name: 'lint', command: run('lint'), timeoutSeconds: 300, source: 'package.json' }); }
  if (usable('test') && !/no test specified/i.test(String(scripts.test))) {
    // Jest and Vitest can run only the tests that depend on the changed files: much faster in a big project.
    const t = String(scripts.test);
    const exec = run('test').startsWith('yarn') ? 'yarn' : run('test').startsWith('pnpm') ? 'pnpm exec' : run('test').startsWith('bun') ? 'bunx' : 'npx';
    const related = /\bjest\b/.test(t) && !/\s--/.test(t) ? `${exec} jest --findRelatedTests {files} --passWithNoTests`
      : /\bvitest\b/.test(t) && !/\s--/.test(t) ? `${exec} vitest related {files} --run --passWithNoTests`
        : undefined;
    out.push({ name: 'test', command: run('test'), timeoutSeconds: 600, source: 'package.json', ...(related ? { related } : {}) });
  }
  return out;
}

async function fromPython(root: string): Promise<VerifyCommand[]> {
  const pyproject = await readText(path.join(root, 'pyproject.toml'));
  const setupCfg = await readText(path.join(root, 'setup.cfg'));
  const out: VerifyCommand[] = [];
  if (pyproject?.includes('[tool.mypy')) { out.push({ name: 'typecheck', command: 'mypy .', timeoutSeconds: 600, source: 'pyproject.toml' }); }
  if (pyproject?.includes('[tool.ruff')) { out.push({ name: 'lint', command: 'ruff check .', timeoutSeconds: 300, source: 'pyproject.toml' }); }
  const pytestSource = (await exists(path.join(root, 'pytest.ini'))) ? 'pytest.ini'
    : pyproject?.includes('[tool.pytest') ? 'pyproject.toml'
      : setupCfg?.includes('[tool:pytest]') ? 'setup.cfg'
        : (await exists(path.join(root, 'conftest.py'))) ? 'conftest.py' : undefined;
  if (pytestSource) { out.push({ name: 'test', command: 'python -m pytest -q -x', timeoutSeconds: 600, source: pytestSource }); }
  return out;
}

async function fromOthers(root: string, platform: NodeJS.Platform): Promise<VerifyCommand[]> {
  const out: VerifyCommand[] = [];
  if (await exists(path.join(root, 'go.mod'))) {
    out.push({ name: 'lint', command: 'go vet ./...', timeoutSeconds: 300, source: 'go.mod' });
    out.push({ name: 'test', command: 'go test ./...', timeoutSeconds: 600, source: 'go.mod', related: 'go test {dirs}' });
  }
  if (await exists(path.join(root, 'Cargo.toml'))) {
    out.push({ name: 'typecheck', command: 'cargo check', timeoutSeconds: 600, source: 'Cargo.toml' });
    out.push({ name: 'test', command: 'cargo test', timeoutSeconds: 600, source: 'Cargo.toml' });
  }
  if (await exists(path.join(root, 'pom.xml'))) {
    out.push({ name: 'test', command: 'mvn -q -B test', timeoutSeconds: 600, source: 'pom.xml' });
  }
  const gradle = (await exists(path.join(root, 'build.gradle'))) ? 'build.gradle'
    : (await exists(path.join(root, 'build.gradle.kts'))) ? 'build.gradle.kts' : undefined;
  if (gradle) {
    const command = platform === 'win32'
      ? ((await exists(path.join(root, 'gradlew.bat'))) ? '.\\gradlew.bat test' : 'gradle test')
      : ((await exists(path.join(root, 'gradlew'))) ? './gradlew test' : 'gradle test');
    out.push({ name: 'test', command, timeoutSeconds: 600, source: gradle });
  }
  return out;
}

/** Commands that check the project after code changes, in order: typecheck/lint first (fast), then tests. */
export async function detectVerifyCommands(root: string, platform: NodeJS.Platform = process.platform): Promise<VerifyCommand[]> {
  for (const file of CONFIG_FILES) {
    const text = await readText(path.join(root, file));
    if (text === undefined) { continue; }
    const cmds = parseVerifySection(text);
    if (cmds.length) {
      return [...new Set(cmds)].slice(0, MAX_COMMANDS).map((command) => ({ name: 'verify', command, timeoutSeconds: 600, source: file }));
    }
  }
  const found = [...(await fromPackageJson(root)), ...(await fromPython(root)), ...(await fromOthers(root, platform))];
  if (!found.length) {
    const make = await readText(path.join(root, 'Makefile'));
    if (make && /^test:/m.test(make)) { found.push({ name: 'test', command: 'make test', timeoutSeconds: 600, source: 'Makefile' }); }
  }
  const rank = (c: VerifyCommand): number => (c.name === 'test' ? 1 : 0);
  const seen = new Set<string>();
  return found
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c)
    .filter((c) => (seen.has(c.command) ? false : (seen.add(c.command), true)))
    .slice(0, MAX_COMMANDS);
}

/** Markdown bullet list of the commands for the system prompt; '' when there are none. */
export function formatVerifyCommands(cmds: VerifyCommand[]): string {
  return cmds.map((c) => `- ${c.name}: \`${c.command}\` (from ${c.source})`).join('\n');
}
