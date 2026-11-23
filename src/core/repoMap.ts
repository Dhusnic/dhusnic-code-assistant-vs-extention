/**
 * Repo map: a compact structural overview of the workspace (folders, then the most used files with their key
 * definitions) for the system prompt, plus the read-only `repo_map` tool that shows more of it for a sub-folder.
 * Without it the model knows nothing about the project's shape and spends its first turns on glob_files and grep.
 *
 * Design:
 * - Files come from the shared, .gitignore-aware FileIndex (search.ts) and skip the same generated and non-text files
 *   as search_code (codeSearch.ts `skipFile`). Only known source extensions are parsed, capped by file count and size.
 * - Definitions are found with small per-language regexes (no parser, no dependencies): TS/JS, Python, Go,
 *   Java/Kotlin/C#, Rust, PHP and Ruby. They are approximate on purpose: the map says where to look, not what is true.
 * - Ranking is a cheap "who uses whom": a file scores by how many other files mention the names it defines
 *   (whole-identifier match, log-damped, shared by files defining the same name, generic names ignored). Entry points
 *   (main/index/app/server...) get a boost, tests a penalty; render() can boost files named in a user message.
 * - The index is in memory and incremental like codeSearch.ts: later refreshes re-read only files whose size or mtime
 *   changed. Each file keeps its definitions and its identifiers as one joined string (no slices of the file text).
 * - RepoMaps.promptSection is time-boxed: if the first build is not ready in time the section is left out and the
 *   build finishes in the background for the next turn. The rendered text only changes when files change, so it does
 *   not defeat the server's prompt prefix cache; for the same reason the prompt is not tuned to each user message.
 * - Budgets are in tokens at 3.5 characters per token, the estimate compaction.ts uses.
 * - Optional language-server refinement: the host may inject a SymbolProvider (document symbols, vscode-free shape
 *   LsSymbol) per root. It replaces the regex definitions only for languages where the regexes are weak (LS_LANGS:
 *   Java, Kotlin, C#, Go, PHP) and only for the files a render() actually showed (at most LS_MAX_FILES per pass), since
 *   each call opens a document and may wake a language server. render() never waits for it: it schedules one
 *   background pass at a time, with a per-call and a per-pass time box. Results live on the file's entry, so they are
 *   kept until the file's size or mtime changes. A throw, timeout or empty answer keeps the regex definitions; a file is
 *   tried LS_MAX_TRIES times and a language that only fails is paused for a while. The rendered text changes once when
 *   refined definitions arrive and is stable afterwards (no calls are repeated for unchanged files).
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { FileIndex } from './search';
import { skipFile } from './codeSearch';
import { Tool, ToolCtx, fnSpec } from './tool';
import { resolveIn, rootOf } from './fstools';

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 200_000;
const READ_CONCURRENCY = 32;
const CHARS_PER_TOKEN = 3.5;
export const DEFAULT_PROMPT_TOKENS = 1500;
const TOOL_TOKENS = 5000;
const PROMPT_SYMBOLS = 8;
const TOOL_SYMBOLS = 25;
const DEFAULT_TIMEOUT_MS = 1500;
/** Language-server refinement limits (see the design comment). */
const LS_MAX_FILES = 60;
const LS_CONCURRENCY = 4;
const LS_CALL_MS = 3000;
const LS_PASS_MS = 20_000;
const LS_MAX_TRIES = 3;
const LS_PAUSE_MS = 5 * 60_000;

type Lang = 'ts' | 'py' | 'go' | 'java' | 'kt' | 'cs' | 'rs' | 'php' | 'rb';
const LANG_BY_EXT: Record<string, Lang> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts', vue: 'ts', svelte: 'ts',
  py: 'py', go: 'go', java: 'java', kt: 'kt', kts: 'kt', cs: 'cs', rs: 'rs', php: 'php', rb: 'rb',
};
export const langOf = (file: string): Lang | undefined => LANG_BY_EXT[file.slice(file.lastIndexOf('.') + 1).toLowerCase()];
/** Languages whose regex definitions are refined with the language server when one is available. */
const LS_LANGS: ReadonlySet<Lang> = new Set<Lang>(['java', 'kt', 'cs', 'go', 'php']);

