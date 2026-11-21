import type { ChatMessage } from './llm';

export const BEFORE_CHARS = 6000;
export const AFTER_CHARS = 2500;

export const INLINE_EDIT_SYSTEM = `You are a precise code editor embedded in an editor.
Rewrite the text inside <selection> as the instruction asks. <before> and <after> are surrounding context: never repeat them.
Reply with ONLY the replacement for the selection. No explanations, no markdown fences, no tags.
Keep the existing style and indentation, and change nothing the instruction does not require.`;

export interface InlineEditRequest {
  instruction: string; language: string; file: string; before: string; selection: string; after: string; diagnostics?: string[];
}
export interface CleanOptions { eol?: string; before?: string; after?: string }
export interface DiagnosticInfo { message: string; severity?: string; source?: string; code?: string | number }

/** A window of at most maxChars around offset, cut on line boundaries when one is close. */
export function trimAround(text: string, offset: number, maxChars: number): string {
  if (maxChars <= 0) { return ''; }
  if (text.length <= maxChars) { return text; }
  const at = Math.max(0, Math.min(text.length, offset));
  let start = Math.max(0, at - Math.floor(maxChars / 2));
  let end = Math.min(text.length, start + maxChars);
  start = Math.max(0, end - maxChars);
  if (start > 0) {
    const nl = text.indexOf('\n', start);
    if (nl >= 0 && nl < at && nl - start < 200) { start = nl + 1; }
  }
  if (end < text.length) {
    const nl = text.lastIndexOf('\n', end - 1);
    if (nl >= at && end - nl < 200) { end = nl; }
  }
  return text.slice(start, end);
}

export function buildInlineEditMessages(req: InlineEditRequest): ChatMessage[] {
  const before = trimAround(req.before, req.before.length, BEFORE_CHARS);
  const after = trimAround(req.after, 0, AFTER_CHARS);
  const problems = req.diagnostics?.length ? `\n\nProblems reported here:\n${req.diagnostics.map((d) => `- ${d}`).join('\n')}` : '';
  return [
    { role: 'system', content: INLINE_EDIT_SYSTEM },
    { role: 'user', content: `File: ${req.file} (${req.language})\n\n<before>\n${before}\n</before>\n<selection>\n${req.selection}\n</selection>\n<after>\n${after}\n</after>${problems}\n\nInstruction: ${req.instruction}` },
  ];
}

/** A fence longer than any run of backticks inside the code, so the code can never close it early. */
const fenceFor = (code: string): string => '`'.repeat(Math.max(3, ...(code.match(/`{3,}/g) ?? []).map((m) => m.length + 1)));

/** The first message of a session that fixes one diagnostic. `line` is 1-based. */
export function buildFixPrompt(diag: DiagnosticInfo, file: string, line: number, code: string): string {
  const tag = [diag.source, diag.code].filter((x) => x !== undefined && x !== '').join(' ');
  const kind = diag.severity ?? 'problem';
  const ticks = fenceFor(code);
  return `Fix this ${kind} in ${file} at line ${line}${tag ? ` (${tag})` : ''}:\n\n${diag.message}\n\n${ticks}\n${code}\n${ticks}\n\nFind the root cause, make the smallest correct change, and verify it.`;
}

/**
 * The first message of a "Generate Tests" session. Tests belong in other files and must fit the project's framework
 * and layout, so this goes to an agent that can look around and run them, not to an inline edit. Lines are 1-based.
 */
export function buildTestsPrompt(file: string, startLine: number, endLine: number, code: string, language: string): string {
  const ticks = fenceFor(code);
  const where = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
  return `Write unit tests for this code in ${file} (${where}):\n\n${ticks}${language}\n${code}\n${ticks}\n\n`
    + 'First find out how this project tests code: the framework, where test files live, how they are named, and the helpers or fixtures they share. '
    + 'Follow those conventions; add a test framework only if the project has none, and say so. '
    + 'Cover the normal behaviour, edge cases and error handling. Do not change the code under test unless a test exposes a real bug: then stop and report it. '
    + 'Run the new tests and make sure they pass.';
}

/** Inline-edit instruction for "Add Documentation": comments only, reviewed as a diff like any inline edit. */
export const DOCUMENT_INSTRUCTION = 'Add documentation comments in the idiomatic style for this language (JSDoc, docstrings, XML doc comments, ...) to the '
  + 'functions, classes and non-obvious logic in the selection. Explain intent, parameters, return values and errors; do not restate the code. '
  + 'Keep the existing comments that are still correct. Do not change any code.';

const THINK = /^\s*<(think|thinking|reasoning|reflection)\b[^>]*>[\s\S]*?<\/\1>[ \t]*\n?/i;
const OPEN_THINK = /^\s*<(?:think|thinking|reasoning|reflection)\b[^>]*>/i;
const LEAD_IN = /^\s*(?:here(?:'s| is| are)|sure|certainly|okay|ok|of course|the (?:updated|fixed|rewritten|modified)|updated|fixed)\b[^\n]*:\s*$/i;
const FENCE_LINE = /^[ \t]*(?:`{3,}|~{3,})/m;

function stripThinking(t: string): string {
  let out = t;
  while (THINK.test(out)) { out = out.replace(THINK, ''); }
  return OPEN_THINK.test(out) ? '' : out;
}

/** Takes the code out of markdown fences, unless the selection itself is fenced text. */
function unfence(t: string, selection: string): string {
  if (FENCE_LINE.test(selection)) { return t; }
  const body = t.replace(/^\s*\n/, '').replace(/\s+$/, '');
  const whole = /^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?[ \t]*\1[ \t]*$/.exec(body);
  if (whole && !FENCE_LINE.test(whole[2])) { return whole[2]; }
  const blocks = [...body.matchAll(/^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?^[ \t]*\1[ \t]*$/gm)].map((m) => m[2]);
  if (blocks.length) { return blocks.reduce((a, b) => (b.length > a.length ? b : a)); }
  const open = /^[ \t]*(?:`{3,}|~{3,})[^\n]*\n([\s\S]*)$/m.exec(body);
  return open ? open[1] : t;
}

function stripEchoTags(t: string, selection: string): string {
  let out = t;
  if (!selection.includes('<selection>')) {
    const m = /<selection>[ \t]*\n?([\s\S]*?)\n?[ \t]*<\/selection>/i.exec(out);
    if (m) { out = m[1]; }
  }
  for (const tag of ['before', 'after']) {
    if (!selection.includes(`<${tag}>`)) { out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>[ \\t]*\\n?`, 'gi'), ''); }
  }
  return out.split('\n').filter((l) => !/^\s*<\/?(?:selection|before|after)>\s*$/i.test(l) || selection.includes(l.trim())).join('\n');
}

