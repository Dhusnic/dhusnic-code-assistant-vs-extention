import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Skill } from './skills';

/**
 * Skill doctor: checks what a skill's `requires:` frontmatter asks of this machine, so a skill fails up front with an
 * install hint instead of halfway through a task. Requirement grammar (one per list item):
 *   python>=3.10        a Python interpreter at least that version (also picks the command the agent should use)
 *   py:<module>[=<pip>] an importable Python module; <pip> is the package name when it differs (py:PIL=Pillow)
 *   cmd:<name>          an executable on PATH or in its usual install folder (soffice, pdftoppm, pandoc, qpdf, ...)
 *   npm:<package>       a Node package in the workspace's or the global node_modules
 * Everything runs locally (spawns `--version`-style probes and reads folders); nothing is installed and nothing goes
 * over the network. Process and file access are injected so tests run without a real Python or LibreOffice.
 */

export interface ExecResult { code: number; stdout: string; stderr: string }
export interface DoctorDeps {
  exec(cmd: string, args: string[], timeoutMs: number): Promise<ExecResult>;
  exists(p: string): Promise<boolean>;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Folders whose node_modules count for npm: requirements (the workspace roots). */
  nodeRoots: string[];
}

export interface PythonInfo { cmd: string[]; version: string }
export interface RequirementResult {
  requirement: string;
  ok: boolean;
  /** Where or what was found ("C:\...\soffice.com", "3.12.1"), or why it is missing. */
  detail: string;
  /** How to install it on this platform, when missing. */
  install?: string;
}
export interface SkillCheck { skill: string; results: RequirementResult[]; python?: PythonInfo }

type Parsed =
  | { kind: 'python'; min: number[] }
  | { kind: 'py'; module: string; pip: string }
  | { kind: 'cmd'; name: string }
  | { kind: 'npm'; pkg: string }
  | { kind: 'unknown' };

export function parseRequirement(req: string): Parsed {
  const r = req.trim();
  let m = /^python\s*(?:>=\s*(\d+(?:\.\d+){0,2}))?$/i.exec(r);
  if (m) { return { kind: 'python', min: (m[1] ?? '3').split('.').map(Number) }; }
  m = /^py:([A-Za-z_][\w.]*)(?:=([\w.[\]-]+))?$/.exec(r);
  if (m) { return { kind: 'py', module: m[1], pip: m[2] ?? m[1] }; }
  m = /^cmd:([\w.+-]+)$/.exec(r);
  if (m) { return { kind: 'cmd', name: m[1] }; }
  m = /^npm:((?:@[\w.-]+\/)?[\w.-]+)$/.exec(r);
  if (m) { return { kind: 'npm', pkg: m[1] }; }
  return { kind: 'unknown' };
}

const cmpVersion = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) { return d; } }
  return 0;
};

/* ------------------------------------------------------------------ install hints */

const SYSTEM_HINTS: Record<string, { label: string; win32: string; darwin: string; linux: string }> = {
  soffice: { label: 'LibreOffice', win32: 'winget install --id TheDocumentFoundation.LibreOffice', darwin: 'brew install --cask libreoffice', linux: 'sudo apt install libreoffice' },
  pdftoppm: { label: 'Poppler', win32: 'winget install --id oschwartz10612.Poppler (then add its bin folder to PATH)', darwin: 'brew install poppler', linux: 'sudo apt install poppler-utils' },
  pandoc: { label: 'Pandoc', win32: 'winget install --id JohnMacFarlane.Pandoc', darwin: 'brew install pandoc', linux: 'sudo apt install pandoc' },
  qpdf: { label: 'qpdf', win32: 'winget install --id QPDF.QPDF', darwin: 'brew install qpdf', linux: 'sudo apt install qpdf' },
  tesseract: { label: 'Tesseract OCR', win32: 'winget install --id UB-Mannheim.TesseractOCR', darwin: 'brew install tesseract', linux: 'sudo apt install tesseract-ocr' },
  node: { label: 'Node.js', win32: 'winget install --id OpenJS.NodeJS.LTS', darwin: 'brew install node', linux: 'sudo apt install nodejs npm' },
};
const PYTHON_HINT = { win32: 'winget install --id Python.Python.3.12', darwin: 'brew install python@3.12', linux: 'sudo apt install python3' };

