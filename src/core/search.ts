import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { IgnoreMatcher, SKIP_DIRS, createIgnore, matchesGlob } from './glob';

const WALK_CONCURRENCY = 16;
const SCAN_CONCURRENCY = 32;
const MAX_FILE_BYTES = 1_000_000;
const PER_FILE_MATCH_CAP = 30;
const MAX_LINE_CHARS = 200;
const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_MATCH_CAP = 50;

/** Extensions that never hold searchable source: skipping them avoids opening thousands of useless files. */
export const NON_TEXT_EXT = [
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'bmp', 'webp', 'svg', 'woff', 'woff2', 'ttf', 'eot', 'otf', 'pdf', 'zip', 'gz', 'tgz', 'tar', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'bin', 'pyc', 'pyo', 'class', 'jar', 'war', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'mp3', 'mp4', 'mov', 'avi', 'wav',
  'map', 'lock', 'log', 'ndjson', 'sqlite', 'db', 'pcap', 'dmp',
];
const NON_TEXT_RE = new RegExp(`(\\.(${NON_TEXT_EXT.join('|')})|\\.min\\.(js|css)|package-lock\\.json)$`, 'i');

/** How many matches to collect before stopping: enough to rank and show, no more. */
export const matchCap = (o: { maxResults?: number }): number => Math.max(MIN_MATCH_CAP, (o.maxResults ?? 100) * 2);

/* ------------------------------------------------------------------ file index */

interface Layer { base: string; matcher: IgnoreMatcher }

/** Deeper .gitignore files override shallower ones; within a file the last matching rule wins. */
function isIgnored(rel: string, isDir: boolean, layers: Layer[]): boolean {
  let result = false;
  for (const l of layers) {
    const sub = l.base ? rel.slice(l.base.length + 1) : rel;
    const t = l.matcher.test(sub, isDir);
    if (t !== undefined) { result = t; }
  }
  return result;
}

