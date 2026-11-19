/**
 * Decides which of the tool calls the model sent in one turn can run at the same time.
 *
 * The model asks for parallelism simply by sending several independent calls in one response. Calls are
 * grouped in their original order: a run of side-effect-free calls (reads, searches, read-only MCP tools,
 * sub-agents, read-only shell commands) executes concurrently; anything that changes state (edits, other
 * commands, questions, plan/todo updates) is a barrier that runs on its own, so "edit then test" sent in one
 * response still happens in that order. Results are always returned in the original call order.
 */

export const MAX_PARALLEL_TOOLS = 8;

/** Splits calls into consecutive batches; each batch of parallel-safe calls runs concurrently. */
export function planBatches<T>(calls: T[], parallelSafe: (c: T) => boolean, max = MAX_PARALLEL_TOOLS): T[][] {
  const out: T[][] = [];
  let run: T[] = [];
  const flush = () => { if (run.length) { out.push(run); run = []; } };
  for (const c of calls) {
    if (!parallelSafe(c)) { flush(); out.push([c]); continue; }
    run.push(c);
    if (run.length >= max) { flush(); }
  }
  flush();
  return out;
}

/** Serializes async work (e.g. approval prompts) so concurrent tools never ask the user two things at once. */
export class Serializer {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/* ------------------------------------------------------------------ read-only shell command detection */

const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog', 'grep', 'cat-file', 'merge-base', 'reflog', 'remote', 'branch', 'tag', 'config', 'stash']);
/** Git subcommands that are only read-only with the listing flags below. */
const GIT_LIST_ONLY: Record<string, RegExp> = {
  remote: /^(-v|--verbose|show|get-url)$/,
  branch: /^(-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--contains|--merged|--no-merged|--verbose|--format=.*)$/,
  tag: /^(-l|--list|-n\d*|--contains|--points-at|--sort=.*|--format=.*)$/,
  config: /^(--get|--get-all|--list|-l|--get-regexp|--show-origin|--global|--local|--system)$/,
  stash: /^(list|show)$/,
  reflog: /^(show|--date=.*|-n\d*)$/,
};

/** Commands that only read (when not combined with redirection or chaining). Lower-case. */
const READ_COMMANDS = new Set([
  'ls', 'dir', 'get-childitem', 'gci', 'cat', 'type', 'get-content', 'gc', 'head', 'tail', 'wc', 'pwd', 'get-location',
  'which', 'where.exe', 'get-command', 'gcm', 'test-path', 'get-item', 'gi', 'get-itemproperty', 'resolve-path', 'tree', 'du', 'df', 'stat', 'file',
  'rg', 'grep', 'select-string', 'sls', 'findstr', 'whoami', 'uname', 'get-date', 'get-process', 'ps', 'get-service',
  'test-netconnection', 'tnc', 'nslookup', 'resolve-dnsname', 'ping', 'get-filehash', 'certutil', 'jq',
]);
/** Commands allowed after a pipe: pure filters/formatters. */
const FILTERS = new Set([
  'select-object', 'select', 'where-object', 'where', '?', 'sort-object', 'sort', 'measure-object', 'measure', 'format-table', 'ft',
  'format-list', 'fl', 'convertfrom-json', 'convertto-json', 'out-string', 'select-string', 'sls', 'findstr', 'grep', 'rg', 'head', 'tail',
  'jq', 'wc', 'uniq', 'cut', 'tr', 'more', 'group-object', 'group', 'get-unique', 'convertfrom-csv', 'column',
]);
/** `<tool> --version` style probes. */
const VERSION_PROBE = /^(node|npm|npx|python|python3|py|pip|pip3|java|go|cargo|rustc|dotnet|git|docker|kubectl|psql|mongosh|redis-cli|mysql|tsc|code)(\.exe)?$/;
const HTTP_TOOLS = new Set(['curl', 'curl.exe', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm']);
/** curl flags are case-sensitive (-k is harmless, -K reads a config file); PowerShell parameters are not. */
const HTTP_WRITE_FLAGS = /^(-d|--data.*|-F|--form.*|-T|--upload-file|-o|-O|--output|--remote-name.*|-K|--config|--post-data|--post-file|-P|--directory-prefix)$/;
const PS_WRITE_PARAMS = /^-(Body|InFile|OutFile|Form)$/i;
const HTTP_SAFE_METHOD = /^(GET|HEAD|OPTIONS)$/i;

/** Splits on whitespace outside quotes. Returns undefined if quotes are unbalanced. */
function words(s: string): string[] | undefined {
  const out: string[] = [];
  let cur = '';
  let q: string | undefined;
  let has = false;
  for (const ch of s) {
    if (q) { if (ch === q) { q = undefined; } else { cur += ch; } continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) { out.push(cur); } cur = ''; has = false; continue; }
    cur += ch;
  }
  if (q) { return undefined; }
  if (cur || has) { out.push(cur); }
  return out;
}

/** Splits on unquoted `|`. Returns undefined when the command chains, redirects or substitutes (anything but a plain pipe). */
function pipeline(cmd: string): string[] | undefined {
  const s = cmd.replace(/\s(2>&1|2>\$null|2>\/dev\/null|\*>\$null|2>nul)(?=\s|$)/gi, ' ');
  if (/\$\(|`|@\(/.test(s)) { return undefined; }
  const parts: string[] = [];
  let cur = '';
  let q: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === q) { q = undefined; } continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '|') { if (s[i + 1] === '|') { return undefined; } parts.push(cur); cur = ''; continue; }
    if (ch === ';' || ch === '&' || ch === '>' || ch === '<' || ch === '\n' || ch === '\r') { return undefined; }
    cur += ch;
  }
  if (q) { return undefined; }
  parts.push(cur);
  return parts.map((p) => p.trim()).every(Boolean) ? parts.map((p) => p.trim()) : undefined;
}

function gitReadOnly(args: string[]): boolean {
  const flags = args.filter((a) => a.startsWith('-'));
  if (flags.some((f) => /^(-C|-c|--exec-path|--git-dir|--work-tree)/.test(f))) { return false; }
  const sub = args.find((a) => !a.startsWith('-'));
  if (!sub || !GIT_READ.has(sub)) { return false; }
  const rest = args.slice(args.indexOf(sub) + 1);
  if (rest.some((a) => /^--output(=|$)|^--ext-diff$/.test(a))) { return false; }
  const only = GIT_LIST_ONLY[sub];
  if (!only) { return true; }
  if (sub === 'remote' && rest.length === 0) { return true; }
  if (sub === 'branch' || sub === 'tag') {
    // "git branch foo" creates a branch; only listing flags (and the values of --contains/--merged) are read-only.
    return rest.every((a, i) => only.test(a) || (i > 0 && /^(--contains|--merged|--no-merged|--points-at)$/.test(rest[i - 1])));
  }
  if (sub === 'config') { return rest.some((a) => /^(--get|--get-all|--list|-l|--get-regexp)$/.test(a)) && rest.every((a) => !/^--(add|unset|replace-all|rename-section|remove-section|edit)/.test(a) && a !== '-e'); }
  return rest.length > 0 && only.test(rest[0]) && !rest.slice(1).some((a) => /^(drop|pop|apply|clear|push|delete|expire)$/.test(a));
}

function httpReadOnly(head: string, args: string[]): boolean {
  const curl = head.startsWith('curl');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (HTTP_WRITE_FLAGS.test(a) || PS_WRITE_PARAMS.test(a)) { return false; }
    // curl bundles short flags (-sSLo out.txt): any writing/sending letter in the bundle makes it unsafe.
    if (curl && /^-[A-Za-z]{2,}$/.test(a) && /[dFTOoKX]/.test(a.slice(1))) { return false; }
    if (/^(-X|--request|-Method)$/i.test(a)) { if (!HTTP_SAFE_METHOD.test(args[i + 1] ?? '')) { return false; } i++; continue; }
    if (/^(-X|--request=)/.test(a) && a.length > 2) { if (!HTTP_SAFE_METHOD.test(a.replace(/^(-X|--request=)/, ''))) { return false; } }
  }
  return true;
}

function segmentReadOnly(seg: string, first: boolean): boolean {
  const w = words(seg);
  if (!w || !w.length) { return false; }
  const head = w[0].toLowerCase();
  const args = w.slice(1);
  if (!first) { return FILTERS.has(head) && !args.some((a) => /^(-i|--in-place|-o|--output(=.*)?)$/.test(a)); }
  if (head === 'git' || head === 'git.exe') { return gitReadOnly(args); }
  if (HTTP_TOOLS.has(head)) { return httpReadOnly(head, args); }
  if (head === 'hostname' || head === 'date') { return args.length === 0; }
  if (VERSION_PROBE.test(head) && args.length === 1 && /^(--version|-v|-V|version)$/.test(args[0])) { return true; }
  if ((head === 'npm' || head === 'pnpm' || head === 'yarn') && /^(ls|list|view|info|outdated|why|config)$/.test(args[0] ?? '')) { return args[0] !== 'config' || args[1] === 'get' || args[1] === 'list'; }
  if ((head === 'pip' || head === 'pip3') && /^(list|show|freeze)$/.test(args[0] ?? '')) { return true; }
  if (head === 'find') { return !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint.*|fls)$/.test(a)); }
  if (head === 'certutil') { return args[0]?.toLowerCase() === '-hashfile'; }
  return READ_COMMANDS.has(head);
}

/** True for shell commands that only read (git status/log/diff, ls, cat, rg, GET requests …) and may run alongside other reads. */
export function isReadOnlyCommand(command: string): boolean {
  const parts = pipeline(String(command ?? '').trim());
  if (!parts) { return false; }
  return parts.every((p, i) => segmentReadOnly(p, i === 0));
}