const plat = (p: NodeJS.Platform): 'win32' | 'darwin' | 'linux' => (p === 'win32' || p === 'darwin' ? p : 'linux');
const quoteCmd = (cmd: string[]): string => cmd.map((c) => (/\s/.test(c) ? `"${c}"` : c)).join(' ');

/* ------------------------------------------------------------------ probes */

/** Usual install folders for tools whose installers do not touch PATH (LibreOffice on Windows and macOS above all). */
function knownLocations(name: string, deps: DoctorDeps): string[] {
  const e = deps.env;
  if (deps.platform === 'win32') {
    const bases = [e.ProgramFiles, e['ProgramFiles(x86)'], e.LOCALAPPDATA].filter((b): b is string => !!b);
    const per: Record<string, string[]> = {
      soffice: ['LibreOffice\\program\\soffice.com', 'LibreOffice\\program\\soffice.exe'],
      pandoc: ['Pandoc\\pandoc.exe'],
      tesseract: ['Tesseract-OCR\\tesseract.exe'],
    };
    return (per[name] ?? []).flatMap((rel) => bases.map((b) => path.win32.join(b, rel)));
  }
  if (deps.platform === 'darwin') {
    return name === 'soffice' ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice'] : [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
  }
  return name === 'soffice' ? ['/usr/bin/soffice', '/usr/local/bin/soffice', '/opt/libreoffice/program/soffice', '/snap/bin/libreoffice'] : [];
}