/** Lists every non-ignored file (POSIX-style relative paths), walking directories in parallel. */
export async function indexFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  const queue: Array<{ dir: string; rel: string; layers: Layer[] }> = [{ dir: root, rel: '', layers: [] }];
  let active = 0;

  const visit = async (item: { dir: string; rel: string; layers: Layer[] }): Promise<void> => {
    let ents;
    try { ents = await fs.readdir(item.dir, { withFileTypes: true }); } catch { return; }
    let layers = item.layers;
    if (ents.some((e) => e.isFile() && e.name === '.gitignore')) {
      try {
        const lines = (await fs.readFile(path.join(item.dir, '.gitignore'), 'utf8')).split('\n');
        layers = [...layers, { base: item.rel, matcher: createIgnore(lines) }];
      } catch { /* unreadable .gitignore: ignore it */ }
    }
    for (const e of ents) {
      const rel = item.rel ? `${item.rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || isIgnored(rel, true, layers)) { continue; }
        queue.push({ dir: path.join(item.dir, e.name), rel, layers });
      } else if (e.isFile() && !isIgnored(rel, false, layers)) { out.push(rel); }
    }
  };

  await new Promise<void>((resolve) => {
    const pump = (): void => {
      while (active < WALK_CONCURRENCY && queue.length && !signal?.aborted) {
        const item = queue.pop()!;
        active++;
        void visit(item).finally(() => { active--; pump(); });
      }
      if (active === 0 && (queue.length === 0 || signal?.aborted)) { resolve(); }
    };
    pump();
  });
  return out.sort();
}

/** Cached, .gitignore-aware list of workspace files shared by every search feature. */
export class FileIndex {
  private cached?: { at: number; files: string[] };
  private building?: Promise<string[]>;
  private generation = 0;

  constructor(readonly root: string, private ttlMs = 60_000) {}

  invalidate(): void { this.generation++; this.cached = undefined; }

  /** The cached list if one exists (never triggers a build). */
  peek(): string[] | undefined { return this.cached?.files; }

  async files(): Promise<string[]> {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) { return this.cached.files; }
    if (!this.building) {
      const gen = this.generation;
      this.building = indexFiles(this.root).then((files) => {
        if (gen === this.generation) { this.cached = { at: Date.now(), files }; }
        return files;
      }).finally(() => { this.building = undefined; });
    }
    return this.building;
  }
}

/* ------------------------------------------------------------------ ripgrep discovery */

export function ripgrepCandidates(appRoot: string, platform: string = process.platform, arch: string = process.arch): string[] {
  const exe = platform === 'win32' ? 'rg.exe' : 'rg';
  return [
    path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
    path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
    path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', `${platform}-${arch}`, exe),
  ];
}

/** First working ripgrep from: the user's setting, VS Code's bundled copies, then `rg` on PATH. */
export async function findRipgrep(candidates: string[], userPath?: string): Promise<string | undefined> {
  for (const c of [userPath, ...candidates, 'rg']) {
    if (!c) { continue; }
    if (c !== 'rg') { try { await fs.access(c); } catch { continue; } }
    try { if (spawnSync(c, ['--version'], { timeout: 5000, windowsHide: true }).status === 0) { return c; } } catch { /* try next */ }
  }
  return undefined;
}

/* ------------------------------------------------------------------ search */

export type SearchMode = 'content' | 'files' | 'count';

export interface SearchOptions {
  pattern: string;
  glob?: string;
  /** Sub-directory (relative to the workspace root) to search in. */
  path?: string;
  mode?: SearchMode;
  context?: number;
  ignoreCase?: boolean;
  maxResults?: number;
  /** Time budget in ms (default 20s). Partial results are returned when it runs out. */
  timeoutMs?: number;
}

export interface MatchLine { line: number; text: string; ctx: boolean }
export interface FileMatches { file: string; count: number; lines: MatchLine[] }
export interface SearchResult {
  files: FileMatches[]; totalMatches: number; truncated: boolean; engine: 'rg' | 'js'; ms: number;
  /** The time budget ran out: results are partial. */
  timedOut?: boolean;
  /** Where the files are (top-level folders), to help the caller pick a narrower scope. */
  hint?: string;
}
type Partial_ = Omit<SearchResult, 'engine' | 'ms'>;
export type EnginePreference = 'auto' | 'ripgrep' | 'builtin';

export interface SearchEngine {
  root: string;
  index: FileIndex;
  rgPath?: string;
  /** auto: indexed built-in engine when the index is warm, ripgrep otherwise. */
  prefer?: EnginePreference;
}

class RegexUnsupported extends Error {}

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
const clipLine = (s: string): string => { const t = s.replace(/\r?\n$/, '').replace(/\s+$/, ''); return t.length > MAX_LINE_CHARS ? `${t.slice(0, MAX_LINE_CHARS)}…` : t; };

function rgBaseArgs(o: SearchOptions): string[] {
  const args = ['--max-columns', '300', '--max-columns-preview', '--max-filesize', '1M'];
  for (const d of SKIP_DIRS) { args.push('--glob', `!**/${d}/**`); }
  args.push('--glob', `!*.{${NON_TEXT_EXT.join(',')}}`, '--glob', '!*.min.{js,css}', '--glob', '!package-lock.json');
  args.push(o.ignoreCase === false ? '-s' : '-i');
  if (o.glob) { args.push('--glob', o.glob); }
  return args;
}

function runRg(rgPath: string, root: string, args: string[], signal: AbortSignal | undefined, timeoutMs: number, onLine: (line: string) => boolean): Promise<{ truncated: boolean; timedOut: boolean; code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(rgPath, args, { cwd: root, windowsHide: true });
    let buf = '', stderr = '', truncated = false, timedOut = false, done = false;
    const finish = (code: number | null): void => { if (!done) { done = true; clearTimeout(timer); resolve({ truncated, timedOut, code, stderr }); } };
    const stop = (): void => { truncated = true; p.kill(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) { if (l && !onLine(l)) { stop(); return; } }
    });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', (e) => { done = true; clearTimeout(timer); reject(e); });
    p.on('close', (code) => { if (buf && !done) { onLine(buf); } finish(code); });
  });
}

async function rgSearch(rgPath: string, root: string, o: SearchOptions, signal?: AbortSignal): Promise<Partial_> {
  const cap = matchCap(o);
  const mode = o.mode ?? 'content';
  const target = o.path ? norm(o.path) : '.';
  const byFile = new Map<string, FileMatches>();
  const entry = (f: string): FileMatches => { let e = byFile.get(f); if (!e) { e = { file: f, count: 0, lines: [] }; byFile.set(f, e); } return e; };
  let total = 0;
  let args: string[];
  let onLine: (l: string) => boolean;

  if (mode === 'files') {
    args = [...rgBaseArgs(o), '-l', '-e', o.pattern, '--', target];
    onLine = (l) => { entry(norm(l)).count = 1; total++; return byFile.size < cap; };
  } else if (mode === 'count') {
    args = [...rgBaseArgs(o), '-c', '--with-filename', '-e', o.pattern, '--', target];
    onLine = (l) => { const i = l.lastIndexOf(':'); const n = Number(l.slice(i + 1)); entry(norm(l.slice(0, i))).count = n; total += n; return byFile.size < Math.max(cap, 500); };
  } else {
    args = [...rgBaseArgs(o), '--json', '-m', String(PER_FILE_MATCH_CAP)];
    if (o.context && o.context > 0) { args.push('-C', String(Math.min(o.context, 5))); }
    args.push('-e', o.pattern, '--', target);
    onLine = (l) => {
      let m: any; try { m = JSON.parse(l); } catch { return true; }
      if (m.type !== 'match' && m.type !== 'context') { return true; }
      const d = m.data;
      const e = entry(norm(d.path.text ?? ''));
      e.lines.push({ line: d.line_number, text: clipLine(d.lines?.text ?? ''), ctx: m.type === 'context' });
      if (m.type === 'match') { e.count++; total++; }
      return total < cap;
    };
  }
  const r = await runRg(rgPath, root, args, signal, o.timeoutMs ?? DEFAULT_TIMEOUT_MS, onLine);
  if (r.code === 2 && /regex parse error|error parsing regex|unrecognized escape|look-around/i.test(r.stderr)) { throw new RegexUnsupported(r.stderr); }
  if (r.code === 2 && byFile.size === 0 && r.stderr.trim()) { throw new Error(r.stderr.trim().split('\n')[0]); }
  return { files: [...byFile.values()], totalMatches: total, truncated: r.truncated, timedOut: r.timedOut };
}

async function jsSearch(eng: SearchEngine, o: SearchOptions, signal?: AbortSignal): Promise<Partial_> {
  const mode = o.mode ?? 'content';
  const cap = matchCap(o);
  const deadline = Date.now() + (o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let re: RegExp;
  try { re = new RegExp(o.pattern, o.ignoreCase === false ? '' : 'i'); } catch (e: any) { throw new Error(`Invalid regex: ${e.message}`); }
  const prefix = o.path ? `${norm(o.path).replace(/\/+$/, '')}/` : '';
  const candidates = prioritize((await eng.index.files()).filter((f) => !NON_TEXT_RE.test(f) && (!prefix || f.startsWith(prefix)) && (!o.glob || matchesGlob(f, o.glob))), o.pattern);
  const ctxN = Math.min(o.context ?? 0, 5);
  const results: FileMatches[] = [];
  let total = 0, truncated = false, timedOut = false, next = 0;

  const scan = async (rel: string): Promise<void> => {
    let buf: Buffer;
    let fh: fs.FileHandle | undefined;
    try {
      fh = await fs.open(path.join(eng.root, rel), 'r');
      if ((await fh.stat()).size > MAX_FILE_BYTES) { return; }
      buf = await fh.readFile();
    } catch { return; } finally { await fh?.close().catch(() => undefined); }
    if (buf.subarray(0, 1000).includes(0)) { return; }
    const lines = buf.toString('utf8').split('\n');
    const hits: number[] = [];
    const cap = mode === 'count' ? Infinity : PER_FILE_MATCH_CAP;
    for (let i = 0; i < lines.length && hits.length < cap; i++) { if (re.test(lines[i])) { hits.push(i); } }
    if (!hits.length) { return; }
    const entry: FileMatches = { file: rel, count: hits.length, lines: [] };
    if (mode === 'content') {
      const include = new Map<number, boolean>();
      for (const h of hits) {
        for (let k = Math.max(0, h - ctxN); k <= Math.min(lines.length - 1, h + ctxN); k++) { include.set(k, (include.get(k) ?? false) || k === h); }
      }
      for (const [k, isMatch] of [...include.entries()].sort((a, b) => a[0] - b[0])) { entry.lines.push({ line: k + 1, text: clipLine(lines[k]), ctx: !isMatch }); }
    }
    results.push(entry);
    total += hits.length;
  };

  const worker = async (): Promise<void> => {
    while (next < candidates.length && !signal?.aborted) {
      if (total >= cap) { truncated = true; return; }
      if (Date.now() >= deadline) { truncated = true; timedOut = true; return; }
      await scan(candidates[next++]);
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  return { files: results, totalMatches: total, truncated, timedOut };
}

export async function search(eng: SearchEngine, o: SearchOptions, signal?: AbortSignal): Promise<SearchResult> {
  const t0 = Date.now();
  let res: SearchResult | undefined;
  const warm = eng.index.peek() !== undefined;
  const pref = eng.prefer ?? 'auto';
  const rgPath = eng.rgPath;
  const useRg = rgPath !== undefined && (pref === 'ripgrep' || (pref === 'auto' && !warm));
  if (pref === 'auto' && !warm) { void eng.index.files().catch(() => undefined); }
  if (rgPath !== undefined && useRg) {
    try {
      res = { ...(await rgSearch(rgPath, eng.root, o, signal)), engine: 'rg', ms: Date.now() - t0 };
    } catch (e) {
      if (!(e instanceof RegexUnsupported) && (e as NodeJS.ErrnoException).code !== 'ENOENT') { throw e; }
    }
  }
  if (!res) { res = { ...(await jsSearch(eng, o, signal)), engine: 'js', ms: Date.now() - t0 }; }
  if (res.timedOut || (res.truncated && !o.path && !o.glob)) {
    const files = eng.index.peek();
    if (files) { res.hint = areaOverview(files); }
  }
  return res;
}

/** "folder (N files)" for the biggest top-level folders — tells the caller where a narrower search should go. */
export function areaOverview(files: string[], top = 8): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const i = f.indexOf('/');
    const area = i < 0 ? '(root files)' : f.slice(0, i);
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([d, n]) => `${d} (${n.toLocaleString('en-US')} files)`).join(', ');
}

