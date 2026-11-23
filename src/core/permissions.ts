import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ToolKind } from './tool';

export type RuleEffect = 'allow' | 'ask' | 'deny';
export type RuleSource = 'policy' | 'user' | 'project' | 'local';

export interface PermissionRule {
  effect: RuleEffect;
  /** Canonical tool: `run_command`, `edit`, `read`, or a literal tool name / `mcp__x__*` wildcard. */
  tool: string;
  pattern?: string;
  source: RuleSource;
  raw: string;
}

export interface PermissionQuery {
  tool: string;
  kind?: ToolKind;
  args?: any;
  root: string;
  /** Overrides process.platform (path flavour and case rules). */
  platform?: NodeJS.Platform;
}

export interface PermissionDecision { effect?: RuleEffect; rule?: PermissionRule; reason?: string }

export interface LoadedPermissions {
  rules: PermissionRule[];
  errors: string[];
  /** Raw `hooks` object of each source that has one; feed to parseHooks. */
  hooks: Partial<Record<RuleSource, unknown>>;
}

const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'rename_symbol']);
const READ_TOOLS = new Set(['read_file', 'grep', 'glob_files', 'list_dir', 'search_code', 'repo_map', 'view_image']);
const SOURCE_RANK: Record<RuleSource, number> = { policy: 0, local: 1, project: 2, user: 3 };
const MAX_BRACE_EXPANSION = 64;

const canonicalTool = (name: string): string => {
  const l = name.toLowerCase();
  if (l === 'bash' || l === 'run_command') { return 'run_command'; }
  if (l === 'edit' || l === 'write') { return 'edit'; }
  if (l === 'read') { return 'read'; }
  return name;
};

const takesPattern = (tool: string): boolean =>
  tool === 'run_command' || tool === 'remote_exec' || tool === 'edit' || tool === 'read' || EDIT_TOOLS.has(tool) || READ_TOOLS.has(tool);

/** Parses one rule string. Returns null when malformed. */
export function parseRule(raw: string, effect: RuleEffect, source: RuleSource): PermissionRule | null {
  if (typeof raw !== 'string') { return null; }
  const s = raw.trim();
  if (!s) { return null; }
  const open = s.indexOf('(');
  if (open < 0) {
    if (s.includes(')') || !/^[A-Za-z0-9_.*-]+$/.test(s) || !/[A-Za-z0-9_]/.test(s)) { return null; }
    return { effect, tool: canonicalTool(s), source, raw };
  }
  if (!s.endsWith(')')) { return null; }
  const name = s.slice(0, open).trim();
  const pattern = s.slice(open + 1, -1).trim();
  if (!pattern || !/^[A-Za-z0-9_.-]+$/.test(name)) { return null; }
  const tool = canonicalTool(name);
  if (!takesPattern(tool)) { return null; }
  return { effect, tool, pattern, source, raw };
}

// ---------------------------------------------------------------- settings

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function ingest(data: unknown, source: RuleSource, label: string, out: LoadedPermissions): void {
  if (!isObject(data)) { out.errors.push(`${label}: settings must be a JSON object`); return; }
  if (data.hooks !== undefined) { out.hooks[source] = data.hooks; }
  const perms = data.permissions;
  if (perms === undefined) { return; }
  if (!isObject(perms)) { out.errors.push(`${label}: "permissions" must be an object`); return; }
  for (const effect of ['deny', 'ask', 'allow'] as RuleEffect[]) {
    const list = perms[effect];
    if (list === undefined) { continue; }
    if (!Array.isArray(list)) { out.errors.push(`${label}: permissions.${effect} must be an array`); continue; }
    for (const raw of list) {
      const rule = typeof raw === 'string' ? parseRule(raw, effect, source) : null;
      if (rule) { out.rules.push(rule); } else { out.errors.push(`${label}: malformed ${effect} rule ${JSON.stringify(raw)}`); }
    }
  }
}