/** An executable on PATH (honouring PATHEXT on Windows), else in a known install folder, else SOFFICE_PATH for soffice. */
export async function findExecutable(name: string, deps: DoctorDeps): Promise<string | undefined> {
  const p = deps.platform === 'win32' ? path.win32 : path.posix;
  if (name === 'soffice' && deps.env.SOFFICE_PATH && await deps.exists(deps.env.SOFFICE_PATH)) { return deps.env.SOFFICE_PATH; }
  const dirs = (deps.env.PATH ?? deps.env.Path ?? '').split(deps.platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = deps.platform === 'win32' ? (deps.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((x) => x.toLowerCase()) : [''];
  for (const d of dirs) {
    // The Microsoft Store "python"/"python3"/"py" aliases open the Store instead of running anything.
    if (deps.platform === 'win32' && /\\WindowsApps\\?$/i.test(d) && /^py(thon[\d.]*)?$/i.test(name)) { continue; }
    for (const x of exts) {
      const f = p.join(d, name + x);
      if (await deps.exists(f)) { return f; }
    }
  }
  for (const f of knownLocations(name, deps)) { if (await deps.exists(f)) { return f; } }
  return undefined;
}

const PY_VERSION = 'import sys; print("%d.%d.%d" % sys.version_info[:3])';

/** The interpreter the agent should use: the first candidate meeting `min`, else the newest one found. */
export async function findPython(min: number[], deps: DoctorDeps): Promise<{ best?: PythonInfo; found: PythonInfo[] }> {
  const candidates: string[][] = deps.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']];
  const found: PythonInfo[] = [];
  for (const cmd of candidates) {
    const exe = await findExecutable(cmd[0], deps);
    if (!exe) { continue; }
    try {
      const r = await deps.exec(exe, [...cmd.slice(1), '-c', PY_VERSION], 15000);
      const v = /^(\d+\.\d+\.\d+)/.exec(r.stdout.trim())?.[1];
      if (r.code === 0 && v) {
        const info = { cmd, version: v };
        found.push(info);
        if (cmpVersion(v.split('.').map(Number), min) >= 0) { return { best: info, found }; }
      }
    } catch { /* not runnable */ }
  }
  return { found };
}

const FIND_MODULES = 'import importlib.util, json, sys\nout = {}\nfor m in sys.argv[1:]:\n    try:\n        out[m] = importlib.util.find_spec(m) is not None\n    except Exception:\n        out[m] = False\nprint(json.dumps(out))';

async function pythonModules(py: PythonInfo, modules: string[], deps: DoctorDeps): Promise<Record<string, boolean> | undefined> {
  if (!modules.length) { return {}; }
  const exe = await findExecutable(py.cmd[0], deps);
  if (!exe) { return undefined; }
  try {
    const r = await deps.exec(exe, [...py.cmd.slice(1), '-c', FIND_MODULES, ...modules], 30000);
    return r.code === 0 ? JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? '{}') : undefined;
  } catch { return undefined; }
}

function npmFolders(deps: DoctorDeps): string[] {
  const e = deps.env;
  const global = deps.platform === 'win32'
    ? [e.APPDATA ? path.win32.join(e.APPDATA, 'npm', 'node_modules') : '']
    : ['/usr/local/lib/node_modules', '/usr/lib/node_modules', '/opt/homebrew/lib/node_modules', e.HOME ? `${e.HOME}/.npm-global/lib/node_modules` : ''];
  const p = deps.platform === 'win32' ? path.win32 : path.posix;
  return [...deps.nodeRoots.map((r) => p.join(r, 'node_modules')), ...(e.NODE_PATH ?? '').split(deps.platform === 'win32' ? ';' : ':'), ...global].filter(Boolean);
}

/* ------------------------------------------------------------------ checks */

/** Checks one skill. `cache` shares interpreter and executable lookups across skills in one doctor run. */
export async function checkSkill(skill: Pick<Skill, 'name' | 'requires'>, deps: DoctorDeps, cache = new Map<string, Promise<unknown>>()): Promise<SkillCheck> {
  const reqs = skill.requires ?? [];
  const parsed = reqs.map((r) => ({ r, p: parseRequirement(r) }));
  const results: RequirementResult[] = [];
  const os_ = plat(deps.platform);
  const once = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) { cache.set(key, fn()); }
    return cache.get(key) as Promise<T>;
  };

  const needsPython = parsed.some((x) => x.p.kind === 'python' || x.p.kind === 'py');
  const min = parsed.reduce<number[]>((acc, x) => (x.p.kind === 'python' && cmpVersion(x.p.min, acc) > 0 ? x.p.min : acc), [3]);
  const py = needsPython ? await once(`python>=${min.join('.')}`, () => findPython(min, deps)) : undefined;
  const modules = parsed.flatMap((x) => (x.p.kind === 'py' ? [x.p.module] : []));
  const usable = py?.best;
  const mods = usable && modules.length ? await once(`mods:${quoteCmd(usable.cmd)}:${modules.join(',')}`, () => pythonModules(usable, modules, deps)) : undefined;

  for (const { r, p } of parsed) {
    switch (p.kind) {
      case 'python':
        if (usable) { results.push({ requirement: r, ok: true, detail: `${quoteCmd(usable.cmd)} (${usable.version})` }); }
        else {
          const seen = py?.found.map((f) => `${quoteCmd(f.cmd)} ${f.version}`).join(', ');
          results.push({ requirement: r, ok: false, detail: seen ? `only older Python found: ${seen}` : 'no Python interpreter found', install: PYTHON_HINT[os_] });
        }
        break;
      case 'py': {
        const ok = !!mods?.[p.module];
        results.push({
          requirement: r, ok,
          detail: ok ? 'importable' : usable ? 'not installed for this interpreter' : 'needs a Python interpreter first',
          install: ok ? undefined : `${usable ? quoteCmd(usable.cmd) : 'python'} -m pip install ${p.pip}`,
        });
        break;
      }
      case 'cmd': {
        const at = await once(`cmd:${p.name}`, () => findExecutable(p.name, deps));
        const hint = SYSTEM_HINTS[p.name];
        results.push(at ? { requirement: r, ok: true, detail: at }
          : { requirement: r, ok: false, detail: `${hint?.label ?? p.name} not found on PATH`, install: hint?.[os_] ?? `install ${p.name} and put it on PATH` });
        break;
      }
      case 'npm': {
        const folders = npmFolders(deps);
        const pathMod = deps.platform === 'win32' ? path.win32 : path.posix;
        let at: string | undefined;
        for (const f of folders) { if (await deps.exists(pathMod.join(f, p.pkg, 'package.json'))) { at = pathMod.join(f, p.pkg); break; } }
        results.push(at ? { requirement: r, ok: true, detail: at }
          : { requirement: r, ok: false, detail: 'not in the workspace or global node_modules (install it in the folder where the generator script runs)', install: `npm install ${p.pkg}` });
        break;
      }
      default:
        results.push({ requirement: r, ok: false, detail: 'unrecognised requirement (use python>=X, py:module, cmd:name or npm:package)' });
    }
  }
  return { skill: skill.name, results, python: usable };
}

