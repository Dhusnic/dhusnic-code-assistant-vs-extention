/**
 * Fill-in-the-middle (FIM) prompts for inline completions, per model family.
 *
 * Code models are trained to complete a hole between a prefix and a suffix when the prompt uses their special
 * tokens; that is faster and more accurate than asking a chat model to "reply with the code at <CURSOR>". The prompt
 * goes to the gateway's raw `/completions` endpoint (llm.ts completeText), never through a chat template.
 *
 * Design:
 * - The family is chosen from the model id with whole-word patterns, like sampling.ts. Only families whose FIM tokens
 *   we know are listed; anything else returns undefined and the caller uses the chat prompt.
 * - Context from other files (completionContext.ts snippets) goes into the prompt the way the family was trained to
 *   see it: Qwen2.5/3-Coder get the repo-level format (`<|repo_name|>`, `<|file_sep|>path\ncontent`, as llama.cpp's
 *   /infill builds it); the others get each snippet as a commented block ("// Path: x") at the top of the prefix.
 * - The family's own special tokens are removed from the user's text before building the prompt, so a file that
 *   happens to contain `<|fim_prefix|>` (this one, for instance) cannot corrupt it.
 * - Stop sequences cover the FIM tokens, end-of-text and file separators. Gateways often skip special tokens when
 *   detokenizing and so never match such stops, so cleanFim() also cuts at them and keeps the result to one
 *   sensible block: a single line when the cursor is mid-statement, otherwise lines until the code dedents out of
 *   the cursor's block. Text the model regenerates from the suffix (a closing brace the editor already inserted, the
 *   rest of the line) is trimmed.
 *
 * Pure functions, no I/O and no vscode import.
 */
import type { ContextSnippet } from './completionContext';

export type FimFamily = 'qwen' | 'deepseek' | 'starcoder' | 'codellama';

export interface FimFormat {
  family: FimFamily;
  prefix: string; suffix: string; middle: string;
  /** Sent as `stop` and also cut at in post-processing. */
  stop: string[];
  /** Qwen repo-level tokens; when absent, context snippets become comments in the prefix. */
  repo?: { name: string; fileSep: string };
}

const QWEN: FimFormat = {
  family: 'qwen', prefix: '<|fim_prefix|>', suffix: '<|fim_suffix|>', middle: '<|fim_middle|>',
  stop: ['<|endoftext|>', '<|file_sep|>', '<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<|fim_pad|>', '<|repo_name|>', '<|im_end|>', '<|im_start|>'],
  repo: { name: '<|repo_name|>', fileSep: '<|file_sep|>' },
};
const DEEPSEEK: FimFormat = {
  family: 'deepseek', prefix: '<｜fim▁begin｜>', suffix: '<｜fim▁hole｜>', middle: '<｜fim▁end｜>',
  stop: ['<｜fim▁begin｜>', '<｜fim▁hole｜>', '<｜fim▁end｜>', '<|EOT|>', '<｜end▁of▁sentence｜>', '<|endoftext|>'],
};
const STARCODER: FimFormat = {
  family: 'starcoder', prefix: '<fim_prefix>', suffix: '<fim_suffix>', middle: '<fim_middle>',
  stop: ['<|endoftext|>', '<fim_prefix>', '<fim_suffix>', '<fim_middle>', '<file_sep>', '<filename>', '<repo_name>'],
};
const CODELLAMA: FimFormat = {
  family: 'codellama', prefix: '<PRE> ', suffix: ' <SUF>', middle: ' <MID>',
  stop: ['<EOT>', '<PRE>', '<SUF>', '<MID>', '</s>'],
};

export const FIM_FORMATS: Record<FimFamily, FimFormat> = { qwen: QWEN, deepseek: DEEPSEEK, starcoder: STARCODER, codellama: CODELLAMA };

const word = (body: string) => new RegExp(`(?:^|[^a-z0-9])(?:${body})(?![a-z0-9])`, 'i');
/** First match wins. Qwen: only the Coder models (2.5, 3, 3-next...) were trained with FIM; plain Qwen chat models were not. */
const FAMILIES: [RegExp, FimFamily][] = [
  [word('deepseek[-_]?coder(?:[-_]?v2)?'), 'deepseek'],
  [word('qwen(?:2\\.5|3(?:\\.\\d+)?)?[-_ ]?coder'), 'qwen'],
  [word('starcoder2?|starchat'), 'starcoder'],
  [word('code[-_]?llama'), 'codellama'],
];

/** The FIM format for a model id, or undefined when the family is not known to support FIM. */
export function fimFormatFor(model: string): FimFormat | undefined {
  const hit = FAMILIES.find(([re]) => re.test(model));
  return hit ? FIM_FORMATS[hit[1]] : undefined;
}

export interface FimInput { prefix: string; suffix: string; file: string; language: string; repo?: string; context?: ContextSnippet[] }

const LINE_COMMENT: Record<string, string> = {
  python: '#', ruby: '#', shellscript: '#', yaml: '#', toml: '#', r: '#', perl: '#', powershell: '#', dockerfile: '#',
  makefile: '#', coffeescript: '#', elixir: '#', julia: '#', nim: '#', properties: '#',
  sql: '--', lua: '--', haskell: '--', ada: '--', vhdl: '--', elm: '--',
  bat: 'REM', vb: "'", matlab: '%', erlang: '%', latex: '%', tex: '%', lisp: ';', clojure: ';', scheme: ';',
};
export const lineComment = (language: string): string => LINE_COMMENT[language] ?? '//';

