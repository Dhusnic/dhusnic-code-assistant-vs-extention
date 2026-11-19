import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { addSkillFile, copySkill, createSkill, findSkill, lintSkill, loadSkills, parseSkill, updateSkill } from '../core/skills';
import { tmpDir } from './helpers';

const GOOD = { name: 'release-notes', description: 'Write release notes from git history. Use when the user asks for a changelog or release notes.', instructions: 'Run git log $ARGUMENTS and group changes by type.', argumentHint: '[from..to]' };
const levels = (l: Array<{ level: string; message: string }>) => l.map((x) => `${x.level}:${x.message.slice(0, 30)}`);

test('lint: a good skill has no findings', () => {
  assert.deepEqual(lintSkill(GOOD), []);
});

test('lint: flags what makes a skill unusable or ignored', () => {
  const l = lintSkill({ ...GOOD, description: 'Release notes thing', argumentHint: '' });
  assert.ok(l.some((x) => x.level === 'warning' && /short/.test(x.message)));
  assert.ok(l.some((x) => x.level === 'warning' && /WHEN to use it/.test(x.message)));
  assert.ok(l.some((x) => x.level === 'tip' && /argument hint/.test(x.message)));
  assert.ok(lintSkill({ ...GOOD, name: 'review' }).some((x) => x.level === 'error' && /built-in command/.test(x.message)));
  assert.ok(lintSkill({ ...GOOD, allowedTools: ['read_file', 'teleport'] }).some((x) => /Unknown tools: teleport/.test(x.message)));
  assert.ok(lintSkill({ ...GOOD, userInvocable: false, modelInvocable: false }).some((x) => x.level === 'error' && /Nobody could run/.test(x.message)));
  assert.ok(lintSkill({ ...GOOD, instructions: 'No placeholders here at all.' }).some((x) => x.level === 'tip' && /never use \$ARGUMENTS/.test(x.message)));
  assert.ok(lintSkill({ ...GOOD, instructions: 'x'.repeat(20001) }).some((x) => /Very long/.test(x.message)));
  assert.ok(lintSkill(GOOD, [{ name: 'release-notes' }]).some((x) => /already exists/.test(x.message)));
  assert.deepEqual(levels(lintSkill(GOOD, [{ name: 'release-notes' }], 'release-notes')), [], 'editing a skill does not clash with itself');
  assert.ok(!lintSkill({ ...GOOD, description: 'Deploys the app to staging environment safely and verifies it', modelInvocable: false }).some((x) => /WHEN/.test(x.message)), 'manual-only skills need no "when"');
});

async function setup() {
  const base = path.join(await tmpDir('life-'), '.claude');
  await createSkill(base, GOOD);
  const skill = findSkill((await loadSkills([{ base, source: 'project' }])).skills, 'release-notes')!;
  return { base, skill };
}

test('update: rewrites from the form, keeps frontmatter it does not manage, renames the folder', async () => {
  const { base, skill } = await setup();
  const raw = await fs.readFile(skill.file, 'utf8');
  await fs.writeFile(skill.file, raw.replace('---\n\n', 'model: qwen3-coder-next\ncustom-list:\n  - a\n  - b\n---\n\n'));
  await addSkillFile(skill, 'templates/notes.md', '# Notes');
  const file = await updateSkill(skill, { ...GOOD, name: 'changelog', description: 'Write the changelog from git history. Use when asked for release notes.', modelInvocable: false });
  assert.equal(file, path.join(base, 'skills', 'changelog', 'SKILL.md'));
  await assert.rejects(fs.stat(skill.dir), 'old folder moved');
  const text = await fs.readFile(file, 'utf8');
  assert.match(text, /model: qwen3-coder-next/);
  assert.match(text, /custom-list:\n {2}- a\n {2}- b/);
  assert.match(text, /disable-model-invocation: true/);
  const parsed = parseSkill(text, { dirName: 'changelog', source: 'project', kind: 'skill', dir: '', file: '' }) as any;
  assert.equal(parsed.name, 'changelog');
  assert.equal(parsed.modelInvocable, false);
  assert.equal(await fs.readFile(path.join(base, 'skills', 'changelog', 'templates', 'notes.md'), 'utf8'), '# Notes', 'supporting files move with it');
  const again = findSkill((await loadSkills([{ base, source: 'project' }])).skills, 'changelog')!;
  await createSkill(base, { ...GOOD, name: 'taken' });
  await assert.rejects(updateSkill(again, { ...GOOD, name: 'taken' }), /already exists/);
  await assert.rejects(updateSkill(again, { ...GOOD, name: 'Bad Name' }), /Name/);
});