/** The note appended to a skill's instructions when the agent loads it: how to run things here, and what is missing. */
export function environmentNote(check: SkillCheck, platform: NodeJS.Platform): string {
  const lines: string[] = [];
  if (platform === 'win32') {
    lines.push('- Commands run in Windows PowerShell 5.1: run one command per line (no `&&`, `||`, `2>/dev/null` or bash subshells), and use the Python helpers this skill ships instead of zip/unzip/rm.');
  }
  if (check.python) {
    lines.push(`- Python: run every \`python\`/\`python3\` command in these instructions as \`${quoteCmd(check.python.cmd)}\` (Python ${check.python.version}).`);
  }
  const missing = check.results.filter((r) => !r.ok);
  if (missing.length) {
    lines.push('- Missing on this machine (steps that need them will fail):');
    for (const m of missing) { lines.push(`  - ${m.requirement}: ${m.detail}${m.install ? `. Install: \`${m.install}\`` : ''}`); }
    lines.push('  Before a step that needs one of these, tell the user what is missing and ask before installing anything (Python and npm packages need their approval; system software they install themselves). Prefer an approach that works with what is installed.');
  }
  return lines.length ? `\n\n<environment checked="${check.skill}">\n${lines.join('\n')}\n</environment>` : '';
}

/** A Markdown report for the "Check Skill Requirements" command. */
export function formatDoctorReport(checks: SkillCheck[]): string {
  const out: string[] = ['# Skill requirements', ''];
  const relevant = checks.filter((c) => c.results.length);
  if (!relevant.length) { return '# Skill requirements\n\nNo loaded skill declares requirements (`requires:` in SKILL.md).\n'; }
  for (const c of relevant) {
    const bad = c.results.filter((r) => !r.ok).length;
    out.push(`## ${c.skill}: ${bad ? `${bad} missing` : 'ready'}`, '');
    for (const r of c.results) { out.push(`- ${r.ok ? '✅' : '❌'} \`${r.requirement}\`: ${r.detail}${r.install ? `<br>Install: \`${r.install}\`` : ''}`); }
    out.push('');
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ real dependencies */

export function nodeDoctorDeps(nodeRoots: string[]): DoctorDeps {
  return {
    platform: process.platform,
    env: process.env,
    nodeRoots,
    exists: async (p) => { try { await fs.access(p); return true; } catch { return false; } },
    exec: (cmd, args, timeoutMs) => new Promise((resolve) => {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, cwd: os.tmpdir() }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    }),
  };
}

/** Caches checks per skill for a while: loading a skill should not spawn Python every time. */
export class SkillDoctor {
  private cache = new Map<string, { at: number; check: Promise<SkillCheck> }>();
  constructor(private deps: () => DoctorDeps, private ttlMs = 10 * 60_000, private now: () => number = Date.now) {}

  check(skill: Pick<Skill, 'name' | 'requires' | 'file'>): Promise<SkillCheck> {
    const key = `${skill.file}|${(skill.requires ?? []).join(',')}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) { return hit.check; }
    const check = checkSkill(skill, this.deps());
    this.cache.set(key, { at: this.now(), check });
    return check;
  }

  async checkAll(skills: Array<Pick<Skill, 'name' | 'requires' | 'file'>>): Promise<SkillCheck[]> {
    this.clear();
    const shared = new Map<string, Promise<unknown>>();
    const deps = this.deps();
    const out: SkillCheck[] = [];
    for (const s of skills) {
      const check = checkSkill(s, deps, shared);
      this.cache.set(`${s.file}|${(s.requires ?? []).join(',')}`, { at: this.now(), check });
      out.push(await check);
    }
    return out;
  }

  clear(): void { this.cache.clear(); }
}