export type DefKind = 'class' | 'type' | 'function' | 'method' | 'const';
/** `local`: not visible outside the file (unexported in TS/JS, lower-case in Go, _name in Python); ranked lower. */
export interface Def { name: string; kind: DefKind; label: string; local?: true }

const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'super', 'new', 'else', 'do', 'try',
  'with', 'typeof', 'await', 'yield', 'throw', 'delete', 'void', 'using', 'lock', 'foreach', 'sizeof', 'synchronized']);
const ENTRY = /^(main|index|app|server|cli|program|manage|__main__|__init__|extension|mod|lib)$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|[._-](test|spec)s?\.[a-z]+$|(^|\/)test_[^/]*$/i;

const label = (kind: DefKind, name: string, owner?: string): string =>
  kind === 'function' || kind === 'method' ? `${owner ? `${owner}.` : ''}${name}()` : kind === 'const' ? name : `${kind === 'type' ? 'type' : 'class'} ${name}`;

/** Top-level definitions (and public methods of top-level classes) of one source file, in source order. */
export function extractSymbols(file: string, text: string): Def[] {
  const lang = langOf(file);
  if (!lang || text.includes('\u0000')) { return []; }
  const defs: Def[] = [];
  const seen = new Set<string>();
  const add = (kind: DefKind, name: string | undefined, display?: string, owner?: string): void => {
    if (!name || name.length < 2) { return; }
    const l = display ?? label(kind, name, owner);
    if (seen.has(l)) { return; }
    seen.add(l);
    const local = lang === 'ts' ? kind !== 'method' && !/^export\b/.test(line) : lang === 'go' ? /^[a-z_]/.test(name) : lang === 'py' && name.startsWith('_');
    defs.push({ name, kind, label: l, ...(local ? { local: true as const } : {}) });
  };
  let line = '';
  const lines = text.split(/\r?\n/);
  let inClass = false;
  let depth = 0;
  let m: RegExpMatchArray | null;
  for (line of lines) {
    switch (lang) {
      case 'ts': {
        if ((m = line.match(/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) {
          add('class', m[1]); inClass = true; depth = braceDelta(line); continue;
        }
        if (/^\}/.test(line)) { inClass = false; }
        if ((m = line.match(/^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) { add('function', m[1]); continue; }
        if ((m = line.match(/^(?:export\s+)?(?:declare\s+)?(interface|type|enum|const\s+enum)\s+([A-Za-z_$][\w$]*)/))) {
          add('type', m[2], `${m[1] === 'const enum' ? 'enum' : m[1]} ${m[2]}`); continue;
        }
        if ((m = line.match(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>/))) { add('function', m[1]); continue; }
        if ((m = line.match(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/))) { add('const', m[1]); continue; }
        // Unexported top-level functions still structure a file (scripts, webview code): keep them too.
        if ((m = line.match(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) { add('function', m[1]); continue; }
        if (inClass) {
          // Members sit at brace depth 1 of the class body; deeper lines are method bodies (calls look like methods).
          if (depth === 1 && (m = line.match(/^\s+(?:(?:public|protected|static|async|override|readonly|abstract|get|set)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/))
            && !/^\s*(private\b|#)/.test(line) && !NOT_METHOD.has(m[1])) { add('method', m[1]); }
          depth += braceDelta(line);
        }
        break;
      }
      case 'py': {
        if ((m = line.match(/^class\s+([A-Za-z_]\w*)/))) { add('class', m[1]); inClass = true; continue; }
        if ((m = line.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/))) { add('function', m[1]); inClass = false; continue; }
        if (/^\S/.test(line) && !/^[#@)\]}]/.test(line)) { inClass = false; }
        if (inClass && (m = line.match(/^(?: {4}|\t)(?:async\s+)?def\s+([A-Za-z]\w*|__init__)/))) { add('method', m[1]); }
        break;
      }
      case 'go': {
        if ((m = line.match(/^func\s+\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)[^)]*\)\s*([A-Za-z_]\w*)/))) { add('method', m[2], undefined, m[1]); continue; }
        if ((m = line.match(/^func\s+([A-Za-z_]\w*)/))) { add('function', m[1]); continue; }
        if ((m = line.match(/^type\s+([A-Za-z_]\w*)\s+(struct|interface)?/))) { add(m[2] ? 'class' : 'type', m[1], `type ${m[1]}`); }
        break;
      }
      case 'java': case 'cs': case 'kt': {
        if ((m = line.match(/^\s*(?:(?:public|protected|internal|abstract|static|final|sealed|partial|data|open|enum|annotation|inner|readonly|record)\s+)*(class|interface|enum|record|object|struct)\s+([A-Za-z_]\w*)/))
          && !/^\s*(private)\s/.test(line)) {
          add(m[1] === 'interface' ? 'type' : 'class', m[2], `${m[1]} ${m[2]}`); continue;
        }
        if (lang === 'kt') {
          if ((m = line.match(/^\s*(?:(?:public|internal|override|suspend|inline|open|operator)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/)) && !/^\s*(private|protected)\s/.test(line)) { add('function', m[1]); }
        } else if ((m = line.match(/^\s+public\s+(?:(?:static|async|override|virtual|abstract|final|synchronized|sealed|new|extern|unsafe)\s+)*(?:<[^>]*>\s*)?[\w<>[\],.?\s]*?\s([A-Za-z_]\w*)\s*\(/))
          && !NOT_METHOD.has(m[1])) { add('method', m[1]); }
        break;
      }
      case 'rs': {
        if ((m = line.match(/^\s*pub(?:\([^)]*\))?\s+(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/))) { add('function', m[1]); continue; }
        if ((m = line.match(/^\s*pub(?:\([^)]*\))?\s+(struct|enum|trait|type)\s+([A-Za-z_]\w*)/))) { add(m[1] === 'struct' || m[1] === 'enum' ? 'class' : 'type', m[2], `${m[1]} ${m[2]}`); continue; }
        if ((m = line.match(/^fn\s+(main)\b/))) { add('function', m[1]); }
        break;
      }
      case 'php': {
        if ((m = line.match(/^\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/))) { add(m[1] === 'class' ? 'class' : 'type', m[2], `${m[1]} ${m[2]}`); continue; }
        if ((m = line.match(/^function\s+([A-Za-z_]\w*)/))) { add('function', m[1]); continue; }
        if ((m = line.match(/^\s+(?:(?:public|static|abstract|final)\s+)*function\s+([A-Za-z_]\w*)/)) && !/\b(private|protected)\b/.test(line.slice(0, line.indexOf('function')))) {
          if (!m[1].startsWith('__') || m[1] === '__construct') { add('method', m[1]); }
        }
        break;
      }
      case 'rb': {
        if ((m = line.match(/^\s*(class|module)\s+([A-Z]\w*(?:::[A-Z]\w*)*)/))) { add('class', m[2], `${m[1]} ${m[2]}`); continue; }
        if ((m = line.match(/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/))) { add('method', m[1].replace(/[=]$/, ''), `${m[1]}()`); }
        break;
      }
    }
  }
  return defs;
}

/** Change in brace depth over a line, ignoring braces inside string literals and line comments (approximate). */
function braceDelta(line: string): number {
  const code = line.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""').replace(/\/\/.*$/, '');
  let d = 0;
  for (const c of code) { if (c === '{') { d++; } else if (c === '}') { d--; } }
  return d;
}

/**
 * A document symbol as a language server reports it, without vscode types: `kind` is the SymbolKind name ("Class",
 * "Method", ...) and `line` the source line holding the symbol's name (used for visibility keywords).
 */
export interface LsSymbol { name: string; kind: string; line?: string; children?: LsSymbol[] }
/** Document symbols of one file (absolute path), or undefined/empty when no language server answers. */
export type SymbolProvider = (absPath: string, signal: AbortSignal) => Promise<LsSymbol[] | undefined>;

const LS_CONTAINERS = new Set(['File', 'Module', 'Namespace', 'Package']);
const LS_TYPES = new Set(['Class', 'Struct', 'Interface', 'Enum', 'Object']);
const LS_FUNCS = new Set(['Function', 'Method', 'Constructor']);
const escapeRe = (s: string): string => s.replace(/[$]/g, '\\$');

/**
 * Map definitions from document symbols, keeping what extractSymbols would keep: types (top-level and nested, not
 * private), top-level functions, and the visible methods of types (public in Java/C# unless in an interface, not
 * private/protected in Kotlin/PHP). Fields, properties, variables and local functions are left out.
 */
export function defsFromSymbols(file: string, symbols: LsSymbol[]): Def[] {
  const lang = langOf(file);
  if (!lang) { return []; }
  const defs: Def[] = [];
  const seen = new Set<string>();
  const add = (kind: DefKind, name: string, l: string): void => {
    if (name.length < 2 || seen.has(l)) { return; }
    seen.add(l);
    const local = lang === 'go' ? /^[a-z_]/.test(name) : lang === 'py' && name.startsWith('_');
    defs.push({ name, kind, label: l, ...(local ? { local: true as const } : {}) });
  };
  const visit = (list: LsSymbol[], owner: LsSymbol | undefined, depth: number): void => {
    if (depth > 6) { return; }
    for (const s of list) {
      if (typeof s?.name !== 'string') { continue; }
      if (LS_CONTAINERS.has(s.kind)) { if (!owner) { visit(s.children ?? [], undefined, depth + 1); } continue; }
      // gopls names methods "(*Server).Start"; other servers may add a signature ("find(long)") or generics.
      const recv = lang === 'go' ? /^\(\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\)\.([A-Za-z_]\w*)$/.exec(s.name) : null;
      const name = recv ? recv[2] : s.name.trim().replace(/[\s<([:].*$/, '');
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) { continue; }
      const line = s.line ?? '';
      const at = line.search(new RegExp(`(^|[^\\w$])${escapeRe(name)}([^\\w$]|$)`));
      const pre = at < 0 ? line : line.slice(0, at + 1);
      const hidden = lang === 'kt' || lang === 'php' ? /\b(private|protected)\b/.test(pre) : /\bprivate\b/.test(pre);
      if (LS_TYPES.has(s.kind)) {
        if (hidden && lang !== 'go') { continue; }
        const kw = new RegExp(`\\b(class|interface|enum|record|object|struct|trait|type)\\s+${escapeRe(name)}\\b`).exec(line)?.[1]
          ?? (lang === 'go' ? 'type' : s.kind.toLowerCase());
        const kind: DefKind = lang === 'go'
          ? (s.kind === 'Struct' || s.kind === 'Interface' ? 'class' : 'type')
          : (kw === 'interface' || kw === 'trait' || kw === 'type' ? 'type' : 'class');
        add(kind, name, `${kw} ${name}`);
        visit(s.children ?? [], s, depth + 1);
      } else if (LS_FUNCS.has(s.kind)) {
        if (s.kind === 'Constructor' && name !== '__construct' && name !== '__init__') { continue; }
        if (lang !== 'go' && hidden) { continue; }
        if (owner || recv || s.kind === 'Method') {
          // Java and C# members are only shown when public (interface members are public implicitly).
          if ((lang === 'java' || lang === 'cs') && owner && owner.kind !== 'Interface' && line && !/\bpublic\b/.test(pre)) { continue; }
          if (lang === 'php' && name.startsWith('__') && name !== '__construct') { continue; }
          add('method', name, label('method', name, recv?.[1]));
        } else {
          add('function', name, label('function', name));
        }
      }
    }
  };
  visit(symbols, undefined, 0);
  return defs;
}

/** Identifiers of a file (3+ characters), unique. */
function identifiers(text: string): string[] {
  return [...new Set(text.match(/[A-Za-z_$][\w$]{2,}/g) ?? [])];
}

/** `ls`: the language server answered for this version of the file; `lsFails`: unanswered attempts so far. */
interface FileEntry { mtimeMs: number; size: number; defs: Def[]; ids: string; ls?: true; lsFails?: number }

export interface RepoMapOptions {
  /** Language-server symbols for this root; called per pass, so a setting can turn it off (undefined = off). */
  symbols?: () => SymbolProvider | undefined;
  /** Time box of one provider call (default 3000 ms). */
  lsCallMs?: number;
  /** Time box of one refinement pass (default 20 s). */
  lsPassMs?: number;
}
interface Ranked { file: string; score: number; defs: Array<Def & { refs: number }> }

export interface RenderOptions {
  /** Token budget for the whole text (default 1500). */
  budgetTokens?: number;
  /** Only files under this folder (relative to the root, '/' separators). */
  under?: string;
  /** At most this many files listed. */
  maxFiles?: number;
  /** Symbols shown per file (default 8). */
  maxSymbols?: number;
  /** Files (relative paths) to rank first, e.g. those named in the user's message. */
  mentioned?: string[];
  /** Prefix added to every path shown (multi-root: "<folder name>/"). */
  pathPrefix?: string;
  /** Short header for the system prompt instead of the tool's. */
  forPrompt?: boolean;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !signal?.aborted) { await fn(items[next++]); }
  }));
}

/** In-memory repo map of one workspace folder. */
export class RepoMap {
  private files = new Map<string, FileEntry>();
  /** Every indexable file (source or not), for the folder summary. */
  private all: string[] = [];
  private refreshing?: Promise<void>;
  private ranked?: Ranked[];
  /** True once a full build has finished. */
  built = false;
  /** More source files than MAX_FILES: the rest are not parsed. */
  truncated = false;
  /** Duration of the last refresh in ms. */
  lastBuildMs = 0;

  private refining?: Promise<void>;
  /** Languages whose server only failed recently, with the time they may be tried again. */
  private lsPaused = new Map<Lang, number>();
  /** Provider calls made (for diagnostics and tests). */
  lsCalls = 0;

  constructor(readonly root: string, private fileIndex: FileIndex = new FileIndex(root), private opts: RepoMapOptions = {}) {}

  /** The running language-server refinement pass, if any (resolves when it ends; never rejects). */
  refinement(): Promise<void> { return this.refining ?? Promise.resolve(); }

  /** Starts a background refinement of these files (those a render showed) unless one is running or none qualifies. */
  private scheduleRefine(files: string[]): void {
    if (this.refining || !files.length) { return; }
    let provider: SymbolProvider | undefined;
    try { provider = this.opts.symbols?.(); } catch { provider = undefined; }
    if (!provider) { return; }
    const now = Date.now();
    const todo = files.filter((f) => {
      const lang = langOf(f);
      const e = this.files.get(f);
      return !!lang && LS_LANGS.has(lang) && !!e && !e.ls && (e.lsFails ?? 0) < LS_MAX_TRIES && e.size <= MAX_FILE_BYTES
        && (this.lsPaused.get(lang) ?? 0) <= now;
    }).slice(0, LS_MAX_FILES);
    if (!todo.length) { return; }
    this.refining = this.refine(todo, provider).catch(() => undefined).finally(() => { this.refining = undefined; });
  }

  private async refine(todo: string[], provider: SymbolProvider): Promise<void> {
    const ac = new AbortController();
    const passTimer = setTimeout(() => ac.abort(), this.opts.lsPassMs ?? LS_PASS_MS);
    passTimer.unref?.();
    const stats = new Map<Lang, { ok: number; fail: number }>();
    try {
      await mapLimit(todo, LS_CONCURRENCY, async (rel) => {
        const lang = langOf(rel)!;
        const entry = this.files.get(rel);
        if (!entry || entry.ls || (this.lsPaused.get(lang) ?? 0) > Date.now()) { return; }
        let syms: LsSymbol[] | undefined;
        let timer: NodeJS.Timeout | undefined;
        try {
          this.lsCalls++;
          const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), this.opts.lsCallMs ?? LS_CALL_MS); timer.unref?.(); });
          syms = await Promise.race([provider(path.join(this.root, rel), ac.signal), timeout]);
        } catch {
          syms = undefined;
        } finally {
          clearTimeout(timer);
        }
        const st = stats.get(lang) ?? { ok: 0, fail: 0 };
        stats.set(lang, st);
        if (!Array.isArray(syms) || !syms.length) {
          entry.lsFails = (entry.lsFails ?? 0) + 1;
          // No server for this language (or it is not ready): stop asking for a while instead of opening every file.
          if (++st.fail >= 3 && !st.ok) { this.lsPaused.set(lang, Date.now() + LS_PAUSE_MS); }
          return;
        }
        st.ok++;
        if (this.files.get(rel) !== entry) { return; } // re-read meanwhile: the answer may be for older text
        entry.ls = true;
        let defs: Def[] = [];
        try { defs = JSON.parse(JSON.stringify(defsFromSymbols(rel, syms))); } catch { defs = []; }
        if (defs.length && defs.map((d) => d.label).join('\n') !== entry.defs.map((d) => d.label).join('\n')) {
          entry.defs = defs;
          this.ranked = undefined;
        }
      }, ac.signal);
    } finally {
      clearTimeout(passTimer);
    }
  }

  /** Brings the map up to date: new and changed source files are (re)parsed, deleted ones dropped. */
  refresh(signal?: AbortSignal): Promise<void> {
    this.refreshing ??= this.doRefresh(signal).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async doRefresh(signal?: AbortSignal): Promise<void> {
    const t0 = Date.now();
    const all = (await this.fileIndex.files()).filter((f) => !skipFile(f));
    const sources = all.filter((f) => langOf(f));
    this.truncated = sources.length > MAX_FILES;
    const wanted = sources.slice(0, MAX_FILES);
    const keep = new Set(wanted);
    let changed = all.length !== this.all.length || all.some((f, i) => f !== this.all[i]);
    this.all = all;
    for (const f of this.files.keys()) { if (!keep.has(f)) { this.files.delete(f); changed = true; } }
    await mapLimit(wanted, READ_CONCURRENCY, async (rel) => {
      try {
        const abs = path.join(this.root, rel);
        const st = await fs.stat(abs);
        const old = this.files.get(rel);
        if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) { return; }
        let defs: Def[] = [], ids = '';
        if (st.size <= MAX_FILE_BYTES) {
          const text = await fs.readFile(abs, 'utf8');
          // A JSON round trip copies the names, so the entry keeps no slice of the (large) file text alive.
          defs = JSON.parse(JSON.stringify(extractSymbols(rel, text)));
          ids = identifiers(text).join(' ');
        }
        this.files.set(rel, { mtimeMs: st.mtimeMs, size: st.size, defs, ids });
        changed = true;
      } catch {
        if (this.files.delete(rel)) { changed = true; }
      }
    }, signal);
    if (signal?.aborted) { return; }
    if (changed) { this.ranked = undefined; }
    this.built = true;
    this.lastBuildMs = Date.now() - t0;
  }

  /** Files with definitions, best first (cached until files change). */
  rank(): Ranked[] {
    if (this.ranked) { return this.ranked; }
    const entries = [...this.files.entries()];
    const definers = new Map<string, number>();
    for (const [, e] of entries) { for (const n of new Set(e.defs.map((d) => d.name))) { definers.set(n, (definers.get(n) ?? 0) + 1); } }
    // Files that mention each defined name (including the definers themselves).
    const df = new Map<string, number>();
    for (const [, e] of entries) {
      if (!e.ids) { continue; }
      for (const id of e.ids.split(' ')) { if (definers.has(id)) { df.set(id, (df.get(id) ?? 0) + 1); } }
    }
    const n = entries.length;
    const out: Ranked[] = [];
    for (const [file, e] of entries) {
      if (!e.defs.length) { continue; }
      let score = 0;
      const defs = e.defs.map((d) => {
        const owners = definers.get(d.name) ?? 1;
        // Names this file mentions count it among df; the files that only define the name are not references.
        const refs = Math.max(0, (df.get(d.name) ?? 0) - owners);
        return { ...d, refs };
      });
      const counted = new Set<string>();
      for (const d of defs) {
        if (counted.has(d.name)) { continue; }
        counted.add(d.name);
        // Names found in most files (get, run, init, data) say nothing about this file.
        if (n >= 10 && d.refs > n * 0.5) { continue; }
        // Methods and file-local names are referenced through other names (obj.send, imports): weigh them less.
        score += Math.log2(1 + d.refs) / (definers.get(d.name) ?? 1) * (d.kind === 'method' || d.local ? 0.3 : 1);
      }
      const base = path.posix.basename(file).replace(/\.[^.]+$/, '');
      if (ENTRY.test(base)) { score += 3 / (1 + file.split('/').length - 1); }
      if (TEST_PATH.test(file)) { score *= 0.3; }
      out.push({ file, score, defs });
    }
    out.sort((a, b) => b.score - a.score || a.file.split('/').length - b.file.split('/').length || a.file.localeCompare(b.file));
    this.ranked = out;
    return out;
  }

  /** The map as text, within the token budget. Empty when there is nothing to show. */
  render(o: RenderOptions = {}): string {
    const budget = Math.max(200, Math.floor((o.budgetTokens ?? DEFAULT_PROMPT_TOKENS) * CHARS_PER_TOKEN));
    const under = (o.under ?? '').replace(/\\/g, '/').replace(/^\.\/?|\/+$/g, '').replace(/^\/+/, '');
    const inScope = (f: string): boolean => !under || f === under || f.startsWith(`${under}/`);
    const pre = o.pathPrefix ?? '';
    const mentioned = new Set((o.mentioned ?? []).map((f) => f.replace(/\\/g, '/')));
    let ranked = this.rank().filter((r) => inScope(r.file));
    if (mentioned.size) { ranked = [...ranked.filter((r) => mentioned.has(r.file)), ...ranked.filter((r) => !mentioned.has(r.file))]; }
    const files = this.all.filter(inScope);
    if (!files.length) { return ''; }
    const maxSymbols = o.maxSymbols ?? (o.forPrompt ? PROMPT_SYMBOLS : TOOL_SYMBOLS);
    const head = o.forPrompt
      ? '# Repository map\nGenerated from the code; approximate. Use it to decide where to look, then read the files. The repo_map tool shows more (e.g. for one folder).'
      : `Repository map${under ? ` of ${pre}${under}/` : ''} (${files.length} files; approximate, generated from the code):`;
    const parts = [head, this.folderSummary(files, under, pre)];
    let used = parts.join('\n').length + 1;
    const limit = Math.min(ranked.length, o.maxFiles ?? Number.MAX_SAFE_INTEGER);
    const lines: string[] = [];
    const note = (left: number): string => `(${left} more file${left === 1 ? '' : 's'} with definitions; use repo_map with a path to expand)`;
    let shown = 0;
    for (; shown < limit; shown++) {
      const line = this.fileLine(ranked[shown], maxSymbols, pre);
      const reserve = shown + 1 < ranked.length ? note(ranked.length).length + 1 : 0;
      if (used + line.length + 1 + reserve > budget) { break; }
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length) { parts.push(o.forPrompt ? 'Key files (most used first):' : 'Files (most used first):', ...lines); }
    if (shown < ranked.length) { parts.push(note(ranked.length - shown)); }
    if (this.truncated) { parts.push(`(only the first ${MAX_FILES} source files are mapped)`); }
    // Only what was shown is worth a language-server call; the refined text is used from the next render on.
    this.scheduleRefine(ranked.slice(0, lines.length).map((r) => r.file));
    return parts.join('\n');
  }

  private fileLine(r: Ranked, maxSymbols: number, pre: string): string {
    const order = (d: Def & { refs: number }): number =>
      (d.kind === 'class' || d.kind === 'type' ? 2 : d.kind === 'method' ? 0 : 1) - (d.local ? 2 : 0) + Math.log2(1 + d.refs) * (d.kind === 'method' ? 0.3 : 1);
    const keep = new Set([...r.defs].sort((a, b) => order(b) - order(a)).slice(0, maxSymbols));
    const shown = r.defs.filter((d) => keep.has(d)).map((d) => d.label);
    const more = r.defs.length - shown.length;
    return `${pre}${r.file}: ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`;
  }

  /** "Folders: src/ (120: core 60, host 30), docs/ (3); 5 files at the top level". */
  private folderSummary(files: string[], under: string, pre: string): string {
    const base = under ? `${under}/` : '';
    const top = new Map<string, number>();
    const sub = new Map<string, Map<string, number>>();
    let loose = 0;
    for (const f of files) {
      if (base && !f.startsWith(base)) { loose++; continue; }
      const rest = f.slice(base.length).split('/');
      if (rest.length < 2) { loose++; continue; }
      top.set(rest[0], (top.get(rest[0]) ?? 0) + 1);
      if (rest.length > 2) {
        const m = sub.get(rest[0]) ?? new Map<string, number>();
        m.set(rest[1], (m.get(rest[1]) ?? 0) + 1);
        sub.set(rest[0], m);
      }
    }
    const dirs = [...top.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const shown = dirs.slice(0, 15).map(([d, c]) => {
      const s = sub.get(d);
      // Break down only the folders that hold a large part of the files: that is where the structure is.
      const detail = s && s.size > 1 && c >= files.length * 0.3
        ? `: ${[...s.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([n, k]) => `${n} ${k}`).join(', ')}${s.size > 10 ? ', ...' : ''}`
        : '';
      return `${pre}${base}${d}/ (${c}${detail})`;
    });
    const extra = dirs.length > 15 ? `, +${dirs.length - 15} more folders` : '';
    const where = under ? `directly in ${pre}${under}/` : 'at the top level';
    return `Folders: ${shown.length ? shown.join(', ') : '(none)'}${extra}${loose ? `; ${loose} file${loose === 1 ? '' : 's'} ${where}` : ''}`;
  }
}

/** Repo maps per workspace folder, shared by the system prompt and the repo_map tool. */
export class RepoMaps {
  private maps = new Map<string, RepoMap>();

  /** `symbolsFor`: the language-server symbol provider for a root (undefined: regex only), asked on every pass. */
  constructor(private indexFor: (root: string) => FileIndex = (root) => new FileIndex(root),
    private opts: { symbolsFor?: (root: string) => SymbolProvider | undefined } = {}) {}

  get(root: string): RepoMap {
    let m = this.maps.get(root);
    if (!m) {
      const symbolsFor = this.opts.symbolsFor;
      m = new RepoMap(root, this.indexFor(root), symbolsFor ? { symbols: () => symbolsFor(root) } : {});
      this.maps.set(root, m);
    }
    return m;
  }

  /**
   * The system-prompt section, waiting at most `timeoutMs` for the map to be (re)built. When the first build is not
   * done in time it returns '' and the build carries on in the background for the next request.
   */
  async promptSection(root: string, o: { budgetTokens?: number; timeoutMs?: number } = {}): Promise<string> {
    const m = this.get(root);
    const building = m.refresh().then(() => true, () => false);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), o.timeoutMs ?? DEFAULT_TIMEOUT_MS); timer.unref?.(); });
    const done = await Promise.race([building, timeout]);
    clearTimeout(timer);
    if (!done && !m.built) { return ''; }
    try { return m.render({ budgetTokens: o.budgetTokens, forPrompt: true }); } catch { return ''; }
  }
}