/** Orders candidates so likely-relevant source is scanned first; early stopping then returns the best hits. */
export function prioritize(files: string[], pattern: string): string[] {
  const words = pattern.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  const score = (f: string): number => {
    const lf = f.toLowerCase();
    return (words.some((w) => lf.includes(w)) ? 0 : 2) + (NOISE.test(f) ? 4 : 0);
  };
  return files.map((f) => ({ f, s: score(f) })).sort((a, b) => a.s - b.s).map((x) => x.f);
}

/* ------------------------------------------------------------------ ranking & output */

const NOISE = /(^|\/)(tests?|__tests__|spec|specs|node_modules|dist|build|vendor|migrations|fixtures|docs?)(\/|$)|\.min\.|\.lock$|package-lock\.json|\.(test|spec)\./i;

/** Puts files whose path mentions the query first and tests/vendored/generated files last; then most matches. */
export function rankFiles(files: FileMatches[], pattern: string): FileMatches[] {
  const words = pattern.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  const score = (f: FileMatches): number => {
    const lp = f.file.toLowerCase();
    return (words.some((w) => lp.includes(w)) ? 0 : 2) + (NOISE.test(f.file) ? 4 : 0);
  };
  return [...files].sort((a, b) => score(a) - score(b) || b.count - a.count || a.file.localeCompare(b.file));
}

