import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { Agent } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { ChatMessage, LlmFn, StreamResult } from '../core/llm';
import { SKILL_TOOL, Skill, parseSkill } from '../core/skills';
import { buildSessionHtml, buildSidebarHtml } from '../core/html';
import { COMMANDS, parseSlash } from '../core/slash';
import { recordingUi } from './helpers';

const ROOT = path.join(__dirname, '..', '..');
const mk = (text: string, name: string): Skill => ({ ...(parseSkill(text, { dirName: name, source: 'project', kind: 'skill', dir: `/repo/.claude/skills/${name}`, file: `/repo/.claude/skills/${name}/SKILL.md` }) as Skill), files: [] });
const RELEASE = mk('---\nname: release-notes\ndescription: Write release notes from git history. Use when asked for a changelog.\n---\nRun git log $ARGUMENTS and group by type.', 'release-notes');
const MANUAL = mk('---\nname: deploy\ndescription: Deploy to staging. Only when the user explicitly runs it.\ndisable-model-invocation: true\n---\nDeploy.', 'deploy');
const text = (content: string): StreamResult => ({ content, toolCalls: [] });
const call = (args: object): StreamResult => ({ content: '', toolCalls: [{ id: 'S1', type: 'function', function: { name: SKILL_TOOL, arguments: JSON.stringify(args) } }] });

function agentWith(script: StreamResult[], skills: Skill[]) {
  let i = 0; const offered: any[] = []; const calls: ChatMessage[][] = [];
  const llm: LlmFn = async (_c, msgs, tools) => { offered.push(tools); calls.push(msgs); return script[Math.min(i++, script.length - 1)]; };
  const agent = new Agent({ root: '.', llm, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => createFsTools(), skills: () => skills });
  return { agent, offered, calls };
}
const lastTool = (m: ChatMessage[]) => String([...m].reverse().find((x) => x.role === 'tool')?.content ?? '');

test('the agent sees only agent-usable skills (name + description), not their full text', async () => {
  const a = agentWith([text('ok')], [RELEASE, MANUAL]);
  await a.agent.send('hi', { mode: 'ask', effort: 'medium', model: 'm' }, recordingUi());
  const spec = a.offered[0].find((t: any) => t.function.name === SKILL_TOOL);
  assert.ok(spec);
  assert.match(spec.function.description, /- release-notes: Write release notes/);
  assert.doesNotMatch(spec.function.description, /deploy/);
  assert.doesNotMatch(spec.function.description, /group by type/, 'full instructions load on demand only');
  const none = agentWith([text('ok')], [MANUAL]);
  await none.agent.send('hi', { mode: 'ask', effort: 'medium', model: 'm' }, recordingUi());
  assert.ok(!none.offered[0].some((t: any) => t.function.name === SKILL_TOOL), 'no usable skills → no tool');
});

test('loading a skill returns its instructions with arguments, then the agent follows them', async () => {
  const a = agentWith([call({ name: 'release-notes', args: 'v1.0..v1.1' }), text('notes written')], [RELEASE]);
  const ui = recordingUi();
  await a.agent.send('write a changelog for 1.1', { mode: 'ask', effort: 'medium', model: 'm' }, ui);
  const res = lastTool(a.agent.history);
  assert.match(res, /Skill "release-notes" loaded\. Follow these instructions/);
  assert.match(res, /Run git log v1\.0\.\.v1\.1 and group by type\./);
  assert.match(res, /Base directory: \/repo\/\.claude\/skills\/release-notes/);
  assert.ok(ui.events.includes('start:skill'));
  assert.ok(ui.events.some((e) => e.startsWith('end:ok:Loaded skill "release-notes"')), 'the transcript shows a short note, not the whole text');
});

test('manual-only and unknown skills are refused with guidance', async () => {
  const a = agentWith([call({ name: 'deploy' }), text('ok')], [RELEASE, MANUAL]);
  await a.agent.send('deploy', { mode: 'ask', effort: 'medium', model: 'm' }, recordingUi());
  assert.match(lastTool(a.agent.history), /can only be started by the user \(\/deploy\)/);
  const b = agentWith([call({ name: 'nope' }), text('ok')], [RELEASE]);
  await b.agent.send('x', { mode: 'ask', effort: 'medium', model: 'm' }, recordingUi());
  assert.match(lastTool(b.agent.history), /no skill named "nope"\. Available: release-notes/);
});

test('/skill-name args parses as a (non-built-in) slash command, including underscores', () => {
  assert.deepEqual(parseSlash('/release-notes v1.0..v1.1'), { name: 'release-notes', args: 'v1.0..v1.1', known: false });
  assert.equal(parseSlash('/fill_feature 46936')!.name, 'fill_feature');
  assert.ok(COMMANDS.some((c) => c.name === 'skills'));
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'host', 'sessionPanel.ts'), 'utf8');
  assert.match(panel, /const skill = slash && !slash\.known \? findSkill\(this\.hub\.skills, slash\.name\) : undefined;/);
  assert.match(panel, /The user ran the skill \/\$\{skill\.name\}/);
});

test('UI: Skills pill, manager (list / new form / create with AI), slash popup shows skills, sidebar section', () => {
  const html = buildSessionHtml({ nonce: 'n', cspSource: 'c', cssUri: 'a', jsUri: 'b', mdUri: 'd', logoSvg: '<svg></svg>' });
  assert.match(html, /id="skillsPill"/);
  const js = fs.readFileSync(path.join(ROOT, 'media', 'session.js'), 'utf8');
  for (const s of ["type: 'listSkills'", "type: 'createSkill'", "type: 'toggleSkill'", "type: 'aiCreateSkill'", "file: 'editSkill'", "reveal: 'revealSkill'", "delete: 'deleteSkill'"]) { assert.ok(js.includes(s), s); }
  assert.match(js, /function renderSkillForm/);
  assert.match(js, /function renderSkillAi/);
  assert.match(js, /skill · ` : ''\}\$\{c\.description\}/, 'slash popup labels skills');
  // A "/" starting a word anywhere opens it (inline_skills.test.ts runs it); names may contain _ . :
  assert.match(js, /\/\(\^\|\\s\)\\\/\(\[\\w\.:-\]\*\)\$\/\.exec\(before\)/, 'popup accepts names with _ . :, at the start or after a space');
  const side = buildSidebarHtml({ nonce: 'n', cspSource: 'c', cssUri: 'a', jsUri: 'b', mdUri: 'd', logoSvg: '<svg></svg>' });
  for (const id of ['skillSec', 'skillList', 'skNewSide', 'skManageSide']) { assert.ok(side.includes(`id="${id}"`), id); }
});

test('UI: task steps show duration, a live timer for the running step, and per-action durations', () => {
  const js = fs.readFileSync(path.join(ROOT, 'media', 'session.js'), 'utf8');
  assert.match(js, /const stepTime = \(t\) =>/);
  assert.match(js, /class="ttime"/);
  assert.match(js, /class="tam"/);
  assert.match(js, /lastTodos\.some\(\(t\) => t\.status === 'in_progress'\)/, 'live tick while a step runs');
});
