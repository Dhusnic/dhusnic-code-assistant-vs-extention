import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolSpec } from './llm';
import { fnSpec } from './tool';
import { TOOL_ALIASES } from './agentTypes';
import { Frontmatter, parseFrontmatter } from './frontmatter';

/**
 * Skills, compatible with Claude Code:
 *   <base>/skills/<name>/SKILL.md   frontmatter (name, description, argument-hint, allowed-tools,
 *                                   disable-model-invocation, user-invocable) + instructions; may ship supporting files
 *   <base>/commands/<name>.md       legacy custom slash commands (treated as user-only skills)
 * where <base> is <workspace>/.claude, <workspace>/.infraon, ~/.claude or ~/.infraon.
 */
export interface Skill {
  name: string;
  description: string;
  body: string;
  dir: string;
  file: string;
  source: 'project' | 'user';
  kind: 'skill' | 'command';
  argumentHint?: string;
  allowedTools?: string[];
  /** The agent may load it by itself when a request matches (Claude: !disable-model-invocation). */
  modelInvocable: boolean;
  /** Shown as a /command (Claude: user-invocable). */
  userInvocable: boolean;
  /** Supporting files next to SKILL.md (relative paths). */
  files: string[];
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;
export const SKILL_TOOL = 'skill';
const MAX_LISTED_DESCRIPTION = 300;
const MAX_TOOL_DESCRIPTION = 12000;

type Fm = Frontmatter;
export { parseFrontmatter };

const str = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join(' ') : v ?? '').trim();
const bool = (v: string | string[] | undefined, dflt: boolean): boolean => {
  const s = str(v).toLowerCase();
  return s === 'true' ? true : s === 'false' ? false : dflt;
};
const list = (v: string | string[] | undefined): string[] | undefined => {
  if (v === undefined) { return undefined; }
  const items = (Array.isArray(v) ? v : v.replace(/^\[|\]$/g, '').split(/[,\s]+/)).map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return items.length ? [...new Set(items.map((t) => TOOL_ALIASES[t.toLowerCase()] ?? t))] : undefined;
};

/** First meaningful line of the body, used when a command file has no description. */
function firstLine(body: string): string {
  const line = body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find((l) => l && !l.startsWith('<!--'));
  return line ? line.slice(0, 200) : '';
}

export function parseSkill(text: string, meta: { dirName: string; source: 'project' | 'user'; kind: 'skill' | 'command'; dir: string; file: string }): Skill | { error: string } {
  const { fm, body } = parseFrontmatter(text);
  const name = str(fm.name) || meta.dirName;
  if (!SKILL_NAME_RE.test(name)) { return { error: `invalid skill name "${name}" (use letters, digits, - _ . :)` }; }
  const description = str(fm.description) || (meta.kind === 'command' ? firstLine(body) : '');
  if (!description) { return { error: `skill "${name}" has no description (add "description:" saying when to use it)` }; }
  if (!body.trim()) { return { error: `skill "${name}" has no instructions` }; }
  return {
    name, description, body: body.trim(), dir: meta.dir, file: meta.file, source: meta.source, kind: meta.kind,
    argumentHint: str(fm['argument-hint']) || undefined,
    allowedTools: list(fm['allowed-tools']),
    // Legacy commands were user-only in Claude Code; skills are model-invocable unless disabled.
    modelInvocable: meta.kind === 'skill' ? !bool(fm['disable-model-invocation'], false) : false,
    userInvocable: bool(fm['user-invocable'], true),
    files: [],
  };
}

async function listFiles(dir: string, rel = '', out: string[] = [], limit = 30): Promise<string[]> {
  let ents;
  try { ents = await fs.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (out.length >= limit) { break; }
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__') { await listFiles(dir, r, out, limit); } }
    else if (e.isFile() && !(rel === '' && e.name.toLowerCase() === 'skill.md')) { out.push(r); }
  }
  return out;
}