export function formatSearch(res: SearchResult, o: SearchOptions, maxChars = 20000): string {
  const mode = o.mode ?? 'content';
  const limit = o.maxResults ?? (mode === 'content' ? 100 : 200);
  const plus = res.truncated ? '+' : '';
  const ranked = rankFiles(res.files, o.pattern);
  const scope = o.glob || o.path ? '' : ' Narrow it with path or glob.';
  const where = res.hint ? ` Biggest areas: ${res.hint}.` : '';
  if (!ranked.length) {
    if (res.timedOut) { return `Search timed out after ${Math.round(res.ms / 1000)}s before finding any match, so this is inconclusive (not "no matches").${scope}${where}`; }
    return `No matches for /${o.pattern}/${o.glob ? ` in ${o.glob}` : ''} (${res.engine}, ${res.ms} ms).`;
  }
  const head = `Found ${res.totalMatches}${plus} match${res.totalMatches === 1 ? '' : 'es'} in ${ranked.length}${plus} file${ranked.length === 1 ? '' : 's'} (${res.engine}, ${res.ms} ms)`;
  const out: string[] = [head];
  let shown = 0, hiddenFiles = 0;

  if (mode === 'files') {
    ranked.slice(0, limit).forEach((f) => out.push(f.file));
    hiddenFiles = Math.max(0, ranked.length - limit);
  } else if (mode === 'count') {
    ranked.slice(0, limit).forEach((f) => out.push(`${f.file}: ${f.count}`));
    hiddenFiles = Math.max(0, ranked.length - limit);
  } else {
    for (const f of ranked) {
      if (shown >= limit) { hiddenFiles++; continue; }
      out.push(f.file);
      let prev = -2;
      for (const l of f.lines) {
        if (shown >= limit && !l.ctx) { break; }
        if (prev >= 0 && l.line > prev + 1) { out.push('  --'); }
        out.push(`  ${l.line}${l.ctx ? '-' : ':'} ${l.text}`);
        prev = l.line;
        if (!l.ctx) { shown++; }
      }
    }
  }
  if (res.timedOut) {
    out.push(`[PARTIAL: the ${Math.round(res.ms / 1000)}s time budget ran out before every file was searched.${scope}${where}]`);
  } else if (hiddenFiles || res.truncated) {
    out.push(`[more results exist${hiddenFiles ? ` (${hiddenFiles} more files)` : ''}; narrow with a glob, path, or a more specific pattern — or use output_mode "files"/"count" first.${where}]`);
  }
  const text = out.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
}
