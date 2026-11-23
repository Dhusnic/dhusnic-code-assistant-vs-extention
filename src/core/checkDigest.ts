/**
 * Turns the output of a failing project check into feedback the model can act on. A raw head of a long test or build
 * log is mostly progress lines and passing tests; what the model needs is which tests failed, what they expected and
 * got, where (the first stack frames in the project's own code, not node_modules or the runtime), and the compiler or
 * linter errors as `file:line:col message`. digestCheckOutput finds those with line-by-line regexes for the common
 * formats (tsc, eslint, jest/vitest, node:test spec and TAP, pytest, mypy/ruff/flake8, go test, cargo, javac/maven/
 * gradle, dotnet), deduplicates them, says how many there were when it shows fewer, and appends the end of the raw
 * output for context. When it recognises nothing it falls back to the head and tail of the raw output (clipOutput).
 * Pure: no I/O, so it is unit-tested directly. Which checks run and how often stays in checks.ts and agent.ts.
 */
import { clipOutput } from './fstools';

/** How much of the raw end of the output follows the extracted parts. */
const TAIL_CHARS = 1500;
/** One extracted item is never longer than this. */
const ITEM_CHARS = 300;

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const SRC_EXT = 'py|pyi|c|cc|cpp|cxx|h|hpp|rb|php|swift|ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|kt|kts|java|go|rs|cs|scala|dart|lua|ex|exs';

/* Compiler and linter errors, most specific first. Each returns `file:line:col message`, or undefined to ignore. */
const ERROR_PATTERNS: Array<[RegExp, (m: RegExpExecArray) => string | undefined]> = [
  // tsc: src/a.ts(12,5): error TS2322: ...   and   src/a.ts:12:5 - error TS2322: ...
  [/^(.+?\.[cm]?[jt]sx?)\((\d+),(\d+)\): error (TS\d+): (.+)$/, (m) => `${m[1]}:${m[2]}:${m[3]} ${m[4]}: ${m[5]}`],
  [/^(.+?\.[cm]?[jt]sx?):(\d+):(\d+) - error (TS\d+): (.+)$/, (m) => `${m[1]}:${m[2]}:${m[3]} ${m[4]}: ${m[5]}`],
  // dotnet / msbuild: Foo.cs(10,5): error CS0103: ... [proj.csproj]
  [/^\s*(.+?\.(?:cs|vb|fs|csproj|sln|props|targets))\((\d+),(\d+)\): error ([A-Z]+\d+): (.+?)(?: \[[^\]]+\])?$/, (m) => `${m[1]}:${m[2]}:${m[3]} ${m[4]}: ${m[5]}`],
  // maven (javac/kotlinc through the compiler plugin): [ERROR] /p/Foo.java:[10,5] cannot find symbol
  [/^\[ERROR\]\s+(.+?\.(?:java|kt|scala|groovy)):\[(\d+),(\d+)\] (.+)$/, (m) => `${m[1]}:${m[2]}:${m[3]} ${m[4]}`],
  // javac: Foo.java:10: error: ...
  [/^(.+?\.java):(\d+): error: (.+)$/, (m) => `${m[1]}:${m[2]} ${m[3]}`],
  // kotlinc / gradle: e: /p/Foo.kt: (10, 5): msg   and   e: file:///p/Foo.kt:10:5 msg
  [/^e: (?:file:\/\/)?(.+?\.kts?): \((\d+), (\d+)\): (.+)$/, (m) => `${m[1]}:${m[2]}:${m[3]} ${m[4]}`],
  [/^e: (?:file:\/\/)?(.+?\.kts?):(\d+):(\d+):? (.+)$/, (m) => `${m[1]}:${m[2]}:${m[3]} ${m[4]}`],
  // go build / vet / test, gcc, mypy, ruff, flake8, pylint, pytest short form: file:line[:col]: message
  [new RegExp(`^\\s*((?:[A-Za-z]:)?[\\w.@/\\\\-]+\\.(?:${SRC_EXT})):(\\d+)(?::(\\d+))?:? (.+)$`), (m) => {
    const msg = m[4].trim();
    // Notes and warnings do not fail a check; "in test_x" is a pytest traceback frame, not an error.
    if (/^(note|warning|info|hint)\b/i.test(msg) || /^in \S+$/.test(msg)) { return undefined; }
    return `${m[1]}:${m[2]}${m[3] ? `:${m[3]}` : ''} ${msg.replace(/^error:\s*/i, '')}`;
  }],
];