const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((l, i) => l.trim() === b[i].trim());

/** Drops lines the model repeated from the context around the selection. */
function stripContextEcho(lines: string[], selection: string[], before: string, after: string): string[] {
  let out = lines;
  const prior = before.split('\n').filter((l) => l.trim()).slice(-10);
  for (let k = Math.min(prior.length, out.length - 1); k > 0; k--) {
    const head = out.slice(0, k);
    if (same(head, prior.slice(-k)) && !same(head, selection.slice(0, k))) { out = out.slice(k); break; }
  }
  const next = after.split('\n').filter((l) => l.trim()).slice(0, 10);
  for (let k = Math.min(next.length, out.length - 1); k > 0; k--) {
    const tail = out.slice(-k);
    if (same(tail, next.slice(0, k)) && !same(tail, selection.slice(-k))) { out = out.slice(0, -k); break; }
  }
  return out;
}

const indentOf = (l: string): string => /^[ \t]*/.exec(l)![0];

/** Moves the reply onto the selection's base indentation, keeping its relative indentation. */
function rebase(lines: string[], selection: string[]): string[] {
  const sel = selection.filter((l) => l.trim());
  const base = sel.length ? indentOf(sel[0]) : '';
  const first = indentOf(lines[0]);
  const rest = lines.slice(1).filter((l) => l.trim());
  let shift: (l: string) => string;
  if (first) { shift = (l) => base + l.slice(Math.min(first.length, indentOf(l).length)); }
  else if (!base) { shift = (l) => l; }
  else if (sel.length > 1 && rest.every((l) => indentOf(l).length >= base.length)) { shift = (l) => l; } // only line one lost its indent
  else { shift = (l) => base + l; }
  return lines.map((l, i) => (!l.trim() ? l : i === 0 ? base + l.trimStart() : shift(l)));
}

function eolOf(selection: string, fallback: string): string {
  const crlf = (selection.match(/\r\n/g) ?? []).length;
  const all = (selection.match(/\n/g) ?? []).length;
  return all ? (crlf * 2 >= all ? '\r\n' : '\n') : fallback;
}

/**
 * Turns a raw model reply into the text that replaces the selection: strips thinking, fences and echoed context,
 * and restores the selection's base indentation and EOL style. Returns '' when there is no change to make.
 */
export function cleanInlineEdit(raw: string, selection: string, opts: CleanOptions = {}): string {
  const sel = selection.replace(/\r\n/g, '\n');
  let t = stripThinking(raw.replace(/\r\n/g, '\n'));
  t = stripEchoTags(unfence(t, sel), sel);
  let lines = t.split('\n');
  const selLines = sel.split('\n');
  if (LEAD_IN.test(lines[0]) && lines[0].trim() !== selLines[0].trim()) { lines = lines.slice(1); }
  while (lines.length && !lines[0].trim()) { lines.shift(); }
  while (lines.length && !lines[lines.length - 1].trim()) { lines.pop(); }
  if (!lines.length) { return ''; }
  lines = stripContextEcho(lines, selLines, (opts.before ?? '').replace(/\r\n/g, '\n'), (opts.after ?? '').replace(/\r\n/g, '\n'));

  const lead = /^(?:[ \t]*\n)*/.exec(sel)![0];
  const trail = sel.trim() ? /(?:\n[ \t]*)*$/.exec(sel)![0] : '';
  const out = lead + rebase(lines, selLines).join('\n') + trail;
  if (out === sel) { return ''; }
  const eol = eolOf(selection, opts.eol ?? '\n');
  return eol === '\n' ? out : out.replace(/\n/g, eol);
}
