/**
 * Minimal YAML-frontmatter reader for skill / agent files (the subset Claude Code files use):
 * `key: value`, quoted values, lists (`- item`), block scalars (`>`, `|`, with -/+ chomping) and
 * indented continuation lines of plain values.
 */
export type Frontmatter = Record<string, string | string[]>;

export function parseFrontmatter(text: string): { fm: Frontmatter; body: string; hasFrontmatter: boolean } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) { return { fm: {}, body: text.replace(/^﻿/, ''), hasFrontmatter: false }; }
  const fm: Frontmatter = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) { continue; }
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(raw);
    if (!kv) { continue; }
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();
    const block = /^([>|])([+-]?)\s*(#.*)?$/.exec(val);
    if (block) {                                                      // block scalar
      const collected: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) { collected.push(lines[++i]); }
      while (collected.length && !collected[collected.length - 1].trim()) { collected.pop(); }
      const indent = Math.min(...collected.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
      const body = collected.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      fm[key] = block[1] === '|'
        ? body.join('\n')
        : body.join('\n').split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ').trim()).join('\n');
      continue;
    }
    if (!val) {                                                       // list or nested block
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) { items.push(lines[++i].replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, '')); }
      fm[key] = items;
      continue;
    }
    let value = val;
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*-\s/.test(lines[i + 1])) { value += ` ${lines[++i].trim()}`; }
    fm[key] = unquote(value);
  }
  return { fm, body: m[2], hasFrontmatter: true };
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    const inner = v.slice(1, -1);
    if (v.startsWith('"')) { try { return JSON.parse(v); } catch { return inner; } }
    return inner.replace(/''/g, "'");
  }
  return v;
}
