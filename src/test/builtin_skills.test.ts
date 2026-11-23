import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Agent } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { createImageViewTool, RENDER_DIR_PREFIX } from '../core/imageView';
import { StreamResult } from '../core/llm';
import { SKILL_TOOL, Skill, addSkillFile, deleteSkill, loadSkills, parseSkill, setModelInvocation, updateSkill } from '../core/skills';
import { DoctorDeps, ExecResult, SkillDoctor, checkSkill, environmentNote, formatDoctorReport, parseRequirement } from '../core/skillDoctor';
import { recordingUi, tmpDir } from './helpers';

/**
 * Built-in skills (resources/skills): the shipped bundle stays loadable and portable, built-ins rank lowest and are
 * read-only, the skill doctor finds tools the way Windows installs them, and the agent can read skill files and look at
 * rendered pages. No test spawns a real process or touches the network.
 */

const ROOT = path.join(__dirname, '..', '..');
const BUILTIN_BASE = path.join(ROOT, 'resources');
const EXPECTED = ['code-review', 'dataviz', 'docx', 'import-memory', 'init', 'pdf', 'pptx', 'pr-creation', 'run', 'security-review', 'simplify', 'skill-creator', 'update-config', 'xlsx'];

/* ------------------------------------------------------------------ the shipped bundle */