/** Loads skills from `.claude` / `.infraon` style base folders; later bases override earlier ones (project over personal). */
export async function loadSkills(bases: Array<{ base: string; source: 'project' | 'user' }>): Promise<{ skills: Skill[]; errors: string[] }> {
  const byName = new Map<string, Skill>();
  const errors: string[] = [];
  for (const { base, source } of bases) {
    const skillsDir = path.join(base, 'skills');
    let dirs: string[] = [];
    try { dirs = (await fs.readdir(skillsDir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.')).map((d) => d.name).sort(); } catch { /* none */ }
    for (const d of dirs) {
      const dir = path.join(skillsDir, d);
      const file = path.join(dir, 'SKILL.md');
      let text: string;
      try { text = await fs.readFile(file, 'utf8'); } catch { continue; }
      const s = parseSkill(text, { dirName: d, source, kind: 'skill', dir, file });
      if ('error' in s) { errors.push(`${path.relative(base, file)}: ${s.error}`); continue; }
      s.files = await listFiles(dir);
      byName.set(s.name.toLowerCase(), s);
    }
    const cmdDir = path.join(base, 'commands');
    let cmds: string[] = [];
    try { cmds = (await fs.readdir(cmdDir)).filter((n) => n.toLowerCase().endsWith('.md')).sort(); } catch { /* none */ }
    for (const n of cmds) {
      const file = path.join(cmdDir, n);
      try {
        const s = parseSkill(await fs.readFile(file, 'utf8'), { dirName: n.replace(/\.md$/i, ''), source, kind: 'command', dir: cmdDir, file });
        if ('error' in s) { errors.push(`commands/${n}: ${s.error}`); continue; }
        if (!byName.has(s.name.toLowerCase()) || byName.get(s.name.toLowerCase())!.kind === 'command') { byName.set(s.name.toLowerCase(), s); }
      } catch (e: any) { errors.push(`commands/${n}: ${e.message}`); }
    }
  }
  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

export function findSkill(skills: Skill[], name: string): Skill | undefined {
  const n = name.toLowerCase().replace(/^\//, '');
  return skills.find((s) => s.name.toLowerCase() === n);
}

/** The instructions handed to the agent: $ARGUMENTS / $1..$9 substituted, base directory and supporting files listed. */
export function expandSkill(skill: Skill, args = ''): string {
  const positional = args.trim() ? args.trim().split(/\s+/) : [];
  let body = skill.body.replace(/\$ARGUMENTS\b/g, args.trim()).replace(/\$([1-9])\b/g, (_m, d) => positional[Number(d) - 1] ?? '');
  if (args.trim() && !/\$ARGUMENTS\b|\$[1-9]\b/.test(skill.body)) { body += `\n\nARGUMENTS: ${args.trim()}`; }
  const files = skill.files.length ? `\nSupporting files (reference material: read them with read_file when the instructions refer to them):\n${skill.files.map((f) => `- ${path.join(skill.dir, f)}`).join('\n')}` : '';
  // Without this, models sometimes "fill in" a template inside the skill folder instead of producing the output.
  const readOnly = '\nThe skill folder is read-only reference: never edit or create files inside it unless the user explicitly asks to change the skill. Put results in your reply or in the project files the task is about.';
  return `<skill name="${skill.name}">\nBase directory: ${skill.dir} (relative paths in these instructions are relative to it)${files}${readOnly}\n\n${body}\n</skill>`;
}

/** The `skill` tool, listing every model-invocable skill by name and description (full text loads on demand). */
export function skillToolSpec(skills: Skill[]): ToolSpec | undefined {
  const usable = skills.filter((s) => s.modelInvocable);
  if (!usable.length) { return undefined; }
  let listing = '';
  for (const s of usable) {
    const line = `- ${s.name}: ${s.description.length > MAX_LISTED_DESCRIPTION ? `${s.description.slice(0, MAX_LISTED_DESCRIPTION - 1)}…` : s.description}\n`;
    if (listing.length + line.length > MAX_TOOL_DESCRIPTION) { listing += '- (more skills exist; ask the user for /skills)\n'; break; }
    listing += line;
  }
  return fnSpec(SKILL_TOOL, `Load a skill: a packaged set of instructions the team prepared for a specific kind of task. When the user's request matches a skill's description, call this FIRST and then follow the instructions it returns (they replace your default approach). Available skills:
${listing}`, {
    name: { type: 'string', enum: usable.map((s) => s.name), description: 'Exact skill name.' },
    args: { type: 'string', description: 'Optional arguments for the skill (e.g. an id or a file).' },
  }, ['name']);
}

/* ------------------------------------------------------------------ authoring */

export interface NewSkill {
  name: string; description: string; instructions: string;
  argumentHint?: string; allowedTools?: string[]; modelInvocable?: boolean; userInvocable?: boolean;
}

const yamlValue = (v: string): string => (/^[\w .,/()'-]*$/.test(v) && !/^\s|\s$/.test(v) ? v : JSON.stringify(v));

export function renderSkillFile(s: NewSkill): string {
  const fm = [
    `name: ${s.name}`,
    `description: ${yamlValue(s.description.replace(/\s+/g, ' ').trim())}`,
    s.argumentHint ? `argument-hint: ${yamlValue(s.argumentHint)}` : '',
    s.allowedTools?.length ? `allowed-tools: ${s.allowedTools.join(', ')}` : '',
    s.modelInvocable === false ? 'disable-model-invocation: true' : '',
    s.userInvocable === false ? 'user-invocable: false' : '',
  ].filter(Boolean);
  return `---\n${fm.join('\n')}\n---\n\n${s.instructions.trim()}\n`;
}

export function validateNewSkill(s: Partial<NewSkill>): string | undefined {
  if (!s.name || !SKILL_NAME_RE.test(s.name) || /[:.]/.test(s.name)) { return 'Name: use lowercase letters, digits and hyphens, e.g. "release-notes".'; }
  if (!s.description || s.description.trim().length < 10) { return 'Description: say what the skill does and when to use it (at least a sentence).'; }
  if (!s.instructions || s.instructions.trim().length < 10) { return 'Instructions: describe the steps the agent should follow.'; }
  return undefined;
}

/** Creates <base>/skills/<name>/SKILL.md. Refuses to overwrite an existing skill. */
export async function createSkill(base: string, s: NewSkill): Promise<string> {
  const err = validateNewSkill(s);
  if (err) { throw new Error(err); }
  const dir = path.join(base, 'skills', s.name);
  const file = path.join(dir, 'SKILL.md');
  try { await fs.access(file); throw new Error(`A skill named "${s.name}" already exists here.`); } catch (e: any) { if (e.code !== 'ENOENT') { throw e; } }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, renderSkillFile(s), 'utf8');
  return file;
}

/** Turns automatic (agent-initiated) use on or off by editing the frontmatter in place, keeping everything else. */
export async function setModelInvocation(skill: Skill, enabled: boolean): Promise<void> {
  if (skill.kind !== 'skill') { throw new Error('Legacy commands can only be run with /name.'); }
  const text = await fs.readFile(skill.file, 'utf8');
  const m = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---)/.exec(text);
  if (!m) { throw new Error('SKILL.md has no frontmatter'); }
  const eol = m[1].includes('\r\n') ? '\r\n' : '\n';
  const lines = m[2].split(/\r?\n/).filter((l) => !/^disable-model-invocation\s*:/i.test(l));
  if (!enabled) { lines.push('disable-model-invocation: true'); }
  await fs.writeFile(skill.file, text.replace(m[0], `${m[1]}${lines.join(eol)}${m[3]}`), 'utf8');
}

export async function deleteSkill(skill: Skill): Promise<void> {
  if (skill.kind === 'command') { await fs.rm(skill.file, { force: true }); return; }
  if (path.basename(path.dirname(skill.dir)) !== 'skills') { throw new Error('Refusing to delete: unexpected skill location.'); }
  await fs.rm(skill.dir, { recursive: true, force: true });
}

export const SKILL_TEMPLATE = `# Goal
What this skill achieves in one sentence.

# Steps
1. First thing to do (be specific: which files, commands or tools).
2. Next step.
3. How to verify the result.

# Rules
- Constraints the agent must respect.

# Output
What to report back to the user when done.`;

/* ------------------------------------------------------------------ quality checks, editing, sharing */

export const KNOWN_TOOLS = ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob_files', 'grep', 'run_command', 'get_diagnostics', 'agent', 'ask_user_question', 'todo_write'];
const RESERVED = ['help', 'clear', 'new', 'reset', 'undo', 'rewind', 'history', 'chats', 'plan', 'mode', 'effort', 'model', 'init', 'review', 'compact', 'mcp', 'agents', 'skills'];

export interface SkillLint { level: 'error' | 'warning' | 'tip'; message: string }

/** Checks that make the difference between a skill the agent actually uses and one it ignores. */
export function lintSkill(s: Partial<NewSkill>, existing: Array<{ name: string }> = [], originalName?: string): SkillLint[] {
  const out: SkillLint[] = [];
  const name = (s.name ?? '').trim();
  const desc = (s.description ?? '').trim();
  const body = s.instructions ?? '';
  const err = validateNewSkill(s);
  if (err) { out.push({ level: 'error', message: err }); }
  if (name && RESERVED.includes(name.toLowerCase())) { out.push({ level: 'error', message: `/${name} is a built-in command; pick another name.` }); }
  if (name && name !== originalName && existing.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
    out.push({ level: 'warning', message: `A skill named "${name}" already exists; the project one wins over a personal one with the same name.` });
  }
  if (desc && desc.length < 40) { out.push({ level: 'warning', message: 'The description is short. The agent decides from it alone, so say what the skill does and when to use it.' }); }
  if (desc && s.modelInvocable !== false && !/\b(use (it )?(when|for|whenever|after|before)|when (the user|asked|you)|whenever)\b/i.test(desc)) {
    out.push({ level: 'warning', message: 'Say WHEN to use it, e.g. "Use when the user asks for …". Without that the agent rarely picks the skill.' });
  }
  const usesArgs = /\$ARGUMENTS\b|\$[1-9]\b/.test(body);
  if (usesArgs && !s.argumentHint?.trim()) { out.push({ level: 'tip', message: 'The instructions use $ARGUMENTS; add an argument hint so people know what to type after /name.' }); }
  if (!usesArgs && s.argumentHint?.trim()) { out.push({ level: 'tip', message: 'An argument hint is set but the instructions never use $ARGUMENTS; typed arguments are appended at the end.' }); }
  const unknown = (s.allowedTools ?? []).filter((t) => !KNOWN_TOOLS.includes(t) && !t.startsWith('mcp__'));
  if (unknown.length) { out.push({ level: 'warning', message: `Unknown tools: ${unknown.join(', ')}. Known: ${KNOWN_TOOLS.join(', ')}.` }); }
  if (body.length > 20000) { out.push({ level: 'warning', message: 'Very long instructions cost context every time the skill runs; move reference material into supporting files and tell the agent to read them when needed.' }); }
  if (s.userInvocable === false && s.modelInvocable === false) { out.push({ level: 'error', message: 'Nobody could run this skill: allow it as a /command, for the agent, or both.' }); }
  return out;
}

const MANAGED = new Set(['name', 'description', 'argument-hint', 'allowed-tools', 'disable-model-invocation', 'user-invocable']);

/** Rewrites SKILL.md from the form, keeping frontmatter keys the form does not manage (e.g. model). Renaming moves the folder. */
export async function updateSkill(skill: Skill, input: NewSkill): Promise<string> {
  if (skill.kind !== 'skill') { throw new Error('Legacy commands are edited in their .md file.'); }
  const err = validateNewSkill(input);
  if (err) { throw new Error(err); }
  const { fm } = parseFrontmatter(await fs.readFile(skill.file, 'utf8'));
  const extra = Object.entries(fm).filter(([k]) => !MANAGED.has(k))
    .map(([k, v]) => (Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${x}`).join('\n')}` : `${k}: ${yamlValue(v)}`));
  let text = renderSkillFile(input);
  if (extra.length) { text = text.replace(/\n---\n/, `\n${extra.join('\n')}\n---\n`); }
  let dir = skill.dir;
  if (input.name !== skill.name && path.basename(skill.dir) === skill.name) {
    const target = path.join(path.dirname(skill.dir), input.name);
    try { await fs.access(target); throw new Error(`A skill folder named "${input.name}" already exists.`); } catch (e: any) { if (e.code !== 'ENOENT') { throw e; } }
    await fs.rename(skill.dir, target);
    dir = target;
  }
  const file = path.join(dir, 'SKILL.md');
  await fs.writeFile(file, text, 'utf8');
  return file;
}

/** Copies a skill (with its supporting files) to another base, e.g. personal → project to share it with the team. */
export async function copySkill(skill: Skill, toBase: string, newName = skill.name): Promise<string> {
  if (!SKILL_NAME_RE.test(newName) || /[:.]/.test(newName)) { throw new Error(`Invalid skill name "${newName}".`); }
  const target = path.join(toBase, 'skills', newName);
  try { await fs.access(target); throw new Error(`"${newName}" already exists there.`); } catch (e: any) { if (e.code !== 'ENOENT') { throw e; } }
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (skill.kind === 'skill') {
    await fs.cp(skill.dir, target, { recursive: true });
  } else {
    await fs.mkdir(target, { recursive: true });
    const text = await fs.readFile(skill.file, 'utf8');
    const { hasFrontmatter } = parseFrontmatter(text);
    await fs.writeFile(path.join(target, 'SKILL.md'), hasFrontmatter ? text : `---\nname: ${newName}\ndescription: ${yamlValue(skill.description)}\n---\n\n${text}`, 'utf8');
  }
  const file = path.join(target, 'SKILL.md');
  if (newName !== skill.name) {
    const t = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, /^(﻿?---\r?\n[\s\S]*?)^name:.*$/m.test(t) ? t.replace(/^name:.*$/m, `name: ${newName}`) : t, 'utf8');
  }
  return file;
}

/** Adds a supporting file (template, script, reference) inside the skill folder. Paths cannot escape the folder. */
export async function addSkillFile(skill: Skill, relPath: string, content: string): Promise<string> {
  if (skill.kind !== 'skill') { throw new Error('Supporting files need a skill folder (not a legacy command).'); }
  const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!rel || rel.split('/').some((p) => p === '..' || p === '') || /^[a-zA-Z]:/.test(rel)) { throw new Error('Use a relative path inside the skill folder, e.g. "templates/notes.md".'); }
  if (rel.toLowerCase() === 'skill.md') { throw new Error('SKILL.md is edited through the form.'); }
  const abs = path.join(skill.dir, rel);
  const relCheck = path.relative(skill.dir, abs);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) { throw new Error('Path escapes the skill folder.'); }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  return abs;
}
