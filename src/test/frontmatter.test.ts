import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseFrontmatter } from '../core/frontmatter';
import { loadSkills } from '../core/skills';
import { parseAgentFile } from '../core/agentTypes';

test('folded block scalar (>) joins lines with spaces — the format your Infraon skills use', () => {
  const { fm, body } = parseFrontmatter('---\nname: api\ndescription: >\n  Infraon backend API coding standards.\n  Use before editing Django code.\nother: x\n---\nBody');
  assert.equal(fm.description, 'Infraon backend API coding standards. Use before editing Django code.');
  assert.equal(fm.other, 'x');
  assert.equal(body, 'Body');
});

test('literal (|), chomping indicators, blank lines inside blocks, and paragraphs in folded blocks', () => {
  const { fm } = parseFrontmatter('---\na: |\n  line 1\n  line 2\nb: >-\n  first\n\n  second para\nc: |+\n    indented more\n---\n');
  assert.equal(fm.a, 'line 1\nline 2');
  assert.equal(fm.b, 'first\nsecond para');
  assert.equal(fm.c, 'indented more');
});

test('plain multi-line values, quotes (with escapes), lists, CRLF, BOM, comments', () => {
  const { fm } = parseFrontmatter('﻿---\r\n# comment\r\ndescription: starts here\r\n  and continues\r\nq: "say \\"hi\\""\r\ns: \'it\'\'s\'\r\ntools:\r\n  - Read\r\n  - Grep\r\nempty:\r\n---\r\nB');
  assert.equal(fm.description, 'starts here and continues');
  assert.equal(fm.q, 'say "hi"');
  assert.equal(fm.s, "it's");
  assert.deepEqual(fm.tools, ['Read', 'Grep']);
  assert.deepEqual(fm.empty, []);
});

test('agent definitions also accept block-scalar descriptions', () => {
  const t = parseAgentFile('---\nname: reviewer\ndescription: >\n  Reviews code.\n  Read-only.\ntools: Read, Grep\n---\nPrompt', 'project') as any;
  assert.equal(t.description, 'Reviews code. Read-only.');
  assert.deepEqual(t.tools, ['read_file', 'grep']);
});

test('real Infraon repo skills: every description is real text, not ">"', async () => {
  const base = path.resolve(__dirname, '..', '..', '..', 'Infraon', '.claude');
  try { await fs.access(path.join(base, 'skills')); } catch { return; }
  const { skills } = await loadSkills([{ base, source: 'project' }]);
  for (const s of skills) { assert.ok(s.description.length > 15 && !/^[>|][+-]?$/.test(s.description), `${s.name}: "${s.description}"`); }
});
