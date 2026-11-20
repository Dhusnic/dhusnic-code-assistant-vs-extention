import * as path from 'path';

/** Pure helpers behind the code-navigation tools (no vscode import, so they can be unit tested). */

export const MAX_REFERENCES = 200;
export const MAX_WORKSPACE_SYMBOLS = 100;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Finds `symbol` as a whole word (identifiers may contain $ and _) on 1-based line `line1`, or within ±3 lines,
 * nearest first. Returns a 0-based position for a language server, or undefined.
 */
export function findSymbolColumn(lines: string[], line1: number, symbol: string): { line: number; character: number } | undefined {
  const sym = String(symbol ?? '').trim();
  if (!sym || !Number.isFinite(line1)) { return undefined; }
  const re = new RegExp(`(?<![\\w$])${escapeRe(sym)}(?![\\w$])`);
  const base = Math.trunc(line1) - 1;
  for (const d of [0, -1, 1, -2, 2, -3, 3]) {
    const i = base + d;
    if (i < 0 || i >= lines.length) { continue; }
    const m = re.exec(lines[i].replace(/\r$/, ''));
    if (m) { return { line: i, character: m.index }; }
  }
  return undefined;
}

/** A location in a file: absolute path, 0-based line and character. */
export interface NavLocation { file: string; line: number; character: number }

/** True when abs is inside root (or is root). */
export function insideRoot(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Workspace-relative POSIX path, or the absolute path marked as outside the workspace. */
export function displayPath(root: string, abs: string): string {
  return insideRoot(root, abs) ? path.relative(root, abs).split(path.sep).join('/') : `${abs} (outside workspace)`;
}

/**
 * Groups locations by file ("path:line: code"), sorted by file then line, de-duplicated, capped at `cap`.
 * `codeAt` returns the source line text (0-based line) when known.
 */
export function formatLocations(
  locs: NavLocation[], root: string, codeAt?: (file: string, line: number) => string | undefined, cap = MAX_REFERENCES,
): string {
  const seen = new Set<string>();
  const unique = locs.filter((l) => {
    const k = `${l.file}\0${l.line}\0${l.character}`;
    if (seen.has(k)) { return false; }
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => (a.file === b.file ? a.line - b.line || a.character - b.character : a.file < b.file ? -1 : 1));
  const shown = unique.slice(0, cap);
  const groups = new Map<string, string[]>();
  for (const l of shown) {
    const p = displayPath(root, l.file);
    const code = codeAt?.(l.file, l.line)?.trim();
    const row = `${p.replace(/ \(outside workspace\)$/, '')}:${l.line + 1}${code ? `: ${code.length > 200 ? `${code.slice(0, 200)}…` : code}` : ''}`;
    const list = groups.get(p) ?? [];
    list.push(row);
    groups.set(p, list);
  }
  const files = groups.size;
  const out = [`${unique.length} location${unique.length === 1 ? '' : 's'} in ${new Set(unique.map((l) => l.file)).size} file${files === 1 ? '' : 's'}:`];
  for (const [p, rows] of groups) { out.push('', `${p}`, ...rows.map((r) => `  ${r}`)); }
  if (unique.length > cap) { out.push('', `[${unique.length - cap} more not shown; narrow the search]`); }
  return out.join('\n');
}

/** 0-based line/character → string offset (handles \r\n and \n). Clamps to the text. */
export function offsetAt(text: string, line: number, character: number): number {
  let off = 0;
  for (let i = 0; i < line; i++) {
    const nl = text.indexOf('\n', off);
    if (nl < 0) { return text.length; }
    off = nl + 1;
  }
  let end = text.indexOf('\n', off);
  if (end < 0) { end = text.length; }
  if (end > off && text[end - 1] === '\r') { end--; }
  return Math.min(off + Math.max(0, character), end);
}

export interface OffsetEdit { startOffset: number; endOffset: number; newText: string }

/** Applies edits (offsets into the original text) from the end backwards. Throws on overlapping or invalid edits. */
export function applyTextEdits(text: string, edits: OffsetEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.startOffset - a.startOffset || b.endOffset - a.endOffset);
  let out = text;
  let limit = Number.POSITIVE_INFINITY;
  for (const e of sorted) {
    if (e.startOffset < 0 || e.endOffset < e.startOffset || e.endOffset > text.length) { throw new Error(`Invalid edit range ${e.startOffset}-${e.endOffset}.`); }
    if (e.endOffset > limit) { throw new Error('Overlapping edits cannot be applied.'); }
    out = out.slice(0, e.startOffset) + e.newText + out.slice(e.endOffset);
    limit = e.startOffset;
  }
  return out;
}

/** One entry of a file outline; lines are 1-based. */
export interface OutlineNode { name: string; kind: string; startLine: number; endLine: number; detail?: string; children?: OutlineNode[] }

/** Indented outline: "kind name  (lines a-b)". */
export function formatOutline(nodes: OutlineNode[], depth = 0): string {
  const rows: string[] = [];
  const sorted = [...nodes].sort((a, b) => a.startLine - b.startLine);
  for (const n of sorted) {
    const range = n.startLine === n.endLine ? `line ${n.startLine}` : `lines ${n.startLine}-${n.endLine}`;
    rows.push(`${'  '.repeat(depth)}${n.kind.toLowerCase()} ${n.name}${n.detail ? ` ${n.detail}` : ''}  (${range})`);
    if (n.children?.length) { rows.push(formatOutline(n.children, depth + 1)); }
  }
  return rows.join('\n');
}

/** A plausible new name: non-empty, no whitespace. The language server does the language-specific validation. */
export function isValidNewName(name: unknown): boolean {
  return typeof name === 'string' && /^\S+$/.test(name) && name.length <= 200;
}
