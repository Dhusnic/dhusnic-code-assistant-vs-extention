import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { BUILTIN_AGENT_TYPES, findAgentType, loadAgentTypes, parseAgentFile, toolsForType } from '../core/agentTypes';
import { createFsTools } from '../core/fstools';
import { tmpDir } from './helpers';

const CLAUDE_STYLE = `---
name: security-reviewer
description: Reviews code changes for security issues. Use after editing auth or input handling.
tools: Read, Grep, Glob, Bash
model: inherit
---
You are a security reviewer. Report findings by severity.
`;

test('builtins mirror Claude Code: general-purpose, explore (read-only), plan (read-only), fork (inherits context)', () => {
  const by = Object.fromEntries(BUILTIN_AGENT_TYPES.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(by), ['general-purpose', 'explore', 'plan', 'researcher', 'tester', 'fork']);
  assert.equal(by.researcher.readOnly, true);
  assert.equal(by.explore.readOnly, true);
  assert.equal(by.plan.readOnly, true);
  assert.equal(by.fork.forkContext, true);
  assert.equal(by['general-purpose'].readOnly, undefined);
});

test('parses a Claude Code agent file unchanged, mapping tool names to ours', () => {
  const t = parseAgentFile(CLAUDE_STYLE, 'project') as any;
  assert.equal(t.name, 'security-reviewer');
  assert.match(t.description, /security issues/);
  assert.deepEqual(t.tools, ['read_file', 'grep', 'glob_files', 'run_command']);
  assert.equal(t.model, undefined, '"inherit" means use the parent model');
  assert.equal(t.prompt, 'You are a security reviewer. Report findings by severity.');
});

test('parses YAML list tools, quotes, CRLF, BOM, effort and explicit models', () => {
  const t = parseAgentFile('﻿---\r\nname: "db-helper"\r\ndescription: \'Helps with SQL\'\r\ntools:\r\n  - Read\r\n  - edit_file\r\nmodel: qwen3-coder-next\r\neffort: high\r\n---\r\nBody', 'user') as any;
  assert.equal(t.name, 'db-helper');
  assert.deepEqual(t.tools, ['read_file', 'edit_file']);
  assert.equal(t.model, 'qwen3-coder-next');
  assert.equal(t.effort, 'high');
});

test('rejects files without frontmatter, name or description', () => {
  assert.match((parseAgentFile('just text', 'project') as any).error, /frontmatter/);
  assert.match((parseAgentFile('---\ndescription: x\n---\n', 'project') as any).error, /name/);
  assert.match((parseAgentFile('---\nname: ../evil\ndescription: x\n---\n', 'project') as any).error, /invalid/);
  assert.match((parseAgentFile('---\nname: ok\n---\n', 'project') as any).error, /no description/);
});

test('loading: user then project folders; project overrides user and built-ins; bad files are reported', async () => {
  const user = await tmpDir('agents-user-'), project = await tmpDir('agents-proj-');
  await fs.writeFile(path.join(user, 'reviewer.md'), '---\nname: reviewer\ndescription: user version\n---\n');
  await fs.writeFile(path.join(project, 'reviewer.md'), '---\nname: reviewer\ndescription: project version\n---\n');
  await fs.writeFile(path.join(project, 'explore.md'), '---\nname: explore\ndescription: customised explore\ntools: Read\n---\nFind things.');
  await fs.writeFile(path.join(project, 'broken.md'), 'no frontmatter');
  await fs.writeFile(path.join(project, 'notes.txt'), 'ignored');
  const { types, errors } = await loadAgentTypes([{ dir: user, source: 'user' }, { dir: project, source: 'project' }, { dir: path.join(project, 'missing'), source: 'project' }]);
  assert.equal(findAgentType(types, 'reviewer')!.description, 'project version');
  assert.equal(findAgentType(types, 'explore')!.source, 'project');
  assert.equal(findAgentType(types, 'plan')!.source, 'builtin');
  assert.deepEqual(errors, ['broken.md: missing --- frontmatter ---']);
});

test('findAgentType: default, case/spacing tolerant, unknown', () => {
  assert.equal(findAgentType(BUILTIN_AGENT_TYPES, undefined)!.name, 'general-purpose');
  assert.equal(findAgentType(BUILTIN_AGENT_TYPES, 'General Purpose')!.name, 'general-purpose');
  assert.equal(findAgentType(BUILTIN_AGENT_TYPES, 'Explore')!.name, 'explore');
  assert.equal(findAgentType(BUILTIN_AGENT_TYPES, 'nope'), undefined);
});

test('toolsForType: delegation tools are never given to sub-agents; read-only and allow-lists are enforced', () => {
  const all = [...createFsTools(), { kind: 'meta' as const, spec: { type: 'function' as const, function: { name: 'agent', description: '', parameters: {} } }, describe: () => '', run: async () => '' }];
  const names = (t: any) => toolsForType(all, t, ['agent', 'send_message']).map((x) => x.spec.function.name).sort();
  assert.ok(!names(findAgentType(BUILTIN_AGENT_TYPES, 'general-purpose')).includes('agent'));
  assert.ok(names(findAgentType(BUILTIN_AGENT_TYPES, 'general-purpose')).includes('write_file'));
  assert.deepEqual(names(findAgentType(BUILTIN_AGENT_TYPES, 'explore')), ['glob_files', 'grep', 'list_dir', 'read_file', 'search_code']);
  assert.deepEqual(names({ name: 'x', description: 'x', source: 'project', tools: ['read_file', 'run_command', 'agent'] }), ['read_file', 'run_command']);
});
