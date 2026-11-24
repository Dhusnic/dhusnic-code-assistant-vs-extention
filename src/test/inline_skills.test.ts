import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { Skill, findInlineSkills, inlineSkillPrompt } from '../core/skills';

/* A skill named anywhere in a message ("please /code-review the auth module") runs like one typed at the start, and the
 * composer's "/" popup opens wherever a "/" starts a word (the real onInputChange of media/session.js, run on fakes). */
const skill = (name: string, body = 'Do the thing for: $ARGUMENTS'): Skill => ({
  name, description: `${name} skill`, body, dir: `/skills/${name}`, file: `/skills/${name}/SKILL.md`, source: 'builtin', kind: 'skill',
  modelInvocable: true, userInvocable: true, files: [],
});
const SKILLS = [skill('code-review'), skill('simplify', 'Simplify the code.'), skill('docx')];

test('findInlineSkills: /name at the start or after a space, known skills only, each once, in order', () => {
  const names = (t: string) => findInlineSkills(t, SKILLS).map((s) => s.name);
  assert.deepEqual(names('please /code-review the auth module'), ['code-review']);
  assert.deepEqual(names('/simplify then /code-review, and /simplify again'), ['simplify', 'code-review']);
  assert.deepEqual(names('run /simplify.'), ['simplify'], 'trailing punctuation is not part of the name');
  assert.deepEqual(names('look in src/code-review and /usr/bin and http://x/docx'), [], 'paths and URLs are not skills');
  assert.deepEqual(names('use /CODE-REVIEW now'), ['code-review'], 'case does not matter');
  assert.deepEqual(names('try /unknown-skill'), []);
});

test('inlineSkillPrompt: the request without the tokens becomes each skill\'s arguments; attached files go once', () => {
  const found = findInlineSkills('please /code-review the auth module, then /simplify.', SKILLS);
  const p = inlineSkillPrompt('please /code-review the auth module, then /simplify.', found, '\n\nAttached files:\n<file path="a.ts">x</file>');
  assert.match(p, /^The user ran the skills \/code-review, \/simplify inside their message\. Their request: please the auth module, then \.\n/);
  assert.match(p, /<skill name="code-review">[\s\S]*Do the thing for: please the auth module, then \./);
  assert.match(p, /<skill name="simplify">[\s\S]*ARGUMENTS: please the auth module, then \./, 'a skill without $ARGUMENTS gets them appended');
  assert.equal(p.match(/Attached files:/g)?.length, 1);
  assert.ok(p.trimEnd().endsWith('</file>'));
  assert.match(inlineSkillPrompt('/docx', [SKILLS[2]]), /Their request: \(no further text\)/);
  // A /path that is not one of the found skills stays in the request.
  assert.match(inlineSkillPrompt('/simplify the files in /usr/lib', [SKILLS[1]]), /Their request: the files in \/usr\/lib\n/);
});

/* ---------- the composer popup ---------- */
const ROOT = fs.existsSync(path.join(__dirname, '..', '..', 'media', 'session.js')) ? path.join(__dirname, '..', '..') : process.cwd();
const JS = fs.readFileSync(path.join(ROOT, 'media', 'session.js'), 'utf8');
const COMMANDS = [{ name: 'compact', description: 'Summarize' }, { name: 'clear', description: 'Clear' }, { name: 'code-review', description: 'Review', skill: true, source: 'builtin' }, { name: 'simplify', description: 'Simplify', skill: true, source: 'builtin' }];

function popup() {
  const start = JS.indexOf('  function onInputChange()');
  const end = JS.indexOf('  function onFiles(');
  assert.ok(start > 0 && end > start, 'onInputChange found in session.js');
  const input = { value: '', selectionStart: 0, selectionEnd: 0, focus() { /* */ }, setSelectionRange(a: number, b: number) { this.selectionStart = a; this.selectionEnd = b; } };
  let shown: { items: Array<{ id: string }>; pick: (it: { id: string }) => void } | null = null;
  const env = {
    input, state: { commands: COMMANDS }, skillSourceLabel: () => 'built-in', post: () => undefined,
    openPopup: (items: Array<{ id: string }>, pick: (it: { id: string }) => void) => { shown = items.length ? { items, pick } : null; },
    hidePopup: () => { shown = null; }, autosize: () => undefined,
  };
  const api = new Function(...Object.keys(env), `let fileReq = 0;\n${JS.slice(start, end)}\nreturn { onInputChange };`)(...Object.values(env));
  /** Types `v` with the caret at `at` (default: the end, or where "|" is). */
  const type = (v: string) => { const at = v.includes('|') ? v.indexOf('|') : v.length; input.value = v.replace('|', ''); input.selectionStart = input.selectionEnd = at; api.onInputChange(); };
  return { input, type, shown: () => shown as typeof shown };
}

test('slash popup: commands and skills at the start, skills only inside a message', () => {
  const p = popup();
  p.type('/');
  assert.deepEqual(p.shown()!.items.map((i) => i.id), ['compact', 'clear', 'code-review', 'simplify']);
  p.type('/c');
  assert.deepEqual(p.shown()!.items.map((i) => i.id), ['compact', 'clear', 'code-review']);
  p.type('please /');
  assert.deepEqual(p.shown()!.items.map((i) => i.id), ['code-review', 'simplify'], 'built-in commands only work at the start');
  p.type('please /sim');
  assert.deepEqual(p.shown()!.items.map((i) => i.id), ['simplify']);
  p.type('see src/');
  assert.equal(p.shown(), null, 'a path does not open it');
  p.type('please /code-review ');
  assert.equal(p.shown(), null, 'a finished token closes it');
});

test('slash popup: picking replaces only the token at the caret and keeps the rest of the text', () => {
  const p = popup();
  p.type('please /co| the auth module');
  p.shown()!.pick({ id: 'code-review' });
  assert.equal(p.input.value, 'please /code-review the auth module');
  assert.equal(p.input.selectionStart, 'please /code-review '.length, 'caret after the inserted name and its space');

  p.type('fix it then /si|');
  p.shown()!.pick({ id: 'simplify' });
  assert.equal(p.input.value, 'fix it then /simplify ');

  p.type('/|explain this');
  p.shown()!.pick({ id: 'compact' });
  assert.equal(p.input.value, '/compact explain this');
});