test('every built-in skill loads without errors, can be used by the agent and declares parseable requirements', async () => {
  const { skills, errors } = await loadSkills([{ base: BUILTIN_BASE, source: 'builtin' }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(skills.map((s) => s.name), EXPECTED);
  for (const s of skills) {
    assert.equal(s.source, 'builtin');
    assert.ok(s.modelInvocable, `${s.name} is usable by the agent`);
    // Skills that ship scripts must say what those need; prompt-only skills have nothing to declare.
    const hasScripts = await fs.stat(path.join(BUILTIN_BASE, 'skills', s.name, 'scripts')).then(() => true, () => false);
    if (hasScripts) { assert.ok(s.requires?.length, `${s.name} declares requires:`); }
    for (const r of s.requires ?? []) { assert.notEqual(parseRequirement(r).kind, 'unknown', `${s.name}: ${r}`); }
    assert.ok(s.description.length <= 1024, `${s.name} description fits the skill list`);
  }
});

test('vendored skills keep their license; the bundle documents its changes', async () => {
  for (const name of ['docx', 'pdf', 'pptx', 'xlsx', 'skill-creator']) {
    const lic = await fs.readFile(path.join(BUILTIN_BASE, 'skills', name, 'LICENSE.txt'), 'utf8');
    assert.match(lic, /Apache License\s+Version 2\.0/, name);
  }
  const notice = await fs.readFile(path.join(BUILTIN_BASE, 'skills', 'NOTICE.md'), 'utf8');
  assert.match(notice, /Changes made for Infraon/);
});

async function skillTexts(): Promise<Array<{ file: string; text: string }>> {
  const out: Array<{ file: string; text: string }> = [];
  for (const name of EXPECTED) {
    const dir = path.join(BUILTIN_BASE, 'skills', name);
    for (const f of await fs.readdir(dir)) {
      if (f.endsWith('.md')) { out.push({ file: `${name}/${f}`, text: await fs.readFile(path.join(dir, f), 'utf8') }); }
    }
  }
  return out;
}

test('skill instructions are free of claude.ai-only features, sandbox assumptions and bash-only commands', async () => {
  const banned: Array<[RegExp, string]> = [
    [/claude\.ai|Cowork|connector|artifact type|present_files/i, 'claude.ai / Cowork feature'],
    [/preinstalled/i, '"preinstalled" (nothing is preinstalled on a developer machine)'],
    [/\bclaude -p\b|run_loop|run_eval|improve_description|generate_report/, 'removed claude CLI tooling'],
    [/\/tmp\/|\bnohup\b|\bzip -|\bunzip [\w-]|python3 -c|\$PWD|2>\/dev\/null|\brm -f\b/, 'bash-only command'],
    [/^\s*(magick|convert) /m, 'ImageMagick (and `convert` is a disk tool on Windows)'],
  ];
  for (const { file, text } of await skillTexts()) {
    for (const [rx, what] of banned) { assert.doesNotMatch(text, rx, `${file}: ${what}`); }
  }
});

test('every script a skill tells the agent to run exists in that skill', async () => {
  for (const { file, text } of await skillTexts()) {
    const skill = file.split('/')[0];
    for (const m of text.matchAll(/(?:python|node)\s+(?:-m\s+)?(scripts[./][\w./-]+|eval-viewer\/[\w.-]+)/g)) {
      const rel = m[1].startsWith('scripts.') ? `${m[1].replace(/\./g, '/')}.py` : m[1];
      await fs.access(path.join(BUILTIN_BASE, 'skills', skill, rel)).catch(() => assert.fail(`${file} runs ${m[1]}, which does not exist`));
    }
  }
});

/* ------------------------------------------------------------------ precedence and read-only */

const SKILL = (desc: string) => `---\nname: docx\ndescription: ${desc}\n---\nBody.\n`;

test('a personal or project skill with the same name replaces the built-in one', async () => {
  const user = await tmpDir('skills-user-');
  await fs.mkdir(path.join(user, 'skills', 'docx'), { recursive: true });
  await fs.writeFile(path.join(user, 'skills', 'docx', 'SKILL.md'), SKILL('My own Word workflow. Use when the user asks for Word files.'));
  const { skills } = await loadSkills([{ base: BUILTIN_BASE, source: 'builtin' }, { base: user, source: 'user' }]);
  const docx = skills.find((s) => s.name === 'docx')!;
  assert.equal(docx.source, 'user');
  assert.match(docx.description, /My own Word workflow/);
  assert.ok(skills.some((s) => s.name === 'xlsx' && s.source === 'builtin'), 'other built-ins stay');
});

test('built-in skills cannot be edited, toggled, extended or deleted in place', async () => {
  const dir = await tmpDir('skills-builtin-');
  await fs.mkdir(path.join(dir, 'skills', 'docx'), { recursive: true });
  await fs.writeFile(path.join(dir, 'skills', 'docx', 'SKILL.md'), SKILL('Word files. Use when asked for .docx.'));
  const [s] = (await loadSkills([{ base: dir, source: 'builtin' }])).skills;
  const input = { name: 'docx', description: 'Changed description. Use when asked.', instructions: 'Changed instructions.' };
  await assert.rejects(setModelInvocation(s, false), /built-in skill/);
  await assert.rejects(updateSkill(s, input), /built-in skill/);
  await assert.rejects(addSkillFile(s, 'notes.md', 'x'), /built-in skill/);
  await assert.rejects(deleteSkill(s), /built-in skill/);
  assert.match(await fs.readFile(s.file, 'utf8'), /Word files/, 'the file is untouched');
});

test('requires: accepts a YAML list or a comma-separated string', () => {
  const meta = { dirName: 'x', source: 'project' as const, kind: 'skill' as const, dir: '/x', file: '/x/SKILL.md' };
  const a = parseSkill('---\nname: a\ndescription: Use when testing lists.\nrequires:\n  - python>=3.10\n  - cmd:soffice\n---\nBody', meta) as Skill;
  const b = parseSkill('---\nname: b\ndescription: Use when testing strings.\nrequires: python>=3.10, py:PIL=Pillow\n---\nBody', meta) as Skill;
  assert.deepEqual(a.requires, ['python>=3.10', 'cmd:soffice']);
  assert.deepEqual(b.requires, ['python>=3.10', 'py:PIL=Pillow']);
});

/* ------------------------------------------------------------------ skill doctor */

test('parseRequirement understands each requirement form', () => {
  assert.deepEqual(parseRequirement('python>=3.10'), { kind: 'python', min: [3, 10] });
  assert.deepEqual(parseRequirement('python'), { kind: 'python', min: [3] });
  assert.deepEqual(parseRequirement('py:PIL=Pillow'), { kind: 'py', module: 'PIL', pip: 'Pillow' });
  assert.deepEqual(parseRequirement('py:openpyxl'), { kind: 'py', module: 'openpyxl', pip: 'openpyxl' });
  assert.deepEqual(parseRequirement('cmd:soffice'), { kind: 'cmd', name: 'soffice' });
  assert.deepEqual(parseRequirement('npm:@scope/pkg'), { kind: 'npm', pkg: '@scope/pkg' });
  assert.equal(parseRequirement('apt:libreoffice').kind, 'unknown');
});

/** A Windows machine: an old python first on PATH, the py launcher with 3.12, the Store alias, LibreOffice outside PATH. */
function windowsDeps(over: Partial<DoctorDeps> = {}, modules: Record<string, boolean> = {}) {
  const files = new Set([
    'C:\\venv\\Scripts\\python.exe', 'C:\\Windows\\py.exe', 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe',
    'C:\\Program Files\\LibreOffice\\program\\soffice.com', 'D:\\repo\\node_modules\\docx\\package.json',
  ]);
  const calls: string[] = [];
  const exec = async (cmd: string, args: string[]): Promise<ExecResult> => {
    calls.push([cmd, ...args.slice(0, 1)].join(' '));
    if (args.includes('-c') && args[args.indexOf('-c') + 1].includes('version_info')) {
      return { code: 0, stdout: cmd.endsWith('py.exe') ? '3.12.4\n' : '3.9.13\n', stderr: '' };
    }
    if (args.includes('-c')) {
      const mods = args.slice(args.indexOf('-c') + 2);
      return { code: 0, stdout: JSON.stringify(Object.fromEntries(mods.map((m) => [m, !!modules[m]]))), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const deps: DoctorDeps = {
    platform: 'win32',
    env: { PATH: 'C:\\venv\\Scripts;C:\\Windows;C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps', PATHEXT: '.COM;.EXE', ProgramFiles: 'C:\\Program Files', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
    nodeRoots: ['D:\\repo'],
    exists: async (p) => files.has(p),
    exec,
    ...over,
  };
  return { deps, calls };
}

test('doctor picks the Python that meets the minimum, finds LibreOffice outside PATH and gives install hints', async () => {
  const { deps } = windowsDeps({}, { openpyxl: true, pandas: false });
  const c = await checkSkill({ name: 'xlsx', requires: ['python>=3.10', 'py:openpyxl', 'py:pandas', 'cmd:soffice', 'cmd:pdftoppm', 'npm:docx', 'npm:pptxgenjs'] }, deps);
  const by = Object.fromEntries(c.results.map((r) => [r.requirement, r]));
  assert.deepEqual(c.python, { cmd: ['py', '-3'], version: '3.12.4' }, 'the 3.9 venv python is skipped');
  assert.equal(by['py:openpyxl'].ok, true);
  assert.equal(by['py:pandas'].ok, false);
  assert.equal(by['py:pandas'].install, 'py -3 -m pip install pandas');
  assert.equal(by['cmd:soffice'].detail, 'C:\\Program Files\\LibreOffice\\program\\soffice.com');
  assert.equal(by['cmd:pdftoppm'].ok, false);
  assert.match(by['cmd:pdftoppm'].install!, /winget install/);
  assert.equal(by['npm:docx'].ok, true);
  assert.equal(by['npm:pptxgenjs'].install, 'npm install pptxgenjs');
});

test('doctor reports an interpreter that is too old instead of using it', async () => {
  const { deps } = windowsDeps({ exists: async (p) => p === 'C:\\venv\\Scripts\\python.exe' });
  const c = await checkSkill({ name: 'pdf', requires: ['python>=3.10', 'py:pypdf'] }, deps);
  assert.equal(c.python, undefined);
  assert.match(c.results[0].detail, /only older Python found: python 3\.9\.13/);
  assert.match(c.results[1].detail, /needs a Python interpreter first/);
});

test('the Store python alias is never used', async () => {
  const { deps, calls } = windowsDeps({ exists: async (p) => p.includes('WindowsApps') });
  const c = await checkSkill({ name: 'x', requires: ['python>=3.10'] }, deps);
  assert.equal(c.results[0].ok, false);
  assert.deepEqual(calls, [], 'nothing was spawned');
});

test('the environment note tells the agent how to run things here and what is missing', async () => {
  const { deps } = windowsDeps();
  const c = await checkSkill({ name: 'docx', requires: ['python>=3.10', 'cmd:pandoc'] }, deps);
  const note = environmentNote(c, 'win32');
  assert.match(note, /<environment checked="docx">/);
  assert.match(note, /Windows PowerShell 5\.1/);
  assert.match(note, /as `py -3` \(Python 3\.12\.4\)/);
  assert.match(note, /cmd:pandoc: Pandoc not found on PATH\. Install: `winget install --id JohnMacFarlane\.Pandoc`/);
  assert.match(note, /ask before installing anything/);
  assert.equal(environmentNote({ skill: 'x', results: [{ requirement: 'cmd:git', ok: true, detail: '/usr/bin/git' }] }, 'linux'), '', 'nothing to say: no note');
  assert.match(formatDoctorReport([c]), /## docx: 1 missing[\s\S]*❌ `cmd:pandoc`/);
});

test('the doctor caches checks per skill and re-checks after clear()', async () => {
  const { deps, calls } = windowsDeps();
  let now = 0;
  const doctor = new SkillDoctor(() => deps, 1000, () => now);
  const skill = { name: 'x', requires: ['python>=3.10'], file: '/x/SKILL.md' };
  await doctor.check(skill);
  const first = calls.length;
  await doctor.check(skill);
  assert.equal(calls.length, first, 'served from cache');
  now = 2000;
  await doctor.check(skill);
  assert.ok(calls.length > first, 'expired entries are checked again');
});

/* ------------------------------------------------------------------ agent integration */

const callSkill = (name: string): StreamResult => ({ content: '', toolCalls: [{ id: 'S1', type: 'function', function: { name: SKILL_TOOL, arguments: JSON.stringify({ name }) } }] });
const text = (content: string): StreamResult => ({ content, toolCalls: [] });

function agentWith(skills: Skill[], skillEnvironment: (s: Skill) => Promise<string>) {
  let i = 0;
  const script = [callSkill('docx'), text('done')];
  return new Agent({
    root: '.', llm: async () => script[Math.min(i++, script.length - 1)],
    getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }),
    tools: () => createFsTools(), skills: () => skills, skillEnvironment,
  });
}
const DOCX: Skill = { ...(parseSkill('---\nname: docx\ndescription: Word files. Use when asked for .docx.\nrequires: cmd:soffice\n---\nRender it.', { dirName: 'docx', source: 'builtin', kind: 'skill', dir: '/ext/resources/skills/docx', file: '/ext/resources/skills/docx/SKILL.md' }) as Skill), files: [] };
const toolResult = (a: Agent) => String([...a.history].reverse().find((m) => m.role === 'tool')?.content ?? '');

test('loading a skill with requirements appends the environment note', async () => {
  const a = agentWith([DOCX], async () => '\n\n<environment checked="docx">\n- Missing: soffice\n</environment>');
  await a.send('make a word file', { mode: 'ask', effort: 'medium', model: 'm' }, recordingUi());
  assert.match(toolResult(a), /Render it\.[\s\S]*<environment checked="docx">/);
});

test('a failing requirements check never blocks the skill', async () => {
  const a = agentWith([DOCX], async () => { throw new Error('spawn failed'); });
  await a.send('make a word file', { mode: 'ask', effort: 'medium', model: 'm' }, recordingUi());
  assert.match(toolResult(a), /Skill "docx" loaded[\s\S]*Render it\./);
  assert.doesNotMatch(toolResult(a), /environment/);
});

/* ------------------------------------------------------------------ reading skill files and images */

test('read tools may open files in skill folders outside the workspace, write tools may not', async () => {
  const ws = await tmpDir('ws-');
  const skillDir = await tmpDir('skill-');
  await fs.writeFile(path.join(skillDir, 'FORMS.md'), 'form instructions');
  const other = await tmpDir('other-');
  await fs.writeFile(path.join(other, 'secret.txt'), 'no');
  const tools = createFsTools();
  const read = tools.find((t) => t.spec.function.name === 'read_file')!;
  const list = tools.find((t) => t.spec.function.name === 'list_dir')!;
  const write = tools.find((t) => t.spec.function.name === 'write_file')!;
  const ctx = { root: ws, signal: new AbortController().signal, snapshot: async () => undefined, readOnlyRoots: [skillDir] };
  assert.match(await read.run({ path: path.join(skillDir, 'FORMS.md') }, ctx), /form instructions/);
  assert.match(await list.run({ path: skillDir }, ctx), /FORMS\.md/);
  await assert.rejects(read.run({ path: path.join(other, 'secret.txt') }, ctx), /outside workspace/);
  await assert.rejects(read.run({ path: path.join(skillDir, '..', path.basename(other), 'secret.txt') }, ctx), /outside workspace/);
  await assert.rejects(write.run({ path: path.join(skillDir, 'FORMS.md'), content: 'x' }, ctx), /outside workspace/);
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

test('view_image sends workspace images to the vision model and falls back to OCR', async () => {
  const ws = await tmpDir('ws-img-');
  await fs.writeFile(path.join(ws, 'page-1.png'), PNG);
  const ctx = { root: ws, signal: new AbortController().signal, snapshot: async () => undefined };
  const seen: string[] = [];
  const vision = createImageViewTool({ vision: () => async (url, q) => { seen.push(url.slice(0, 22), q); return 'A title slide; nothing is cut off.'; } });
  assert.match(await vision.run({ path: 'page-1.png', question: 'Is text cut off?' }, ctx), /A title slide; nothing is cut off\./);
  assert.deepEqual(seen, ['data:image/png;base64,', 'Is text cut off?']);

  const ocr = createImageViewTool({ vision: () => undefined, ocr: async () => 'Quarterly results' });
  assert.match(await ocr.run({ path: 'page-1.png' }, ctx), /only the text was read \(OCR\)[\s\S]*Quarterly results/);

  const none = createImageViewTool({});
  assert.match(await none.run({ path: 'page-1.png' }, ctx), /no vision model or OCR engine/);
  await fs.writeFile(path.join(ws, 'notes.txt'), 'x');
  assert.match(await vision.run({ path: 'notes.txt' }, ctx), /not a supported image/);
});

test('view_image reads render folders in the temp directory, but nothing else outside the workspace', async () => {
  const ws = await tmpDir('ws-img2-');
  const tmp = await tmpDir('fake-tmp-');
  const renderDir = path.join(tmp, `${RENDER_DIR_PREFIX}deck-1234`);
  await fs.mkdir(renderDir);
  await fs.writeFile(path.join(renderDir, 'page-1.jpg'), PNG);
  await fs.writeFile(path.join(tmp, 'private.png'), PNG);
  const ctx = { root: ws, signal: new AbortController().signal, snapshot: async () => undefined };
  const tool = createImageViewTool({ vision: () => async () => 'ok', tmpDir: tmp });
  assert.match(await tool.run({ path: path.join(renderDir, 'page-1.jpg') }, ctx), /ok/);
  await assert.rejects(tool.run({ path: path.join(tmp, 'private.png') }, ctx), /outside workspace/);
  await assert.rejects(tool.run({ path: path.join(renderDir, '..', 'private.png') }, ctx), /outside workspace/);
});