/** Removes the family's own control tokens from user text, so the prompt structure cannot be spoofed by file content. */
export function stripTokens(text: string, fmt: FimFormat): string {
  let t = text;
  for (const tok of new Set([fmt.prefix.trim(), fmt.suffix.trim(), fmt.middle.trim(), ...fmt.stop])) {
    if (tok && t.includes(tok)) { t = t.split(tok).join(''); }
  }
  return t;
}

/** The raw prompt for `/completions`. `prefix`/`suffix` should already be trimmed to the context window. */
export function buildFimPrompt(fmt: FimFormat, input: FimInput): string {
  const clean = (s: string) => stripTokens(s, fmt);
  const prefix = clean(input.prefix);
  const suffix = clean(input.suffix);
  const snippets = (input.context ?? []).filter((s) => s.text.trim());
  let head = '';
  if (fmt.repo) {
    if (snippets.length) {
      head = `${fmt.repo.name}${clean(input.repo || 'workspace')}\n`;
      for (const s of snippets) { head += `${fmt.repo.fileSep}${clean(s.path)}\n${clean(s.text).replace(/\n*$/, '\n')}`; }
      head += `${fmt.repo.fileSep}${clean(input.file)}\n`;
    }
  } else if (snippets.length) {
    const c = lineComment(input.language);
    for (const s of snippets) {
      head += `${c} Path: ${clean(s.path)}\n${clean(s.text).replace(/\n*$/, '').split('\n').map((l) => `${c} ${l}`.trimEnd()).join('\n')}\n\n`;
    }
  }
  return `${fmt.prefix}${head}${prefix}${fmt.suffix}${suffix}${fmt.middle}`;
}

export const MAX_FIM_LINES = 12;
const lastLine = (s: string): string => s.slice(s.lastIndexOf('\n') + 1);
const indentOf = (s: string): number => /^[ \t]*/.exec(s)![0].replace(/\t/g, '    ').length;
const OPENS_BLOCK = /(?:[{([:]|=>|\bthen|\bdo|\bbegin)\s*(?:\/\/.*|#.*)?$/;
const CLOSER = /^\s*(?:[}\])]|end\b|fi\b|done\b|esac\b)/;

/**
 * Keeps one sensible unit of a multi-line completion. Mid-statement (the cursor line has code and does not open a
 * block): the first line only. Otherwise lines until one dedents below the cursor's block, and when the completion
 * opened a block, up to and including the line that closes it (`} else {` keeps going; Python's dedent ends it).
 */
export function limitToBlock(text: string, prefix: string): string {
  const lines = text.split('\n');
  if (lines.length === 1) { return text; }
  const cur = lastLine(prefix);
  const firstLine = cur + lines[0];
  const opens = OPENS_BLOCK.test(firstLine.trimEnd());
  if (cur.trim() && !opens) { return lines[0]; }
  const base = cur.trim() ? indentOf(cur) : indentOf(cur || lines[0]);
  let deeper = false;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) { continue; }
    const ind = indentOf(l);
    if (ind < base) { return lines.slice(0, i).join('\n'); }
    if (ind > base) { deeper = true; continue; }
    if (!opens || !deeper) { continue; }
    // Back at the cursor's indentation after the block body: `} else {` continues the unit, a closer ends it
    // (inclusive), and any other line starts the next statement (exclusive).
    if (CLOSER.test(l) && OPENS_BLOCK.test(l.trimEnd())) { deeper = false; continue; }
    return lines.slice(0, CLOSER.test(l) ? i + 1 : i).join('\n');
  }
  return text;
}

/**
 * Removes text the model regenerated from the suffix: a whole line equal to the next non-blank suffix line (with its
 * indentation, e.g. a closing brace the editor auto-inserted) and everything after it; then the tail that repeats
 * the start of the rest of the cursor line (`foo(a, b)` before an existing `)`).
 */
export function trimSuffixOverlap(text: string, suffix: string): string {
  let t = text;
  const sufLines = suffix.split('\n');
  const nextFull = sufLines.slice(1).find((l) => l.trim());
  const lines = t.split('\n');
  if (nextFull !== undefined && lines.length > 1) {
    const want = nextFull.trimEnd();
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trimEnd() === want) { t = lines.slice(0, i).join('\n'); break; }
    }
  }
  const rest = sufLines[0];
  if (rest.trim()) {
    const tail = rest.trimStart();
    for (let n = Math.min(t.length, tail.length); n > 0; n--) {
      if (t.endsWith(tail.slice(0, n))) { t = t.slice(0, t.length - n); break; }
    }
  }
  return t;
}

/** Turns the raw `/completions` text into what the editor shows: cut at control tokens, one block, no suffix echo. */
export function cleanFim(raw: string, prefix: string, suffix: string, fmt: FimFormat): string {
  let t = raw.replace(/\r\n/g, '\n');
  let cut = t.length;
  for (const s of fmt.stop) { const i = t.indexOf(s); if (i >= 0 && i < cut) { cut = i; } }
  t = t.slice(0, cut);
  if (!t.trim()) { return ''; }
  t = limitToBlock(t, prefix);
  t = trimSuffixOverlap(t, suffix.replace(/\r\n/g, '\n'));
  const lines = t.split('\n');
  if (lines.length > MAX_FIM_LINES) { t = lines.slice(0, MAX_FIM_LINES).join('\n'); }
  t = t.replace(/\s+$/, '');
  return t.trim() ? t : '';
}
