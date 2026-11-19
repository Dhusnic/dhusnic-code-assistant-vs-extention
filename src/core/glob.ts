import * as path from 'path';

export const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '__pycache__', '.venv', 'venv', '.next', 'target']);

/** Glob → RegExp (case-insensitive). Supports `*`, `**`, `?` and `{a,b}`. */
export function globToRegex(glob: string): RegExp {
  let re = '';
  let inBrace = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else { re += '[^/]*'; }
    } else if (c === '?') { re += '[^/]'; }
    else if (c === '{') { re += '(?:'; inBrace = true; }
    else if (c === '}' && inBrace) { re += ')'; inBrace = false; }
    else if (c === ',' && inBrace) { re += '|'; }
    else { re += c.replace(/[.+^$()|[\]\\]/g, '\\$&'); }
  }
  return new RegExp(`^${re}$`, 'i');
}

export function matchesGlob(rel: string, glob: string): boolean {
  const re = globToRegex(glob);
  return glob.includes('/') ? re.test(rel) : re.test(path.posix.basename(rel));
}

export const hasGlobChars = (s: string): boolean => /[*?{]/.test(s);

/** Ranks workspace files for fuzzy lookups: basename prefix > basename contains > path contains; boosted files first. */
export function filterFiles(files: string[], query: string, limit = 12, boost: ReadonlySet<string> = new Set()): string[] {
  const q = query.toLowerCase().replace(/\\/g, '/');
  const scored: Array<{ f: string; s: number }> = [];
  for (const f of files) {
    const lf = f.toLowerCase();
    const base = lf.slice(lf.lastIndexOf('/') + 1);
    let s: number;
    if (!q) { s = 3; }
    else if (base.startsWith(q)) { s = 0; }
    else if (base.includes(q)) { s = 1; }
    else if (lf.includes(q)) { s = 2; }
    else { continue; }
    if (boost.has(f)) { s -= 0.5; }
    scored.push({ f, s });
  }
  const baseLen = (f: string): number => f.split('/').pop()!.length;
  return scored.sort((a, b) => a.s - b.s || baseLen(a.f) - baseLen(b.f) || a.f.length - b.f.length || a.f.localeCompare(b.f))
    .slice(0, limit).map((x) => x.f);
}

export interface IgnoreMatcher {
  /** true = ignored, false = explicitly re-included (`!rule`), undefined = no rule matched. */
  test(rel: string, isDir: boolean): boolean | undefined;
  ignores(rel: string, isDir: boolean): boolean;
}

interface Rule { negate: boolean; dirOnly: boolean; re: RegExp }

/** Parses .gitignore lines (comments, negation, anchoring, directory-only rules). Paths are relative to the .gitignore's folder. */
export function createIgnore(lines: string[]): IgnoreMatcher {
  const rules: Rule[] = [];
  for (const raw of lines) {
    let line = raw.replace(/\r$/, '');
    if (!line.trim() || line.startsWith('#')) { continue; }
    line = line.replace(/(?<!\\)\s+$/, '');
    const negate = line.startsWith('!');
    if (negate) { line = line.slice(1); }
    const dirOnly = line.endsWith('/');
    if (dirOnly) { line = line.slice(0, -1); }
    if (!line) { continue; }
    const anchored = line.startsWith('/') || line.includes('/');
    if (line.startsWith('/')) { line = line.slice(1); }
    const src = globToRegex(line).source.slice(1, -1);
    rules.push({ negate, dirOnly, re: new RegExp(anchored ? `^${src}$` : `(?:^|/)${src}$`, 'i') });
  }
  const test = (rel: string, isDir: boolean): boolean | undefined => {
    let result: boolean | undefined;
    for (const r of rules) {
      if (r.dirOnly && !isDir) { continue; }
      if (r.re.test(rel)) { result = !r.negate; }
    }
    return result;
  };
  return { test, ignores: (rel, isDir) => test(rel, isDir) === true };
}