/** The read-only repo_map tool. */
export function repoMapTool(maps: RepoMaps): Tool {
  return {
    kind: 'read',
    spec: fnSpec('repo_map',
      'Show the structure of the workspace or one folder of it: sub-folders with file counts, then source files (most used first) with their main classes, functions and types. Use it to get oriented in an unfamiliar area before grep/read_file. Approximate: read the files before relying on details.',
      {
        path: { type: 'string', description: 'optional folder (or file) to map, relative to the workspace root' },
        max_files: { type: 'number', description: 'maximum number of files to list (default: as many as fit)' },
      }, []),
    describe: (a) => `Repo map${a?.path ? ` of ${a.path}` : ''}`,
    async run(a, ctx: ToolCtx) {
      let root = ctx.root, under = '', prefix = '';
      if (a?.path) {
        const abs = resolveIn(ctx, String(a.path));
        const r = rootOf(ctx, abs) ?? { name: '', path: ctx.root };
        const primary = path.resolve(r.path).toLowerCase() === path.resolve(ctx.root).toLowerCase();
        root = primary ? ctx.root : r.path;
        prefix = primary ? '' : `${r.name}/`;
        under = path.relative(root, abs).split(path.sep).join('/');
      }
      const m = maps.get(root);
      await m.refresh(ctx.signal);
      const max = typeof a?.max_files === 'number' && a.max_files > 0 ? Math.floor(a.max_files) : undefined;
      const text = m.render({ budgetTokens: TOOL_TOKENS, under, maxFiles: max, pathPrefix: prefix });
      return text || `(no files${under ? ` under ${a.path}` : ''})`;
    },
  };
}
