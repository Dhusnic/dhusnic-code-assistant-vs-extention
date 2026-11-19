import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  SKILL_TOOL, createSkill, deleteSkill, expandSkill, findSkill, loadSkills, parseFrontmatter, parseSkill,
  renderSkillFile, setModelInvocation, skillToolSpec, validateNewSkill,
} from '../core/skills';
import { tmpDir } from './helpers';

const CLAUDE_SKILL = `---
name: pr-creation
description: Raise an Azure DevOps pull request for the current branch. Use when the user asks to create or open a PR.
argument-hint: "[work item id]"
allowed-tools: Bash, Read
---

Run \`git push\`, then open the PR linked to work item $ARGUMENTS.
`;

async function tree(files: Record<string, string>): Promise<string> {
  const root = await tmpDir('skills-');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}
const meta = (dir = '/x', file = '/x/SKILL.md') => ({ dirName: 'dir-name', source: 'project' as const, kind: 'skill' as const, dir, file });

test('parses a Claude Code SKILL.md unchanged (tool names mapped, hint, invocation flags)', () => {
  const s = parseSkill(CLAUDE_SKILL, meta()) as any;
  assert.equal(s.name, 'pr-creation');
  assert.match(s.description, /pull request/);
  assert.equal(s.argumentHint, '[work item id]');
  assert.deepEqual(s.allowedTools, ['run_command', 'read_file']);
  assert.equal(s.modelInvocable, true);
  assert.equal(s.userInvocable, true);
  assert.match(s.body, /^Run `git push`/);
});

test('flags, name fallback to the folder, and errors that tell you how to fix the file', () => {
  const s = parseSkill('---\ndescription: does things well enough\ndisable-model-invocation: true\nuser-invocable: false\n---\nDo it.', meta()) as any;
  assert.equal(s.name, 'dir-name');
  assert.equal(s.modelInvocable, false);
  assert.equal(s.userInvocable, false);
  assert.match((parseSkill('---\nname: x\n---\nbody', meta()) as any).error, /no description/);
  assert.match((parseSkill('---\nname: bad name!\ndescription: d\n---\nbody', meta()) as any).error, /invalid skill name/);
  assert.match((parseSkill('---\nname: ok\ndescription: d\n---\n', meta()) as any).error, /no instructions/);
  assert.equal(parseFrontmatter('no frontmatter').hasFrontmatter, false);
});

test('loading: project overrides personal, legacy commands are user-only, _shared folders skipped, supporting files listed', async () => {
  const user = await tree({
    'skills/review/SKILL.md': '---\nname: review\ndescription: personal review flow\n---\nPersonal.',
    'commands/standup.md': 'Write my standup notes from git log.\n\nMore text.',
  });
  const project = await tree({
    'skills/review/SKILL.md': '---\nname: review\ndescription: team review flow for this repo\n---\nTeam.',
    'skills/review/checklist.md': '- item',
    'skills/review/scripts/run.py': 'print(1)',
    'skills/_shared/helper.py': '',
    'skills/broken/SKILL.md': '---\nname: broken\n---\nno description',
    'skills/empty-dir/notes.txt': 'not a skill',
  });
  const { skills, errors } = await loadSkills([{ base: user, source: 'user' }, { base: project, source: 'project' }]);
  assert.deepEqual(skills.map((s) => [s.name, s.source, s.kind]), [['review', 'project', 'skill'], ['standup', 'user', 'command']]);
  assert.equal(findSkill(skills, '/Review')!.description, 'team review flow for this repo');
  assert.deepEqual(findSkill(skills, 'review')!.files.sort(), ['checklist.md', 'scripts/run.py']);
  const cmd = findSkill(skills, 'standup')!;
  assert.equal(cmd.description, 'Write my standup notes from git log.');
  assert.equal(cmd.modelInvocable, false, 'legacy commands are only run by the user');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /broken.*no description/);
});

test('expanding: $ARGUMENTS and $1..$9 substituted; arguments appended when not referenced; base dir and files listed', () => {
  const s = { ...(parseSkill(CLAUDE_SKILL, meta('/repo/.claude/skills/pr-creation')) as any), files: ['template.md'] };
  const e = expandSkill(s, '46936');
  assert.match(e, /work item 46936\./);
  assert.match(e, /Base directory: \/repo\/\.claude\/skills\/pr-creation/);
  assert.match(e, /template\.md/);
  const p = parseSkill('---\nname: p\ndescription: positional args demo\n---\nCompare $1 with $2.', meta()) as any;
  assert.match(expandSkill(p, 'main dev'), /Compare main with dev\./);
  const n = parseSkill('---\nname: n\ndescription: no placeholders here\n---\nDo the thing.', meta()) as any;
  assert.match(expandSkill(n, 'extra info'), /Do the thing\.\n\nARGUMENTS: extra info/);
  assert.doesNotMatch(expandSkill(n, ''), /ARGUMENTS/);
});

