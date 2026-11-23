/**
 * Extra context for inline completions: short snippets from other open editor tabs and the signatures of symbols the
 * current file imports, fitted into a character budget. Without them the model sees only the current file and
 * guesses at names, argument orders and fields defined elsewhere.
 *
 * Design:
 * - The host (host/completions.ts) collects open tabs in most-recently-used order and supplies a `read` function for
 *   workspace-relative paths (open documents first, then disk). Everything here is plain data and pure logic, so it
 *   is testable without vscode.
 * - Tabs: same language (or same extension) first, then the host's MRU order. From each file one window of
 *   WINDOW_LINES lines is chosen by identifier overlap (Jaccard) with the code around the cursor; files with no
 *   overlap at all are skipped. Likely-secret files (.env, keys, credentials) are never used.
 * - Imports: relative TS/JS imports (`import ... from './x'`, `require('./x')`) and Python `from .x import a` /
 *   `from pkg.mod import a` are resolved to workspace files by trying the usual extensions and index files; paths
 *   that leave the workspace are ignored. From each file the exported signatures are extracted with small regexes
 *   (function/class headers, public methods, short interfaces/types/enums; Python def/class lines), restricted to
 *   the imported names when they are known. Like repoMap.ts this is approximate on purpose.
 * - Budget: imports get up to IMPORT_SHARE of it, tabs the rest. A snippet that does not fit is cut on a line
 *   boundary if a useful part fits, otherwise dropped. The prompt overhead per snippet (path header) is counted.
 */
import * as path from 'path';

export interface ContextSnippet { path: string; text: string; kind: 'import' | 'tab' }
/** An open editor tab. `path` is workspace-relative with forward slashes; `language` may be '' when unknown. */
export interface OpenFile { path: string; language: string; text: string }
export type ReadFn = (relPath: string) => Promise<string | undefined>;

export const CONTEXT_CHARS = 3000;
export const IMPORT_SHARE = 0.6;
export const MAX_TAB_FILES = 6;
export const MAX_IMPORT_FILES = 8;
export const WINDOW_LINES = 20;
const MIN_PARTIAL = 160;
const MAX_FILE_CHARS = 300_000;
const SNIPPET_OVERHEAD = 16;

const SENSITIVE = /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.pypirc|\.netrc|id_[a-z0-9]+|[^/]*\.(pem|key|p12|pfx|jks|keystore)|[^/]*(secret|credential)s?[^/]*)$/i;
export const isSensitivePath = (p: string): boolean => SENSITIVE.test(p.replace(/\\/g, '/'));

const extOf = (p: string): string => path.posix.extname(p).toLowerCase();
const EXT_GROUP: Record<string, string> = { '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts', '.js': 'ts', '.jsx': 'ts', '.mjs': 'ts', '.cjs': 'ts' };
const sameLanguage = (f: OpenFile, file: string, language: string): boolean =>
  (!!f.language && f.language === language) || (EXT_GROUP[extOf(f.path)] ?? extOf(f.path)) === (EXT_GROUP[extOf(file)] ?? extOf(file));

const STOP_WORDS = new Set(['the', 'and', 'for', 'const', 'let', 'var', 'function', 'return', 'import', 'export', 'from', 'class',
  'this', 'self', 'def', 'if', 'else', 'new', 'true', 'false', 'null', 'undefined', 'none', 'async', 'await', 'public', 'private',
  'static', 'void', 'string', 'number', 'int', 'type', 'interface', 'with', 'not', 'elif', 'while', 'pass']);
function identifiers(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z_$][\w$]{2,}/g)) { const w = m[0].toLowerCase(); if (!STOP_WORDS.has(w)) { out.add(w); } }
  return out;
}
const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) { return 0; }
  let inter = 0;
  for (const x of a) { if (b.has(x)) { inter++; } }
  return inter / (a.size + b.size - inter);
};

export interface CursorInfo { file: string; language: string; prefix: string; suffix: string }

/** The identifiers near the cursor: the last 30 lines before it and the first 10 after it. */
export function cursorIdentifiers(c: CursorInfo): Set<string> {
  const before = c.prefix.split('\n').slice(-30).join('\n');
  const after = c.suffix.split('\n').slice(0, 10).join('\n');
  return identifiers(`${before}\n${after}`);
}