test('copy: personal ↔ project with supporting files, optional rename, never overwrites', async () => {
  const { skill } = await setup();
  await addSkillFile(skill, 'scripts/run.py', 'print(1)');
  const fresh = findSkill((await loadSkills([{ base: path.dirname(skill.dir).replace(/[\\/]skills$/, ''), source: 'project' }])).skills, 'release-notes')!;
  const personal = path.join(await tmpDir('home-'), '.claude');
  const f = await copySkill(fresh, personal);
  assert.equal(await fs.readFile(path.join(path.dirname(f), 'scripts', 'run.py'), 'utf8'), 'print(1)');
  await assert.rejects(copySkill(fresh, personal), /already exists/);
  const renamed = await copySkill(fresh, personal, 'my-notes');
  assert.match(await fs.readFile(renamed, 'utf8'), /^---\nname: my-notes\n/);
  const back = await loadSkills([{ base: personal, source: 'user' }]);
  assert.deepEqual(back.skills.map((s) => s.name).sort(), ['my-notes', 'release-notes']);
});

test('copy: a legacy command becomes a real skill folder', async () => {
  const base = path.join(await tmpDir('cmd-'), '.claude');
  await fs.mkdir(path.join(base, 'commands'), { recursive: true });
  await fs.writeFile(path.join(base, 'commands', 'standup.md'), 'Write my standup from git log.');
  const cmd = findSkill((await loadSkills([{ base, source: 'project' }])).skills, 'standup')!;
  const f = await copySkill(cmd, base, 'standup-notes');
  const s = findSkill((await loadSkills([{ base, source: 'project' }])).skills, 'standup-notes')!;
  assert.equal(s.kind, 'skill');
  assert.equal(path.dirname(f), s.dir);
});

test('supporting files: written inside the skill folder only', async () => {
  const { skill } = await setup();
  const p = await addSkillFile(skill, 'docs/ref.md', 'ref');
  assert.equal(p, path.join(skill.dir, 'docs', 'ref.md'));
  for (const bad of ['../escape.md', 'a/../../x.md', '', 'C:/Windows/x.md', 'SKILL.md', 'a//b.md']) {
    await assert.rejects(addSkillFile(skill, bad, 'x'), /relative path|escapes|SKILL\.md/, bad);
  }
  assert.deepEqual((await loadSkills([{ base: path.dirname(path.dirname(skill.dir)), source: 'project' }])).skills[0].files, ['docs/ref.md']);
});

test('UI + host: edit form, live checks, test run, duplicate, supporting files are all wired', async () => {
  const root = path.join(__dirname, '..', '..');
  const js = await fs.readFile(path.join(root, 'media', 'session.js'), 'utf8');
  for (const msg of ["type: 'getSkill'", "type: 'lintSkill'", "type: 'updateSkill'", "type: 'testSkill'", "type: 'copySkill'", "type: 'addSkillFile'"]) { assert.ok(js.includes(msg), msg); }
  assert.match(js, /function renderSkillForm\(body, detail\)/, 'one form for create and edit');
  assert.match(js, /\$\('sfCreate'\)\.disabled = hasErrors;/, 'errors block saving; warnings do not');
  assert.match(js, /Adding a supporting file refreshes the detail: update only the file list/);
  assert.match(js, /data-sk="test"/);
  const panel = await fs.readFile(path.join(root, 'src', 'host', 'sessionPanel.ts'), 'utf8');
  for (const c of ["case 'getSkill'", "case 'lintSkill'", "case 'updateSkill'", "case 'copySkill'", "case 'addSkillFile'", "case 'testSkill'"]) { assert.ok(panel.includes(c), c); }
  const hub = await fs.readFile(path.join(root, 'src', 'host', 'hub.ts'), 'utf8');
  assert.match(hub, /issues: s\.kind === 'skill' \? lintSkill\(/, 'the list shows a warning count per skill');
});

test('expanded skills tell the agent the skill folder is read-only reference material', async () => {
  const { expandSkill } = await import('../core/skills');
  const s = { ...(parseSkill('---\nname: t\ndescription: demo skill. Use when testing.\n---\nUse templates/x.md.', { dirName: 't', source: 'project', kind: 'skill', dir: '/r/.claude/skills/t', file: '/r/.claude/skills/t/SKILL.md' }) as any), files: ['templates/x.md'] };
  const e = expandSkill(s, '');
  assert.match(e, /skill folder is read-only reference: never edit or create files inside it/);
  assert.match(e, /Put results in your reply or in the project files/);
});