/* Names of failing tests. */
const TEST_PATTERNS: Array<[RegExp, (m: RegExpExecArray) => string | undefined]> = [
  // jest: ● Suite › name   (not the console-output blocks)
  [/^\s*●\s+(.+)$/, (m) => (/^Console\b/.test(m[1]) ? undefined : m[1])],
  // vitest / jest file header: FAIL  src/a.test.ts > suite > name
  [/^\s*FAIL\s+(\S+\.\w+\s+>\s+.+)$/, (m) => m[1]],
  // jest/vitest/node spec: ✕ name (5 ms)   × name   ✖ name (1.2ms)
  [/^\s*[✕×✗✖]\s+(.+?)(?:\s+\(?[\d.]+\s*m?s\)?)?$/, (m) => (/^(failing tests|\d+ (tests? )?fail|\d+ problems?\b)/i.test(m[1]) ? undefined : m[1])],
  // TAP (node:test, tape): not ok 3 - name
  [/^\s*not ok \d+(?: -)? (.+?)$/, (m) => (/#\s*(SKIP|TODO)\b/i.test(m[1]) ? undefined : m[1].replace(/\s+#.*$/, ''))],
  // pytest short summary: FAILED tests/test_a.py::test_x - AssertionError: ...
  [/^(?:FAILED|ERROR) (\S+::\S+)/, (m) => m[1]],
  // go test: --- FAIL: TestX (0.00s)
  [/^\s*--- FAIL: (\S+)/, (m) => m[1]],
  // cargo test: test a::b ... FAILED
  [/^test (\S+) \.\.\. FAILED$/, (m) => m[1]],
  // maven surefire: [ERROR] testAdd(com.x.CalcTest)  Time elapsed: 0.01 s  <<< FAILURE!
  [/^\[ERROR\]\s+(\S+?)\s+(?:Time elapsed|.*<<< (?:FAILURE|ERROR)!)/, (m) => (m[1] === 'Tests' ? undefined : m[1])],
  // gradle: CalcTest > testAdd() FAILED
  [/^\s*(\S.*? > .+?) FAILED$/, (m) => m[1]],
  // dotnet test: Failed Ns.CalcTests.Add [12 ms]
  [/^\s*Failed (\S+) \[[^\]]*\]$/, (m) => m[1]],
];

/** A line that states what went wrong in a test (starts an assertion block). */
const ASSERT_HEAD = new RegExp([
  /\b[A-Z]\w*(?:Error|Exception|Failure)\b(?: \[[A-Z_]+\])?:/.source, // AssertionError [ERR_ASSERTION]: ..., ValueError: ...
  /\bpanicked at\b/.source, // rust
  /\bassert(?:ion)?\b.*\bfailed\b/.source, // assertion `left == right` failed
  /^\s*E\s{2,}\S/.source, // pytest E lines
  /\bexpected:? ?<.*> but was:? ?<.*>/.source, // junit 4
  /\bexpected .+ (?:to |but )/.source, // chai / vitest: expected 2 to be 3
  /\bAssert\.\w+\(\) Failure/.source, // xunit
  /^\s*expect\(.+\)\.[\w.]+\(/.source, // jest matcher line
  /^\s*error: ['"|]/.source, // TAP yaml error field
].join('|'));
/** Expected / actual detail lines that belong to the assertion before them. */
const ASSERT_DETAIL = /^\s*[-+]?\s*(?:Expected|Received|Actual|expected|actual|left|right|Expected value|Received value|Difference)\b[^:=]{0,20}[:=]\s*\S|^\s*\S.* !== \S/;

/* Stack frames: [pattern, location]; frames outside the project are skipped. */
const FRAME_PATTERNS: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^\s*at (?:(.+?) \()?((?:file:\/\/)?[^()\s]+?):(\d+):(\d+)\)?$/, (m) => `${m[2]}:${m[3]}:${m[4]}${m[1] ? ` (${m[1]})` : ''}`], // JS
  [/^\s*❯ (.+?):(\d+):(\d+)/, (m) => `${m[1]}:${m[2]}:${m[3]}`], // vitest
  [/^\s*File "(.+?)", line (\d+), in (.+)$/, (m) => `${m[1]}:${m[2]} (${m[3]})`], // python
  [/^((?:[A-Za-z]:)?[\w.@/\\-]+\.py):(\d+): in (\S+)$/, (m) => `${m[1]}:${m[2]} (${m[3]})`], // pytest long traceback
  [/^\s*at ([\w$.<>]+)\(([\w$]+\.(?:java|kt|scala|groovy)):(\d+)\)$/, (m) => `${m[2]}:${m[3]} (${m[1]})`], // JVM
  [/^\s*at (.+?) in (.+?):line (\d+)$/, (m) => `${m[2]}:${m[3]} (${m[1]})`], // .NET
  [/^\s+([\w$.<> ]+?) \(((?:file:\/\/)?[^()\s]+\.[cm]?[jt]sx?):(\d+):(\d+)\)$/, (m) => `${m[2]}:${m[3]}:${m[4]} (${m[1]})`], // node:test TAP stack
];
const FOREIGN_FRAME = /node_modules|\bnode:|\binternal\/|\(<anonymous>\)|at <anonymous>|^native\b|site-packages|dist-packages|[\\/]lib[\\/]python\d|<frozen|(?:\(|\bat )\s*(?:java|javax|jdk|sun|kotlin|kotlinx|junit|org\.junit|org\.opentest4j|org\.apache\.maven|org\.gradle|worker|System|Microsoft|Xunit|NUnit)\.|\/rustc\/|[\\/]\.cargo[\\/]|[\\/]go[\\/]src[\\/]/;

/** Counts of distinct items, in first-seen order. */
class Bag {
  private items = new Map<string, number>();
  add(s: string): void {
    const v = s.trim().replace(/\s+/g, ' ');
    if (!v) { return; }
    const item = v.length > ITEM_CHARS ? `${v.slice(0, ITEM_CHARS - 1)}…` : v;
    this.items.set(item, (this.items.get(item) ?? 0) + 1);
  }
  get size(): number { return this.items.size; }
  list(n: number): string[] { return [...this.items].slice(0, n).map(([k, c]) => (c > 1 ? `${k} (×${c})` : k)); }
}

/** The useful parts of a check's output: failing tests, assertions, project frames and errors. */
export function extractFailures(output: string): { tests: Bag; errors: Bag; asserts: Bag; frames: Bag } {
  const tests = new Bag(); const errors = new Bag(); const asserts = new Bag(); const frames = new Bag();
  const lines = output.replace(ANSI, '').replace(/\r/g, '').split('\n');
  let eslintFile = '';
  let rustError = '';
  let block: string[] = [];
  let blockAge = 0;
  /** The block is made of pytest "E   " lines, which continue it. */
  let pytestE = false;
  const flushBlock = () => { if (block.length) { asserts.add(block.join(' | ')); } block = []; };
  const flushRust = () => { if (rustError && !/^(could not compile|aborting due to|test failed)/.test(rustError)) { errors.add(rustError); } rustError = ''; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    if (!line.trim()) { if (++blockAge > 2) { flushBlock(); } continue; }
    // eslint stylish: a path on its own line, then "  12:5  error  message  rule"
    if (/^(?:[A-Za-z]:[\\/]|\/|\.{0,2}[\w@-][^\s:]*[\\/])\S*\.\w+$/.test(line)) { eslintFile = line; continue; }
    const es = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}([@\w/-]+))?$/.exec(line);
    if (es && eslintFile) {
      if (es[3] === 'error') { errors.add(`${eslintFile}:${es[1]}:${es[2]} ${es[4]}${es[5] ? ` (${es[5]})` : ''}`); }
      continue;
    }
    // cargo / rustc: "error[E0308]: mismatched types" then "  --> src/main.rs:4:5"; ruff's full format looks alike.
    const re = /^error(\[E\d+\])?: (.+)$/.exec(line);
    if (re) { flushRust(); rustError = `${re[1] ? `${re[1].slice(1, -1)}: ` : ''}${re[2]}`; continue; }
    const rf = /^([A-Z]{1,4}\d{2,4}) (?:\[\*\] )?(.+)$/.exec(line);
    if (rf && /^\s*--> /.test(lines[i + 1] ?? '')) { flushRust(); rustError = `${rf[1]}: ${rf[2]}`; continue; }
    const loc = /^\s*--> (.+?):(\d+):(\d+)$/.exec(line);
    if (loc && rustError) { errors.add(`${loc[1]}:${loc[2]}:${loc[3]} ${rustError}`); rustError = ''; continue; }

    let frame = false;
    for (const [re2, fmt] of FRAME_PATTERNS) {
      const m = re2.exec(line);
      if (m) { frame = true; if (!FOREIGN_FRAME.test(line)) { frames.add(fmt(m)); } break; }
    }
    if (frame) { continue; }
    for (const [re2, fmt] of TEST_PATTERNS) {
      const m = re2.exec(line);
      if (m) { const t = fmt(m); if (t) { tests.add(t); } break; }
    }
    // pytest "FAILED x::y - AssertionError: msg" carries the assertion too.
    const pf = /^FAILED \S+::\S+ - (.+)$/.exec(line);
    if (pf) { asserts.add(pf[1]); continue; }
    let isError = false;
    for (const [re2, fmt] of ERROR_PATTERNS) {
      const m = re2.exec(line);
      if (m) { const e = fmt(m); if (e) { errors.add(e); isError = true; } break; }
    }
    if (isError) { continue; }
    const eLine = /^\s*E\s{2,}(\S.*)$/.exec(line);
    if (eLine && pytestE && block.length < 6) { block.push(eLine[1].trim()); blockAge = 0; continue; }
    pytestE = !!eLine;
    if (ASSERT_HEAD.test(line)) {
      flushBlock();
      // A TAP yaml "error: |-" holds the message on the next line.
      const yaml = /^\s*error: [|>]-?$/.test(line) && !!lines[i + 1];
      const text = yaml ? lines[++i] : eLine ? eLine[1] : line.replace(/^\s*error:\s*/, '');
      block = [text.trim().replace(/^['"]|['"]$/g, '')];
      blockAge = 0;
      continue;
    }
    if (ASSERT_DETAIL.test(line)) {
      if (block.length && block.length < 6) { block.push(line.trim()); blockAge = 0; } else { flushBlock(); block = [line.trim()]; blockAge = 0; }
      continue;
    }
    if (block.length && ++blockAge > 3) { flushBlock(); }
  }
  flushBlock();
  flushRust();
  return { tests, errors, asserts, frames };
}

/** Cuts text to its last `n` characters, starting at a line boundary when one is near. */
function lastChars(s: string, n: number): string {
  if (s.length <= n) { return s; }
  const piece = s.slice(s.length - n);
  const nl = piece.indexOf('\n');
  return nl >= 0 && nl < 200 ? piece.slice(nl + 1) : piece;
}

/**
 * Feedback for one failing check, at most `maxChars` long: a header, the failing tests, errors, assertions and project
 * stack frames that were recognised (deduplicated, with counts when not all are shown), then the end of the raw
 * output. When nothing is recognised: the head and tail of the raw output.
 */
export function digestCheckOutput(name: string, command: string, output: string, maxChars: number): string {
  const exit = /\[exit (-?\d+)\]\s*$/.exec(output);
  const header = `### ${name}: \`${command}\`${exit ? ` (exit ${exit[1]})` : ''}`;
  const raw = output.replace(ANSI, '').replace(/\r/g, '').trim();
  const { tests, errors, asserts, frames } = extractFailures(raw);
  const found = tests.size + errors.size + asserts.size + frames.size;
  if (!found) { return `${header}\n${clipOutput(raw, Math.max(200, maxChars - header.length - 1))}`; }

  const tailBudget = Math.min(TAIL_CHARS, Math.floor(maxChars / 4));
  const section = (title: string, bag: Bag, n: number): string => {
    if (!bag.size) { return ''; }
    const shown = bag.list(n);
    return `\n${title} (${bag.size}${bag.size > shown.length ? `, showing ${shown.length}` : ''}):\n${shown.map((s) => `- ${s}`).join('\n')}`;
  };
  const build = (k: number): string => {
    const counts = [
      tests.size && `${tests.size} failing test${tests.size === 1 ? '' : 's'}`,
      errors.size && `${errors.size} error${errors.size === 1 ? '' : 's'}`,
    ].filter(Boolean).join(', ');
    return `${header}${counts ? `\n${counts}.` : ''}`
      + section('Failing tests', tests, Math.max(1, Math.round(10 * k)))
      + section('Errors', errors, Math.max(1, Math.round(10 * k)))
      + section('Assertions', asserts, Math.max(1, Math.round(8 * k)))
      + section('Stack frames in project code', frames, Math.max(1, Math.round(6 * k)));
  };
  let k = 1;
  let body = build(k);
  while (body.length > maxChars - tailBudget - 40 && k > 0.1) { k /= 2; body = build(k); }
  if (body.length > maxChars) { body = `${body.slice(0, maxChars - 1)}…`; }
  const room = maxChars - body.length - 40;
  if (room < 200) { return body; }
  const tail = lastChars(raw, Math.min(room, Math.max(tailBudget, TAIL_CHARS)));
  return `${body}\n\n${tail.length < raw.length ? 'End of the output:' : 'Output:'}\n${tail}`;
}

/** Whether two digests report the same failure, ignoring timings (so a fix that changed nothing is recognised). */
export function sameDigest(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|m|min)\b/g, '#').replace(/\d{1,2}:\d{2}:\d{2}(?:\.\d+)?/g, '#');
  return !!a && norm(a) === norm(b);
}