/** The best-matching window of each open tab, same language first and otherwise in the given (MRU) order. */
export function tabSnippets(open: OpenFile[], cur: CursorInfo, maxFiles = MAX_TAB_FILES): ContextSnippet[] {
  const query = cursorIdentifiers(cur);
  if (!query.size) { return []; }
  const candidates = open.filter((f) => f.path !== cur.file && !isSensitivePath(f.path) && f.text.trim() && !f.text.includes('\u0000'));
  const ordered = [...candidates.filter((f) => sameLanguage(f, cur.file, cur.language)), ...candidates.filter((f) => !sameLanguage(f, cur.file, cur.language))];
  const out: ContextSnippet[] = [];
  for (const f of ordered) {
    if (out.length >= maxFiles) { break; }
    const lines = f.text.slice(0, MAX_FILE_CHARS).replace(/\r\n/g, '\n').split('\n');
    let best = 0; let bestAt = 0;
    const step = Math.max(1, WINDOW_LINES / 2);
    for (let i = 0; i < Math.max(1, lines.length - WINDOW_LINES + step); i += step) {
      const score = jaccard(identifiers(lines.slice(i, i + WINDOW_LINES).join('\n')), query);
      if (score > best) { best = score; bestAt = i; }
    }
    if (best <= 0) { continue; }
    const text = lines.slice(bestAt, bestAt + WINDOW_LINES).join('\n').replace(/^\n+|\s+$/g, '');
    if (text) { out.push({ path: f.path, text, kind: 'tab' }); }
  }
  return out;
}

// ---------------------------------------------------------------- imports

export interface ImportRef { candidates: string[]; names?: string[] }

const TS_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const isTs = (file: string): boolean => /\.(m|c)?[jt]sx?$|\.vue$|\.svelte$/i.test(file);
const isPy = (file: string): boolean => /\.pyi?$/i.test(file);

/** A workspace-relative posix path, or undefined when it leaves the workspace. */
function inWorkspace(p: string): string | undefined {
  const n = path.posix.normalize(p);
  return n.startsWith('../') || n === '..' || path.posix.isAbsolute(n) ? undefined : n;
}

function tsCandidates(fromFile: string, spec: string): string[] {
  const base = inWorkspace(path.posix.join(path.posix.dirname(fromFile), spec));
  if (!base) { return []; }
  const out: string[] = [];
  const ext = extOf(base);
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    const stem = base.slice(0, -ext.length);
    out.push(`${stem}${ext.replace('js', 'ts')}`, `${stem}.tsx`, `${stem}.d.ts`, base);
  } else if (ext && TS_EXTS.includes(ext)) {
    out.push(base);
  }
  for (const e of TS_EXTS) { out.push(`${base}${e}`); }
  for (const e of ['.ts', '.tsx', '.js', '.jsx']) { out.push(`${base}/index${e}`); }
  return [...new Set(out)];
}

const namesFromBraces = (body: string): string[] => body.split(',')
  .map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+|\s*:\s*/)[0].trim())
  .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));

