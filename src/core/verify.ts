/**
 * Finds the commands that check a project after code changes: a "## Verify" section of INFRAON.md / CLAUDE.md /
 * AGENTS.md, else detection from package.json, pyproject.toml, go.mod, Cargo.toml, pom.xml, Gradle or a Makefile.
 * In an npm/yarn/pnpm workspace whose root has no type check, each workspace package with a tsconfig.json gets its own
 * `npx tsc --noEmit -p <package>` (at most MAX_WORKSPACE_TYPECHECKS): otherwise type errors in a sub-package (for
 * example a React client next to a server) are never checked, since root lint and tests usually do not type-check.
 * A test command of a recognised runner also gets its related form (checks.ts relatedTestsFor), and findTestFiles
 * lists the project's test files that the related form of pytest and node --test maps changed files to.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { RelatedTests, relatedTestsFor } from './checks';
import { globToRegex } from './glob';

/** A command that checks the project after code changes (type check, lint or tests). */
export interface VerifyCommand {
  name: string; command: string; timeoutSeconds: number; source: string;
  /** How to run only the tests the changed files affect (checks.ts relatedTestsFor). */
  related?: RelatedTests;
}

const MAX_COMMANDS = 5;
const MAX_WORKSPACE_TYPECHECKS = 3;
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

/**
 * The package folders of an npm/yarn/pnpm workspace (package.json "workspaces", as an array or { packages }, or
 * pnpm-workspace.yaml), relative and with forward slashes. A trailing "/*" or "/**" lists that folder's children;
 * other glob forms and negations are skipped. Only folders that have a package.json, sorted, without duplicates.
 */
export async function workspaceDirs(root: string, pkg: any): Promise<string[]> {
  let patterns: unknown = pkg?.workspaces;
  if (patterns && !Array.isArray(patterns) && typeof patterns === 'object') { patterns = (patterns as { packages?: unknown }).packages; }
  const list: string[] = Array.isArray(patterns) ? patterns.filter((x): x is string => typeof x === 'string') : [];
  const pnpm = await readText(path.join(root, 'pnpm-workspace.yaml'));
  if (pnpm) { for (const m of pnpm.matchAll(/^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/gm)) { list.push(m[1]); } }
  const out = new Set<string>();
  for (const raw of list) {
    const p = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!p || p.startsWith('!') || p.startsWith('/') || p.split('/').includes('..')) { continue; }
    const star = /^(.*?)\/\*{1,2}$/.exec(p);
    if (star && !/[*?[{]/.test(star[1])) {
      let names: string[] = [];
      try { names = (await fs.readdir(path.join(root, star[1]), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* missing folder */ }
      for (const n of names) { if (await exists(path.join(root, star[1], n, 'package.json'))) { out.add(`${star[1]}/${n}`); } }
    } else if (!/[*?[{]/.test(p) && (await exists(path.join(root, p, 'package.json')))) {
      out.add(p);
    }
  }
  return [...out].sort();
}

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
    } else {
      for (const ws of (await workspaceDirs(root, pkg)).slice(0, MAX_WORKSPACE_TYPECHECKS)) {
        const wsPkg = await readText(path.join(root, ws, 'package.json'));
        const wsDeps = (() => { try { const j = JSON.parse(wsPkg ?? '{}'); return { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) }; } catch { return {}; } })();
        if (('typescript' in wsDeps || 'typescript' in deps) && (await exists(path.join(root, ws, 'tsconfig.json')))) {
          out.push({ name: `typecheck ${ws}`, command: `npx tsc --noEmit -p ${ws}`, timeoutSeconds: 300, source: `${ws}/tsconfig.json` });
        }
      }
    }
  }
  if (usable('lint')) { out.push({ name: 'lint', command: run('lint'), timeoutSeconds: 300, source: 'package.json' }); }
  if (usable('test') && !/no test specified/i.test(String(scripts.test))) {
    // A recognised runner can run only the tests the changed files affect: much faster in a big project.
    const exec = pm === 'yarn' ? 'yarn' : pm === 'pnpm' ? 'pnpm exec' : pm === 'bun' ? 'bunx' : 'npx';
    const related = relatedTestsFor(run('test'), String(scripts.test), exec);
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
  if (pytestSource) { out.push({ name: 'test', command: 'python -m pytest -q -x', timeoutSeconds: 600, source: pytestSource, related: relatedTestsFor('python -m pytest -q -x') }); }
  return out;
}

async function fromOthers(root: string, platform: NodeJS.Platform): Promise<VerifyCommand[]> {
  const out: VerifyCommand[] = [];
  if (await exists(path.join(root, 'go.mod'))) {
    out.push({ name: 'lint', command: 'go vet ./...', timeoutSeconds: 300, source: 'go.mod' });
    out.push({ name: 'test', command: 'go test ./...', timeoutSeconds: 600, source: 'go.mod', related: relatedTestsFor('go test ./...') });
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
      return [...new Set(cmds)].slice(0, MAX_COMMANDS).map((command) => {
        const related = relatedTestsFor(command);
        return { name: 'verify', command, timeoutSeconds: 600, source: file, ...(related ? { related } : {}) };
      });
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

/** Folders never searched for test files. Build output (out, dist) is searched: compiled tests may be what runs. */
const NO_TESTS_IN = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.next', 'target', '.tox']);

/**
 * The workspace files (relative, forward slashes) matching any of these globs, at most `limit`. Each glob is walked
 * from its fixed leading folders (out/test for "out/test/*.test.js"), so a narrow glob reads little of the disk.
 */
export async function findTestFiles(root: string, globs: string[], limit = 5000): Promise<string[]> {
  const out = new Set<string>();
  for (const glob of globs) {
    const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
    const parts = g.split('/');
    const fixed: string[] = [];
    while (parts.length > 1 && !/[*?{[]/.test(parts[0])) { fixed.push(parts.shift()!); }
    const re = globToRegex(g);
    const walk = async (rel: string): Promise<void> => {
      let ents;
      try { ents = await fs.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (out.size >= limit) { return; }
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!NO_TESTS_IN.has(e.name)) { await walk(r); } } else if (e.isFile() && re.test(r)) { out.add(r); }
      }
    };
    await walk(fixed.join('/'));
  }
  return [...out];
}