test('the skill tool lists only agent-usable skills, with names as an enum; none → no tool', () => {
  const a = parseSkill(CLAUDE_SKILL, meta()) as any;
  const b = parseSkill('---\nname: manual-only\ndescription: only when asked\ndisable-model-invocation: true\n---\nx', meta()) as any;
  const spec = skillToolSpec([a, b])!;
  assert.equal(spec.function.name, SKILL_TOOL);
  assert.match(spec.function.description, /- pr-creation: Raise an Azure DevOps pull request/);
  assert.doesNotMatch(spec.function.description, /manual-only/);
  assert.deepEqual((spec.function.parameters as any).properties.name.enum, ['pr-creation']);
  assert.equal(skillToolSpec([b]), undefined);
});

test('authoring: validation, rendering (round-trips through the parser), create refuses to overwrite', async () => {
  assert.match(validateNewSkill({ name: 'Bad Name' })!, /Name/);
  assert.match(validateNewSkill({ name: 'ok', description: 'short' })!, /Description/);
  assert.match(validateNewSkill({ name: 'ok', description: 'a proper description', instructions: '' })!, /Instructions/);
  const spec = { name: 'release-notes', description: 'Write release notes: use when the user asks for a changelog', instructions: '1. Read git log\n2. Group changes', argumentHint: '<from-tag>', allowedTools: ['run_command', 'read_file'], modelInvocable: false };
  const text = renderSkillFile(spec);
  const parsed = parseSkill(text, meta()) as any;
  assert.deepEqual([parsed.name, parsed.description, parsed.argumentHint, parsed.modelInvocable], [spec.name, spec.description, '<from-tag>', false]);
  assert.deepEqual(parsed.allowedTools, ['run_command', 'read_file']);
  const base = await tmpDir('author-');
  const file = await createSkill(base, spec);
  assert.equal(file, path.join(base, 'skills', 'release-notes', 'SKILL.md'));
  await assert.rejects(createSkill(base, spec), /already exists/);
  await assert.rejects(createSkill(base, { ...spec, name: '../escape' }), /Name/);
});

test('toggling automatic use edits only that frontmatter line; delete removes the skill folder or command file', async () => {
  const base = await tree({ 'skills/demo/SKILL.md': '---\r\nname: demo\r\ndescription: demo skill for testing\r\nmodel: x\r\n---\r\nBody stays.\r\n', 'skills/demo/extra.md': 'x', 'commands/old.md': 'Old command' });
  const { skills } = await loadSkills([{ base, source: 'project' }]);
  const demo = findSkill(skills, 'demo')!;
  await setModelInvocation(demo, false);
  let text = await fs.readFile(demo.file, 'utf8');
  assert.match(text, /model: x\r\ndisable-model-invocation: true\r\n---\r\nBody stays\./);
  assert.equal((parseSkill(text, meta()) as any).modelInvocable, false);
  await setModelInvocation(demo, true);
  text = await fs.readFile(demo.file, 'utf8');
  assert.doesNotMatch(text, /disable-model-invocation/);
  assert.match(text, /Body stays\./);
  await deleteSkill(demo);
  await assert.rejects(fs.stat(demo.dir));
  await deleteSkill(findSkill(skills, 'old')!);
  await assert.rejects(fs.stat(path.join(base, 'commands', 'old.md')));
  await assert.rejects(setModelInvocation(findSkill(skills, 'old')!, true), /Legacy commands/);
});

test('your Infraon repo skills load as-is', async () => {
  const repoClaude = path.resolve(__dirname, '..', '..', '..', 'Infraon', '.claude');
  try { await fs.access(path.join(repoClaude, 'skills')); } catch { return; }
  const { skills, errors } = await loadSkills([{ base: repoClaude, source: 'project' }]);
  assert.ok(skills.length > 0, `loaded ${skills.length}; errors: ${errors.join('; ')}`);
  assert.ok(skills.every((s) => s.description && s.body));
});