/** The local files the current file imports, with the imported names when they are known (undefined = all). */
export function parseImports(file: string, text: string): ImportRef[] {
  const refs: ImportRef[] = [];
  if (isTs(file)) {
    for (const m of text.matchAll(/^\s*import\s+(?:type\s+)?([\s\S]{0,400}?)\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const clause = m[1];
      const braces = /\{([^}]*)\}/.exec(clause);
      const hasDefaultOrNs = /\*\s*as\s+\w+/.test(clause) || /^[A-Za-z_$][\w$]*\s*(,|$)/.test(clause.trim());
      refs.push({ candidates: tsCandidates(file, m[2]), names: hasDefaultOrNs || !braces ? undefined : namesFromBraces(braces[1]) });
    }
    for (const m of text.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      refs.push({ candidates: tsCandidates(file, m[2]), names: m[1].startsWith('{') ? namesFromBraces(m[1].slice(1, -1)) : undefined });
    }
  } else if (isPy(file)) {
    const dir = path.posix.dirname(file);
    for (const m of text.matchAll(/^from\s+(\.*)([\w.]*)\s+import\s+(\([^)]*\)|[^\n#]+)/gm)) {
      const dots = m[1].length; const mod = m[2];
      const names = m[3].replace(/[()]/g, '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter((s) => /^\w+$/.test(s));
      const all = m[3].trim() === '*';
      let baseDir: string | undefined = dots ? dir : '.';
      for (let i = 1; i < dots && baseDir !== undefined; i++) { baseDir = inWorkspace(path.posix.join(baseDir, '..')); }
      if (baseDir === undefined) { continue; }
      if (!mod) {
        // `from . import a, b`: a and b are modules.
        for (const n of names) {
          const b = inWorkspace(path.posix.join(baseDir, n));
          if (b) { refs.push({ candidates: [`${b}.py`, `${b}/__init__.py`] }); }
        }
        continue;
      }
      const b = inWorkspace(path.posix.join(baseDir, ...mod.split('.')));
      if (b) { refs.push({ candidates: [`${b}.py`, `${b}/__init__.py`, `${b}.pyi`], names: all ? undefined : names }); }
    }
  }
  return refs;
}

// ---------------------------------------------------------------- signatures

const MAX_SIG_LINES = 4;
const MAX_BLOCK_LINES = 16;
const MAX_MEMBERS = 15;

function braceDelta(line: string): number {
  const code = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '');
  let d = 0;
  for (const ch of code) { if (ch === '{') { d++; } else if (ch === '}') { d--; } }
  return d;
}
const parenDelta = (s: string): number => (s.match(/\(/g)?.length ?? 0) - (s.match(/\)/g)?.length ?? 0);

/** A declaration header without its body: lines up to the first `{` (or `=>`) after the parameters close. */
function header(lines: string[], i: number): { text: string; end: number } {
  let acc = ''; let depth = 0;
  for (let j = i; j < Math.min(lines.length, i + MAX_SIG_LINES); j++) {
    const l = lines[j];
    for (let k = 0; k < l.length; k++) {
      const ch = l[k];
      if (ch === '(' || ch === '<' && /\w/.test(l[k - 1] ?? '')) { depth++; } else if (ch === ')' || ch === '>' && depth > 0 && l[k - 1] !== '=') { depth--; }
      if (depth <= 0 && (ch === '{' || ch === ';' || (ch === '=' && l[k + 1] === '>'))) {
        return { text: (acc + l.slice(0, k)).trimEnd(), end: j };
      }
    }
    acc += `${l}\n`;
  }
  return { text: acc.trimEnd().split('\n')[0], end: i };
}

function tsSignatures(text: string, names?: Set<string>): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const want = (n: string | undefined, isDefault: boolean) => !names || (n !== undefined && names.has(n)) || (isDefault && names.has('default'));
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('export ')) { continue; }
    let m: RegExpExecArray | null;
    const isDefault = /^export\s+default\b/.test(l);
    if ((m = /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?/.exec(l))) {
      if (!want(m[1], isDefault)) { continue; }
      const h = header(lines, i); out.push(`${h.text};`); i = h.end; continue;
    }
    if ((m = /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)?/.exec(l))) {
      if (!want(m[1], isDefault)) { continue; }
      const h = header(lines, i);
      const members: string[] = [];
      let depth = 0;
      for (let j = h.end; j < lines.length; j++) {
        const before = depth;
        depth += braceDelta(lines[j]);
        if (j > h.end && before === 1 && members.length < MAX_MEMBERS) {
          const ml = lines[j];
          if (/^\s+(?:(?:public|protected|static|async|readonly|abstract|override|get|set)\s+)*\*?(?!if\b|for\b|while\b|switch\b|return\b)[A-Za-z_$][\w$]*\??\s*(?:<[^>()]*>)?\s*[(:]/.test(ml) && !/^\s*(private\b|#)/.test(ml)) {
            const mh = header(lines, j);
            members.push(`  ${mh.text.trim()};`);
          }
        }
        if (depth <= 0 && j > h.end) { i = j; break; }
        if (depth <= 0 && j === h.end && /\{/.test(lines[j])) { i = j; break; }
      }
      out.push(`${h.text} {\n${members.join('\n')}${members.length ? '\n' : ''}}`);
      continue;
    }
    if ((m = /^export\s+(?:declare\s+)?(?:const\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(l))) {
      if (!want(m[2], false)) { continue; }
      const block: string[] = [];
      let depth = 0;
      for (let j = i; j < lines.length && block.length < MAX_BLOCK_LINES; j++) {
        block.push(lines[j]); depth += braceDelta(lines[j]) + parenDelta(lines[j]);
        i = j;
        const continues = m[1] === 'type' && !/;\s*$/.test(lines[j]) && (/[=|&,(<{]\s*$/.test(lines[j]) || /^\s*[|&]/.test(lines[j + 1] ?? ''));
        if (depth <= 0 && !continues) { break; }
      }
      if (depth > 0) { block.push('  // …'); }
      out.push(block.join('\n'));
      continue;
    }
    if ((m = /^export\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(l))) {
      if (!want(m[1], false)) { continue; }
      const arrow = /^(.*?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?\s*)=>/.exec(l);
      if (arrow) { out.push(`${arrow[1].trimEnd()} => …;`); continue; }
      const typed = /^(export\s+(?:declare\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:\s*[^=]+?)\s*(?:=|;|$)/.exec(l);
      out.push(typed ? `${typed[1]};` : l.length > 120 ? `${l.slice(0, 120)}…` : l);
    }
  }
  return out;
}

function pySignatures(text: string, names?: Set<string>): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inWanted = false; let members = 0;
  const defHeader = (i: number): string => {
    let acc = lines[i]; let j = i;
    while (parenDelta(acc) > 0 && j + 1 < lines.length && j - i < MAX_SIG_LINES) { acc += `\n${lines[++j]}`; }
    return acc.replace(/:\s*(#.*)?$/, ': ...');
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m: RegExpExecArray | null;
    if ((m = /^(?:async\s+)?def\s+(\w+)/.exec(l))) {
      inWanted = false;
      if (!m[1].startsWith('_') && (!names || names.has(m[1]))) { out.push(defHeader(i)); }
      continue;
    }
    if ((m = /^class\s+(\w+)/.exec(l))) {
      inWanted = !m[1].startsWith('_') && (!names || names.has(m[1])); members = 0;
      if (inWanted) { out.push(l.replace(/:\s*(#.*)?$/, ':')); }
      continue;
    }
    if (/^\S/.test(l) && !/^[#@)\]}]/.test(l)) { inWanted = false; continue; }
    if (inWanted && members < MAX_MEMBERS && (m = /^( {4}|\t)(?:async\s+)?def\s+(\w+)/.exec(l)) && (!m[2].startsWith('_') || m[2] === '__init__')) {
      out.push(defHeader(i)); members++;
    }
  }
  return out;
}

/** Exported signatures of a source file, limited to `names` when given. '' when the language is not supported. */
export function extractSignatures(file: string, text: string, names?: string[]): string {
  if (text.includes('\u0000')) { return ''; }
  const set = names ? new Set(names) : undefined;
  const sigs = isTs(file) ? tsSignatures(text, set) : isPy(file) ? pySignatures(text, set) : [];
  return sigs.join('\n');
}

/** Signatures of the symbols the current file imports from workspace files, one snippet per resolved file. */
export async function importSnippets(file: string, text: string, read: ReadFn, maxFiles = MAX_IMPORT_FILES): Promise<ContextSnippet[]> {
  const out: ContextSnippet[] = [];
  const seen = new Set<string>([file]);
  for (const ref of parseImports(file, text)) {
    if (out.length >= maxFiles) { break; }
    for (const c of ref.candidates) {
      if (isSensitivePath(c)) { break; }
      let content: string | undefined;
      try { content = await read(c); } catch { content = undefined; }
      if (content === undefined) { continue; }
      if (!seen.has(c)) {
        seen.add(c);
        const sig = extractSignatures(c, content.slice(0, MAX_FILE_CHARS), ref.names);
        if (sig.trim()) { out.push({ path: c, text: sig, kind: 'import' }); }
      }
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- budget

/** Keeps snippets in order while they fit `budget` characters (path header included); cuts one on a line boundary. */
export function fitSnippets(snippets: ContextSnippet[], budget: number): ContextSnippet[] {
  const out: ContextSnippet[] = [];
  let left = budget;
  for (const s of snippets) {
    const cost = s.path.length + SNIPPET_OVERHEAD;
    if (s.text.length + cost <= left) { out.push(s); left -= s.text.length + cost; continue; }
    if (left - cost < MIN_PARTIAL) { continue; }
    const cut = s.text.slice(0, left - cost);
    const nl = cut.lastIndexOf('\n');
    const text = (nl > 0 ? cut.slice(0, nl) : '').trimEnd();
    if (text.length >= MIN_PARTIAL / 2) { out.push({ ...s, text }); left -= text.length + cost; }
  }
  return out;
}

export interface GatherInput extends CursorInfo { text: string; openFiles: OpenFile[]; read: ReadFn }

/**
 * Snippets for one completion request within `budget` characters: imported signatures (up to IMPORT_SHARE of the
 * budget), then open-tab windows with what is left. Files already used for imports are not repeated as tabs.
 * Returned in prompt order: tabs first, imports last (nearest to the current file).
 */
export async function gatherContext(input: GatherInput, budget = CONTEXT_CHARS): Promise<ContextSnippet[]> {
  if (budget <= 0) { return []; }
  const imports = fitSnippets(await importSnippets(input.file, input.text, input.read), Math.floor(budget * IMPORT_SHARE));
  const used = imports.reduce((n, s) => n + s.text.length + s.path.length + SNIPPET_OVERHEAD, 0);
  const importPaths = new Set(imports.map((s) => s.path));
  const tabs = fitSnippets(tabSnippets(input.openFiles.filter((f) => !importPaths.has(f.path)), input), budget - used);
  return [...tabs, ...imports];
}