/** Reads all settings layers. Missing files are fine; every other problem lands in `errors`. Never throws. */
export async function loadPermissionSettings(
  paths: { user?: string; project?: string; local?: string }, policy?: unknown,
): Promise<LoadedPermissions> {
  const out: LoadedPermissions = { rules: [], errors: [], hooks: {} };
  if (policy !== undefined && policy !== null) { ingest(policy, 'policy', 'policy', out); }
  for (const source of ['local', 'project', 'user'] as const) {
    const file = paths[source];
    if (!file) { continue; }
    let text: string;
    try { text = await fs.readFile(file, 'utf8'); } catch (e: any) {
      if (e?.code !== 'ENOENT') { out.errors.push(`${file}: ${e?.message ?? e}`); }
      continue;
    }
    try { ingest(JSON.parse(text.replace(/^\uFEFF/, '')), source, file, out); } catch (e: any) {
      out.errors.push(`${file}: invalid JSON (${e?.message ?? e})`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- wildcard matching (no regex, so no backtracking blowups)

/** `*` matches any run of characters; with `single`, `?` matches one. O(n*m) worst case. */
function wild(pat: string, s: string, single = false): boolean {
  let p = 0, i = 0, star = -1, mark = 0;
  while (i < s.length) {
    if (p < pat.length && pat[p] === '*') { star = p++; mark = i; }
    else if (p < pat.length && (pat[p] === s[i] || (single && pat[p] === '?'))) { p++; i++; }
    else if (star >= 0) { p = star + 1; i = ++mark; }
    else { return false; }
  }
  while (p < pat.length && pat[p] === '*') { p++; }
  return p === pat.length;
}

function expandBraces(glob: string): string[] {
  const out: string[] = [];
  const queue = [glob];
  while (queue.length) {
    const g = queue.pop()!;
    const close = g.indexOf('}');
    const open = close < 0 ? -1 : g.lastIndexOf('{', close);
    if (open < 0) { out.push(g); continue; }
    for (const alt of g.slice(open + 1, close).split(',')) {
      if (out.length + queue.length >= MAX_BRACE_EXPANSION) { return out.length ? out : [glob]; }
      queue.push(g.slice(0, open) + alt + g.slice(close + 1));
    }
  }
  return out;
}

/** Segment-wise glob match; `**` spans zero or more segments. */
function matchSegments(pats: string[], segs: string[]): boolean {
  let prev = new Array<boolean>(segs.length + 1).fill(false);
  prev[0] = true;
  for (const p of pats) {
    const cur = new Array<boolean>(segs.length + 1).fill(false);
    if (p === '**') {
      let seen = false;
      for (let j = 0; j <= segs.length; j++) { seen = seen || prev[j]; cur[j] = seen; }
    } else {
      for (let j = 1; j <= segs.length; j++) { cur[j] = prev[j - 1] && wild(p, segs[j - 1], true); }
    }
    prev = cur;
  }
  return prev[segs.length];
}

const splitPath = (p: string): string[] => p.split('/').filter(Boolean);
const globMatch = (glob: string, p: string): boolean =>
  expandBraces(glob).some((g) => matchSegments(splitPath(g), splitPath(p)));

// ---------------------------------------------------------------- paths

interface ResolvedPath { abs: string; rel?: string }

/** Windows ignores trailing dots/spaces and `:stream` suffixes, so `.env.` and `.env::$DATA` are `.env`. */
const win32Canonical = (p: string): string => p.split('/').map((seg, i) => {
  if (i === 0 && /^[a-z]:$/i.test(seg)) { return seg; }
  const noStream = seg.includes(':') ? seg.slice(0, seg.indexOf(':')) : seg;
  return noStream === '.' || noStream === '..' ? noStream : noStream.replace(/[. ]+$/, '');
}).join('/');

function resolvePath(raw: string, root: string, platform: NodeJS.Platform): ResolvedPath {
  const win = platform === 'win32';
  const lib = win ? path.win32 : path.posix;
  const fold = (s: string): string => (win ? s.toLowerCase() : s);
  const clean = (s: string): string => {
    const p = s.replace(/\\/g, '/').replace(/\/+$/, '');
    return fold(win ? win32Canonical(p) : p) || '/';
  };
  const absRoot = clean(lib.resolve(root));
  const abs = clean(lib.resolve(root, win ? raw.replace(/\//g, '\\') : raw));
  if (abs === absRoot) { return { abs, rel: '' }; }
  const prefix = absRoot.endsWith('/') ? absRoot : `${absRoot}/`;
  return abs.startsWith(prefix) ? { abs, rel: abs.slice(prefix.length) } : { abs };
}

function pathRuleMatches(rule: PermissionRule, target: ResolvedPath, root: string, platform: NodeJS.Platform): boolean {
  const win = platform === 'win32';
  const lib = win ? path.win32 : path.posix;
  let glob = rule.pattern!.replace(/\\/g, '/');
  if (glob === '~' || glob.startsWith('~/')) { glob = os.homedir().replace(/\\/g, '/') + glob.slice(1); }
  if (glob.endsWith('/')) { glob += '**'; }
  while (glob.startsWith('./')) { glob = glob.slice(2); }
  if (glob.startsWith('../') || glob === '..') {
    glob = path.posix.normalize(`${lib.resolve(root).replace(/\\/g, '/')}/${glob}`);
  } else if (win && glob.startsWith('/') && !glob.startsWith('//')) {
    glob = lib.parse(lib.resolve(root)).root.replace(/\\/g, '/') + glob.slice(1);
  }
  if (win) { glob = glob.toLowerCase(); }
  if (/^[a-z]:\//i.test(glob) || glob.startsWith('/')) { return globMatch(glob, target.abs); }
  if (target.rel === undefined) { return false; }
  if (glob.includes('/') || glob === '**') { return globMatch(glob, target.rel); }
  const segs = splitPath(target.rel);
  // A bare name matches at any depth. Restrictive rules also cover everything below a matching folder.
  return rule.effect === 'allow'
    ? segs.length > 0 && globMatch(glob, segs[segs.length - 1])
    : segs.some((s) => globMatch(glob, s));
}

// ---------------------------------------------------------------- shell parsing

/** Names whose value can hijack the command that follows, so they void auto-allow. */
const HIJACK_ENV = /^(?:PATH|PATHEXT|IFS|BASH_ENV|ENV|SHELLOPTS|PROMPT_COMMAND|LD_\w+|DYLD_\w+|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|GIT_\w+|NPM_CONFIG_\w+)$/i;
const HARMLESS_SINK = /^(?:\/dev\/null|nul|\$null|&\d|&-)$/i;
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'env', 'nohup', 'time', 'nice', 'ionice', 'exec', 'xargs', 'busybox', 'timeout', 'watch', 'start-process', 'start', 'call']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd']);
const EVALS = new Set(['eval', 'iex', 'invoke-expression']);
const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', '{', 'time']);
const MAX_DEPTH = 5;
const MAX_WRAPPER_SCAN = 8;

interface Word { text: string; assign: boolean }
interface RawSegment { words: Word[]; redirects: string[] }
interface Parsed { segments: RawSegment[]; unsafe: boolean; subs: string[] }

function closeParen(s: string, from: number): number {
  let depth = 1, q = '';
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) { q = ''; } continue; }
    if (c === '"' || c === "'") { q = c; }
    else if (c === '(') { depth++; }
    else if (c === ')' && --depth === 0) { return i; }
  }
  return -1;
}

/**
 * Tokenises a command line. `escapes` selects POSIX backslash handling; PowerShell and cmd treat a backslash
 * literally, so callers parse both ways and require agreement before trusting the result.
 */
function parseShell(cmd: string, escapes: boolean): Parsed {
  const segments: RawSegment[] = [];
  const subs: string[] = [];
  let unsafe = false;
  let seg: RawSegment = { words: [], redirects: [] };
  let word = '', inWord = false, assign = false, nameOk = true;
  let q = '';

  const endWord = (): void => {
    if (inWord) { seg.words.push({ text: word, assign }); }
    word = ''; inWord = false; assign = false; nameOk = true;
  };
  const endSeg = (): void => {
    endWord();
    if (seg.words.length || seg.redirects.length) { segments.push(seg); }
    seg = { words: [], redirects: [] };
  };
  const add = (c: string): void => { word += c; inWord = true; };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], n = cmd[i + 1];
    if (q !== "'") {
      if (c === '`') {
        const end = cmd.indexOf('`', i + 1);
        subs.push(cmd.slice(i + 1, end < 0 ? cmd.length : end));
        unsafe = true;
        if (end < 0) { break; }
        add(cmd.slice(i, end + 1)); i = end; continue;
      }
      if ((c === '$' || (!q && (c === '<' || c === '>'))) && n === '(') {
        const end = closeParen(cmd, i + 2);
        subs.push(cmd.slice(i + 2, end < 0 ? cmd.length : end));
        unsafe = true;
        if (end < 0) { break; }
        add(cmd.slice(i, end + 1)); i = end; continue;
      }
    }
    if (q) {
      if (c === q) { q = ''; }
      else if (escapes && q === '"' && c === '\\' && n !== undefined && '"\\$`\n'.includes(n)) { if (n !== '\n') { add(n); } i++; }
      else { add(c); }
      continue;
    }
    if (c === '"' || c === "'") { q = c; inWord = true; nameOk = false; continue; }
    if (c === '\\' && escapes && n !== undefined) {
      if (n === '\r' && cmd[i + 2] === '\n') { i += 2; continue; }
      if (n !== '\n') { add(n); nameOk = false; }
      i++; continue;
    }
    if (c === '>' || (c === '&' && n === '>')) {
      let j = i;
      let fd = '';
      if (/^\d$/.test(word)) { fd = word; word = ''; inWord = false; }
      while (j < cmd.length && (cmd[j] === '>' || cmd[j] === '&' || cmd[j] === '|')) {
        if (cmd[j] === '&' && /[\d-]/.test(cmd[j + 1] ?? '') && cmd[j - 1] === '>') { break; }
        j++;
      }
      while (cmd[j] === ' ' || cmd[j] === '\t') { j++; }
      let t = j;
      if (cmd[t] === '&') { t++; }
      while (t < cmd.length && !/[\s;|&<>()]/.test(cmd[t])) { t++; }
      const target = cmd.slice(j, t).replace(/["']/g, '');
      endWord();
      seg.redirects.push(`${fd}>${target}`);
      if (!HARMLESS_SINK.test(target)) { unsafe = true; }
      i = t - 1; continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '\r') {
      endSeg();
      if ((c === '|' || c === '&') && n === c) { i++; }
      continue;
    }
    if (c === '(' || c === ')') { endSeg(); unsafe = true; continue; }
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v') { endWord(); continue; }
    if (c === '=' && nameOk && inWord && !assign && /^[A-Za-z_]\w*$/.test(word)) { assign = true; }
    else if (!assign && !/\w/.test(c)) { nameOk = false; }
    add(c);
  }
  if (q) { unsafe = true; }
  endSeg();
  return { segments, unsafe, subs };
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
const commandName = (w: string): string => w.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1|sh)$/, '');

/** Leading env assignments removed; returns the words and whether any assignment was risky. */
function stripEnv(words: Word[]): { rest: string[]; hijack: boolean; onlyEnv: boolean } {
  let i = 0, hijack = false;
  while (i < words.length && words[i].assign) {
    if (HIJACK_ENV.test(words[i].text.slice(0, words[i].text.indexOf('=')))) { hijack = true; }
    i++;
  }
  return { rest: words.slice(i).map((w) => w.text), hijack, onlyEnv: i > 0 && i === words.length };
}

interface Analysis {
  /** Every normalised spelling of each segment, for deny/ask matching. */
  variants: string[][];
  /** Canonical segments for allow matching; empty when auto-allow is off the table. */
  allowable: string[];
  safe: boolean;
}

/** Spellings a deny rule must see: bare name, wrappers peeled, keywords dropped, `^` escapes removed. */
function spellings(rest: string[], redirects: string[], win: boolean, nested: string[]): string[] {
  const out = new Set<string>();
  const addForm = (ws: string[]): void => {
    if (!ws.length) { return; }
    const base = squash(ws.join(' '));
    out.add(base);
    out.add(squash([commandName(ws[0]), ...ws.slice(1)].join(' ')));
    if (win && base.includes('^')) { out.add(base.replace(/\^/g, '')); }
  };
  let ws = rest;
  while (ws.length > 1 && KEYWORDS.has(ws[0].toLowerCase())) { ws = ws.slice(1); }
  addForm(rest);
  addForm(ws);
  if (redirects.length) { out.add(squash([...ws, ...redirects].join(' '))); }
  if (!ws.length) { return [...out]; }
  const head = commandName(ws[0]);
  if (WRAPPERS.has(head)) {
    for (let i = 1; i < Math.min(ws.length, MAX_WRAPPER_SCAN); i++) { addForm(ws.slice(i)); }
  }
  if (EVALS.has(head)) { nested.push(ws.slice(1).join(' ')); }
  if (SHELLS.has(head)) {
    const flag = ws.findIndex((w, i) => i > 0 && /^(?:-[a-z]*c|\/c|\/k|-command)$/i.test(w));
    if (flag > 0) { nested.push(ws.slice(flag + 1).join(' ')); }
  }
  return [...out];
}

function analyse(cmd: string, win: boolean, depth = 0): Analysis {
  const posix = parseShell(cmd, true);
  const literal = parseShell(cmd, false);
  const variants: string[][] = [];
  const nested: string[] = [...posix.subs, ...literal.subs];
  let safe = !posix.unsafe && !literal.unsafe && posix.segments.length === literal.segments.length;
  const allowable: string[] = [];

  for (const parsed of [posix, literal]) {
    for (const s of parsed.segments) {
      const { rest, hijack, onlyEnv } = stripEnv(s.words);
      if (hijack || onlyEnv) { safe = false; }
      const before = nested.length;
      variants.push(spellings(rest, s.redirects, win, nested));
      if (nested.length > before) { safe = false; }
      if (parsed === literal && rest.length) { allowable.push(squash(rest.join(' '))); }
      if (rest.length && rest[0].startsWith('$')) { safe = false; }
    }
  }
  // PowerShell's backtick escape: r`m is rm.
  if (cmd.includes('`') && depth < MAX_DEPTH) {
    variants.push(...analyse(cmd.replace(/`\r?\n?/g, ''), win, depth + 1).variants);
  }
  if (depth < MAX_DEPTH) {
    for (const inner of nested) { if (inner.trim()) { variants.push(...analyse(inner, win, depth + 1).variants); } }
  } else if (nested.length) { safe = false; }
  return { variants, allowable: safe ? allowable : [], safe };
}

const normPattern = (p: string): string => squash(p.replace(/["']/g, ''));

// ---------------------------------------------------------------- evaluation

function appliesTo(rule: PermissionRule, tool: string, kind?: ToolKind): boolean {
  if (rule.tool === 'edit') { return EDIT_TOOLS.has(tool) || (!rule.pattern && rule.effect !== 'allow' && kind === 'edit'); }
  if (rule.tool === 'read') { return READ_TOOLS.has(tool) || (!rule.pattern && rule.effect !== 'allow' && kind === 'read'); }
  if (rule.tool.includes('*')) {
    return rule.effect === 'allow' ? wild(rule.tool, tool) : wild(rule.tool.toLowerCase(), tool.toLowerCase());
  }
  return rule.effect === 'allow' ? rule.tool === tool : rule.tool.toLowerCase() === tool.toLowerCase();
}

const bySource = (a: PermissionRule, b: PermissionRule): number => SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
const decided = (rule: PermissionRule): PermissionDecision => ({
  effect: rule.effect, rule, reason: `${rule.effect} rule "${rule.raw}" (${rule.source})`,
});

function evaluateCommand(rules: PermissionRule[], command: unknown, win: boolean): PermissionDecision {
  const text = typeof command === 'string' ? command : '';
  const info = analyse(text, win);
  const fold = (s: string): string => (win ? s.toLowerCase() : s);
  const cmdMatch = (r: PermissionRule, s: string): boolean => wild(fold(normPattern(r.pattern!)), fold(s));
  for (const effect of ['deny', 'ask'] as const) {
    const hit = rules.find((r) => r.effect === effect
      && (!r.pattern || info.variants.some((forms) => forms.some((f) => cmdMatch(r, f)))));
    if (hit) { return decided(hit); }
  }
  const allows = rules.filter((r) => r.effect === 'allow');
  if (!allows.length) { return {}; }
  if (!info.safe) { return { reason: 'command uses substitution, file redirection or unparsable syntax; allow rules do not apply' }; }
  if (!info.allowable.length) { return {}; }
  let first: PermissionRule | undefined;
  for (const seg of info.allowable) {
    const hit = allows.find((r) => !r.pattern || cmdMatch(r, seg));
    if (!hit) { return {}; }
    first ??= hit;
  }
  return decided(first!);
}

/** Applies the rules: deny > ask > allow across every source. No effect means the current mode decides. */
export function evaluatePermission(rules: PermissionRule[], q: PermissionQuery): PermissionDecision {
  const platform = q.platform ?? process.platform;
  const relevant = rules.filter((r) => appliesTo(r, q.tool, q.kind)).sort(bySource);
  if (!relevant.length) { return {}; }
  if (q.tool === 'run_command') { return evaluateCommand(relevant, q.args?.command, platform === 'win32'); }
  if (q.tool === 'remote_exec') {
    // remote_exec(prod:systemctl status*) applies to one server; remote_exec(systemctl status*) to every server.
    const server = String(q.args?.server ?? '');
    const scoped = relevant.flatMap((r) => {
      const m = r.pattern ? /^([A-Za-z0-9][\w.-]*):([\s\S]*)$/.exec(r.pattern) : null;
      if (!m) { return [r]; }
      return m[1] === server ? [{ ...r, pattern: m[2] || undefined }] : [];
    });
    return evaluateCommand(scoped, q.args?.command, false);
  }
  const raw = q.args?.path;
  const target = typeof raw === 'string' ? resolvePath(raw, q.root, platform) : undefined;
  for (const effect of ['deny', 'ask', 'allow'] as const) {
    const hit = relevant.find((r) => r.effect === effect
      && (!r.pattern || (target !== undefined && pathRuleMatches(r, target, q.root, platform))));
    if (hit) { return decided(hit); }
  }
  return {};
}
