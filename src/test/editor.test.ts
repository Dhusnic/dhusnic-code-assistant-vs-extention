import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { buildFixPrompt, buildInlineEditMessages, cleanInlineEdit, trimAround } from '../core/inlineEdit';
import { AgentActivity, NotificationTracker, NotifyContext, decideNotification } from '../core/notify';

/* ------------------------------------------------------------ inlineEdit */

test('clean: strips a wrapping fence, with or without a language', () => {
  assert.equal(cleanInlineEdit('```ts\nconst a = 2;\n```', 'const a = 1;'), 'const a = 2;');
  assert.equal(cleanInlineEdit('```\nconst a = 2;\n```\n', 'const a = 1;'), 'const a = 2;');
  assert.equal(cleanInlineEdit('~~~js\nconst a = 2;\n~~~', 'const a = 1;'), 'const a = 2;');
});

test('clean: takes the code out of prose around a fence, and survives an unclosed fence', () => {
  assert.equal(cleanInlineEdit('Here is the fix:\n```ts\nconst a = 2;\n```\nThis changes a.', 'const a = 1;'), 'const a = 2;');
  assert.equal(cleanInlineEdit('```ts\nconst a = 2;', 'const a = 1;'), 'const a = 2;');
});

test('clean: keeps fences when the selection is itself fenced markdown', () => {
  const sel = '```js\nold();\n```';
  assert.equal(cleanInlineEdit('```js\nnew();\n```', sel), '```js\nnew();\n```');
});

test('clean: removes thinking, and an unterminated thought means no change', () => {
  assert.equal(cleanInlineEdit('<think>hmm\nmore</think>\nconst a = 2;', 'const a = 1;'), 'const a = 2;');
  assert.equal(cleanInlineEdit('<thinking>x</thinking><think>y</think>const a = 2;', 'const a = 1;'), 'const a = 2;');
  assert.equal(cleanInlineEdit('<think>never finished', 'const a = 1;'), '');
});

test('clean: thinking does not eat the first line indentation', () => {
  assert.equal(cleanInlineEdit('<think>x</think>\n    b();', '    a();'), '    b();');
});

test('clean: empty, blank and unchanged replies mean no change', () => {
  assert.equal(cleanInlineEdit('', 'a'), '');
  assert.equal(cleanInlineEdit('  \n\n', 'a'), '');
  assert.equal(cleanInlineEdit('```\n```', 'a'), '');
  assert.equal(cleanInlineEdit('a', 'a'), '');
  assert.equal(cleanInlineEdit('```ts\n  a\n```', '  a'), '');
});

test('clean: preserves CRLF, including lines the model added', () => {
  assert.equal(cleanInlineEdit('a2\nb2\nc2', 'a\r\nb'), 'a2\r\nb2\r\nc2');
  assert.equal(cleanInlineEdit('a2\r\nb2', 'a\r\nb\r\n'), 'a2\r\nb2\r\n');
});

test('clean: LF selection stays LF even if the model replies with CRLF', () => {
  assert.equal(cleanInlineEdit('a2\r\nb2', 'a\nb'), 'a2\nb2');
});

test('clean: a single-line selection uses the document EOL for new lines', () => {
  assert.equal(cleanInlineEdit('a\nb', 'x', { eol: '\r\n' }), 'a\r\nb');
  assert.equal(cleanInlineEdit('a\nb', 'x'), 'a\nb');
});

test('clean: keeps the selection trailing newline and leading blank lines', () => {
  assert.equal(cleanInlineEdit('b();', 'a();\n'), 'b();\n');
  assert.equal(cleanInlineEdit('b();\n\n', '\n  a();\n'), '\n  b();\n');
});

test('clean: restores base indentation on a dedented reply', () => {
  assert.equal(cleanInlineEdit('if (x) {\n  y();\n}', '    if (a) {\n      b();\n    }'), '    if (x) {\n      y();\n    }');
});

test('clean: removes extra indentation from an over-indented reply', () => {
  assert.equal(cleanInlineEdit('        if (x) {\n          y();\n        }', '    if (a) {\n      b();\n    }'), '    if (x) {\n      y();\n    }');
});

test('clean: repairs a reply where only the first line lost its indent', () => {
  assert.equal(cleanInlineEdit('if (x) {\n      y();\n    }', '    if (a) {\n      b();\n    }'), '    if (x) {\n      y();\n    }');
});

test('clean: one selected line growing to several keeps relative indentation', () => {
  assert.equal(cleanInlineEdit('if a:\n    b()', '    c()'), '    if a:\n        b()');
});

test('clean: tabs are kept as the base indentation', () => {
  assert.equal(cleanInlineEdit('x();\ny();', '\t\ta();\n\t\tb();'), '\t\tx();\n\t\ty();');
});

test('clean: blank lines inside the reply are not indented', () => {
  assert.equal(cleanInlineEdit('a();\n\nb();', '  x();\n  y();'), '  a();\n\n  b();');
});

test('clean: a selection starting mid-line gets no indent on its first line', () => {
  assert.equal(cleanInlineEdit('foo(1,\n      2)', 'bar(1,\n      2)'), 'foo(1,\n      2)');
});

test('clean: echoed prompt tags are removed', () => {
  assert.equal(cleanInlineEdit('<selection>\nconst a = 2;\n</selection>', 'const a = 1;'), 'const a = 2;');
  assert.equal(cleanInlineEdit('<before>\nx\n</before>\n<selection>\nb\n</selection>\n<after>\ny\n</after>', 'a'), 'b');
  assert.equal(cleanInlineEdit('<before>\nx\n</before>\nb\n<after>\ny\n</after>', 'a'), 'b');
});

test('clean: echoed surrounding lines are removed', () => {
  const opts = { before: 'function f() {\n  const z = 0;\n', after: '\n  return z;\n}' };
  assert.equal(cleanInlineEdit('function f() {\n  const z = 0;\n  const a = 2;\n  return z;\n}', '  const a = 1;', opts), '  const a = 2;');
});

test('clean: a line that is really in the selection is not treated as an echo', () => {
  const opts = { before: 'dup();\n', after: '\ndup();' };
  assert.equal(cleanInlineEdit('dup();\nb();', 'dup();\na();', opts), 'dup();\nb();');
});

test('clean: a lead-in sentence is dropped, ordinary code ending in a colon is not', () => {
  assert.equal(cleanInlineEdit('Here is the updated code:\nb();', 'a();'), 'b();');
  assert.equal(cleanInlineEdit('if x:\n    y()', 'if a:\n    b()'), 'if x:\n    y()');
});

test('trimAround: short text is untouched and long text stays within the limit around the offset', () => {
  assert.equal(trimAround('abc', 1, 10), 'abc');
  assert.equal(trimAround('abc', 1, 0), '');
  const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const at = text.indexOf('line 250');
  const out = trimAround(text, at, 400);
  assert.ok(out.length <= 400);
  assert.ok(out.includes('line 250'));
  assert.ok(out.startsWith('line '), 'cut on a line boundary');
});

test('trimAround: offsets at either end keep that end', () => {
  const text = 'x'.repeat(1000) + 'END';
  assert.ok(trimAround(text, text.length, 100).endsWith('END'));
  assert.ok(trimAround(`START${'x'.repeat(1000)}`, 0, 100).startsWith('START'));
  assert.ok(trimAround(text, 99999, 100).endsWith('END'));
});

test('buildInlineEditMessages: carries every part and bounds the context', () => {
  const m = buildInlineEditMessages({ instruction: 'rename it', language: 'ts', file: 'a.ts', before: `${'b'.repeat(50000)}\nBEFORE`, selection: 'SEL', after: `AFTER\n${'c'.repeat(50000)}`, diagnostics: ['line 3: bad'] });
  assert.equal(m[0].role, 'system');
  const u = m[1].content!;
  for (const part of ['a.ts (ts)', 'BEFORE', '<selection>\nSEL\n</selection>', 'AFTER', 'line 3: bad', 'rename it']) { assert.ok(u.includes(part), part); }
  assert.ok(u.length < 12000);
});

test('buildFixPrompt: names the problem and the place, and survives fences in the code', () => {
  const p = buildFixPrompt({ message: 'x is undefined', severity: 'error', source: 'ts', code: 2304 }, 'src/a.ts', 12, 'const y = x;');
  for (const part of ['error', 'src/a.ts', 'line 12', 'ts 2304', 'x is undefined', 'const y = x;']) { assert.ok(p.includes(part), part); }
  assert.ok(buildFixPrompt({ message: 'm' }, 'a.md', 1, '```js\nx\n```').includes('````\n```js'));
});

/* ------------------------------------------------------------ notify */

const T0 = 1_000_000;
const agent = (over: Partial<AgentActivity> = {}): AgentActivity => ({
  sessionId: 's1', agentId: 'a1', role: 'main', status: 'running', title: 'My task', activity: 'Thinking…', startedAt: T0, ...over,
});
const away: NotifyContext = { windowFocused: false, panelVisible: false, minDurationMs: 30000, now: T0 + 60000 };
const looking: NotifyContext = { ...away, windowFocused: true, panelVisible: true };
const sub = (over: Partial<AgentActivity> = {}): AgentActivity => agent({ agentId: 'b1', role: 'sub', description: 'Scan repo', background: true, ...over });

test('notify: waiting for approval or a question notifies when not looking', () => {
  for (const activity of ['Waiting for approval: rm x', 'Waiting for your answer: which?', 'Waiting for plan approval']) {
    const d = decideNotification(agent(), agent({ status: 'waiting', activity }), away);
    assert.equal(d?.kind, 'needsInput', activity);
    assert.ok(d!.message.includes(activity));
  }
});

test('notify: waiting is silent when looking at that panel, but not when only one of focus/panel holds', () => {
  const next = agent({ status: 'waiting', activity: 'Waiting for approval: x' });
  assert.equal(decideNotification(agent(), next, looking), undefined);
  assert.equal(decideNotification(agent(), next, { ...away, windowFocused: true })?.kind, 'needsInput');
  assert.equal(decideNotification(agent(), next, { ...away, panelVisible: true })?.kind, 'needsInput');
});

test('notify: waiting ignores the duration threshold', () => {
  const next = agent({ status: 'waiting', activity: 'Waiting for approval: x', startedAt: away.now! - 5 });
  assert.equal(decideNotification(agent(), next, away)?.kind, 'needsInput');
});

test('notify: a first-seen agent already waiting notifies', () => {
  assert.equal(decideNotification(undefined, agent({ status: 'waiting', activity: 'Waiting for approval: x' }), away)?.kind, 'needsInput');
});

test('notify: staying on the same wait does not repeat, a new request does', () => {
  const a = agent({ status: 'waiting', activity: 'Waiting for approval: one' });
  assert.equal(decideNotification(a, { ...a }, away), undefined);
  assert.equal(decideNotification(a, { ...a, activity: 'Read foo.ts' }, away), undefined, 'a parallel tool updating the activity is not a new request');
  assert.equal(decideNotification(a, { ...a, activity: 'Waiting for approval: two' }, away)?.kind, 'needsInput');
});

test('notify: a long main task that ended idle notifies when not looking', () => {
  const d = decideNotification(agent(), agent({ status: 'idle', activity: 'Idle' }), away);
  assert.equal(d?.kind, 'taskDone');
  assert.equal(d?.sessionId, 's1');
});

test('notify: a short main task is silent, the threshold itself counts as long enough', () => {
  const done = agent({ status: 'idle', activity: 'Idle' });
  assert.equal(decideNotification(agent(), done, { ...away, now: T0 + 29999 }), undefined);
  assert.equal(decideNotification(agent(), done, { ...away, now: T0 + 30000 })?.kind, 'taskDone');
});

test('notify: minDurationMs defaults to 30 seconds', () => {
  const done = agent({ status: 'idle', activity: 'Idle' });
  const { minDurationMs: _m, ...rest } = away;
  assert.equal(decideNotification(agent(), done, { ...rest, now: T0 + 29999 }), undefined);
  assert.equal(decideNotification(agent(), done, { ...rest, now: T0 + 30000 })?.kind, 'taskDone');
});

test('notify: a finished main task is silent while the user is looking', () => {
  assert.equal(decideNotification(agent(), agent({ status: 'idle' }), looking), undefined);
});

test('notify: the start time comes from the previous state once the runtime has cleared it', () => {
  assert.equal(decideNotification(agent(), agent({ status: 'idle', startedAt: undefined }), away)?.kind, 'taskDone');
});

test('notify: a main task with no known start, or leaving the queue, is silent', () => {
  assert.equal(decideNotification(agent({ startedAt: undefined }), agent({ status: 'idle', startedAt: undefined }), away), undefined);
  assert.equal(decideNotification(agent({ status: 'queued' }), agent({ status: 'idle' }), away), undefined);
});

test('notify: a main task ending straight from waiting counts as finished', () => {
  assert.equal(decideNotification(agent({ status: 'waiting' }), agent({ status: 'idle' }), away)?.kind, 'taskDone');
});

test('notify: errors notify, even while looking and even when short', () => {
  const next = agent({ status: 'error', activity: 'Error: LLM HTTP 500', startedAt: away.now! - 1 });
  for (const ctx of [away, looking]) {
    const d = decideNotification(agent(), next, ctx);
    assert.equal(d?.kind, 'error');
    assert.equal(d?.level, 'error');
    assert.ok(d!.message.includes('LLM HTTP 500'));
  }
});

test('notify: an error already reported, or restored from disk, is silent', () => {
  const e = agent({ status: 'error', activity: 'Error: x' });
  assert.equal(decideNotification(e, { ...e }, away), undefined);
  assert.equal(decideNotification(undefined, e, away), undefined);
});

test('notify: a stale cancelled outcome from an earlier run does not hide a new error', () => {
  const next = sub({ status: 'error', activity: 'Error: x', outcome: 'cancelled', startedAt: T0 });
  assert.equal(decideNotification(sub(), next, away)?.kind, 'error');
});

test('notify: a background sub-agent finishing notifies, even while looking', () => {
  const next = sub({ status: 'idle', activity: 'Idle', startedAt: undefined, outcome: 'completed' });
  for (const ctx of [away, looking]) {
    const d = decideNotification(sub(), next, ctx);
    assert.equal(d?.kind, 'backgroundAgent');
    assert.ok(d!.message.includes('Scan repo'));
  }
});

test('notify: a background sub-agent that failed without an error status is a warning', () => {
  const d = decideNotification(sub(), sub({ status: 'idle', startedAt: undefined, outcome: 'failed' }), away);
  assert.equal(d?.kind, 'backgroundAgent');
  assert.equal(d?.level, 'warning');
});

test('notify: a foreground sub-agent finishing is silent', () => {
  assert.equal(decideNotification(sub({ background: false }), sub({ background: false, status: 'idle', startedAt: undefined, outcome: 'completed' }), away), undefined);
});

test('notify: a sub-agent is announced only once settled, so a stale outcome is never reported', () => {
  const t = new NotificationTracker();
  assert.equal(t.observe(sub({ outcome: 'completed' }), away), undefined);
  assert.equal(t.observe(sub({ status: 'idle', outcome: 'completed' }), away), undefined, 'idle but not settled yet');
  assert.equal(t.observe(sub({ status: 'idle', outcome: 'cancelled', startedAt: undefined }), away), undefined, 'this run was stopped');
});

test('notify: settling after the idle transition notifies exactly once', () => {
  const t = new NotificationTracker();
  t.observe(sub(), away);
  assert.equal(t.observe(sub({ status: 'idle' }), away), undefined);
  assert.equal(t.observe(sub({ status: 'idle', startedAt: undefined, outcome: 'completed' }), away)?.kind, 'backgroundAgent');
  assert.equal(t.observe(sub({ status: 'idle', startedAt: undefined, outcome: 'completed' }), away), undefined);
});

test('notify: a failing sub-agent reports the error once, not again when it settles', () => {
  const t = new NotificationTracker();
  t.observe(sub(), away);
  assert.equal(t.observe(sub({ status: 'error', activity: 'Error: x' }), away)?.kind, 'error');
  assert.equal(t.observe(sub({ status: 'error', activity: 'Error: x', startedAt: undefined, outcome: 'failed' }), away), undefined);
});

test('notify: never twice for the same transition', () => {
  const t = new NotificationTracker();
  t.observe(agent(), away);
  assert.equal(t.observe(agent({ status: 'idle' }), away)?.kind, 'taskDone');
  assert.equal(t.observe(agent({ status: 'idle' }), away), undefined);
  assert.equal(t.observe(agent({ status: 'idle', startedAt: undefined }), away), undefined);
});

test('notify: a later run of the same agent can notify again', () => {
  const t = new NotificationTracker();
  t.observe(agent(), away);
  assert.equal(t.observe(agent({ status: 'idle', startedAt: undefined }), away)?.kind, 'taskDone');
  t.observe(agent({ startedAt: T0 + 10 }), away);
  assert.equal(t.observe(agent({ status: 'idle', startedAt: T0 + 10 }), away)?.kind, 'taskDone');
});

test('notify: cancelled by the user never notifies', () => {
  assert.equal(decideNotification(agent(), agent({ status: 'idle', cancelled: true }), away), undefined);
  assert.equal(decideNotification(agent(), agent({ status: 'error', activity: 'Error: Cancelled', cancelled: true }), away), undefined);
  assert.equal(decideNotification(sub(), sub({ status: 'idle', startedAt: undefined, outcome: 'cancelled' }), away), undefined);
  assert.equal(decideNotification(sub(), sub({ status: 'error', startedAt: undefined, outcome: 'cancelled' }), away), undefined);
  assert.equal(decideNotification(agent(), agent({ status: 'interrupted' }), away), undefined);
});

test('notify: each category can be switched off on its own', () => {
  const cases: Array<[string, AgentActivity, AgentActivity]> = [
    ['needsInput', agent(), agent({ status: 'waiting', activity: 'Waiting for approval: x' })],
    ['taskDone', agent(), agent({ status: 'idle' })],
    ['errors', agent(), agent({ status: 'error', activity: 'Error: x' })],
    ['backgroundAgents', sub(), sub({ status: 'idle', startedAt: undefined, outcome: 'completed' })],
  ];
  for (const [key, prev, next] of cases) {
    assert.ok(decideNotification(prev, next, away), `${key} on by default`);
    assert.equal(decideNotification(prev, next, { ...away, settings: { [key]: false } }), undefined, key);
    for (const [other] of cases.filter(([k]) => k !== key)) {
      assert.ok(decideNotification(prev, next, { ...away, settings: { [other]: false } }), `${key} ignores ${other}`);
    }
  }
});

test('notify: ordinary progress never notifies', () => {
  assert.equal(decideNotification(agent(), agent({ activity: 'Read a.ts' }), away), undefined);
  assert.equal(decideNotification(agent({ status: 'idle' }), agent(), away), undefined);
  assert.equal(decideNotification(undefined, agent({ status: 'idle' }), away), undefined);
});

test('tracker: forget drops a session only', () => {
  const t = new NotificationTracker();
  t.observe(agent(), away);
  t.observe(agent({ sessionId: 's2' }), away);
  t.forget('s1');
  assert.equal(t.has('s1'), false);
  assert.deepEqual(t.sessionIds(), ['s2']);
  assert.equal(t.observe(agent({ status: 'idle' }), away), undefined, 'no previous state after forget');
  assert.equal(t.observe(agent({ sessionId: 's2', status: 'idle' }), away)?.kind, 'taskDone');
});

test('tracker: agents in one session are tracked separately', () => {
  const t = new NotificationTracker();
  t.observe(agent(), away);
  t.observe(agent({ agentId: 'a2', status: 'idle' }), away);
  assert.equal(t.observe(agent({ status: 'idle' }), away)?.agentId, 'a1');
});

/* ------------------------------------------------------------ host feature files (source level) */

const ROOT = [process.cwd(), path.resolve(__dirname, '../..')].find((d) => fs.existsSync(path.join(d, 'src/host/features/editorActions.ts')))!;
const ts = createRequire(path.join(ROOT, 'package.json'))('typescript') as typeof import('typescript');
const FEATURES = ['editorActions', 'notifications', 'terminalRunner'];
const parse = (rel: string) => ts.createSourceFile(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'), ts.ScriptTarget.ES2022, true);
const feature = (name: string) => parse(`src/host/features/${name}.ts`);

function walk(node: import('typescript').Node, visit: (n: import('typescript').Node) => void): void {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
}

/** Runtime (non type-only) import specifiers of a file. */
const runtimeImports = (sf: import('typescript').SourceFile): string[] => sf.statements
  .filter(ts.isImportDeclaration).filter((d) => !d.importClause?.isTypeOnly).map((d) => (d.moduleSpecifier as import('typescript').StringLiteral).text);

function codeActionsMethod(): import('typescript').MethodDeclaration {
  let found: import('typescript').MethodDeclaration | undefined;
  walk(feature('editorActions'), (n) => { if (ts.isMethodDeclaration(n) && n.name.getText() === 'provideCodeActions') { found = n; } });
  assert.ok(found, 'provideCodeActions exists');
  return found!;
}

test('source: provideCodeActions is synchronous and never reaches the host or the LLM', () => {
  const m = codeActionsMethod();
  assert.ok(!m.modifiers?.some((x) => x.kind === ts.SyntaxKind.AsyncKeyword), 'not async');
  walk(m, (n) => {
    assert.ok(!ts.isAwaitExpression(n), 'no await');
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText();
      assert.ok(!/^getHost$|\.llm$|^llm$|llmConfig|withProgress|openTextDocument/.test(callee), `must not call ${callee}`);
    }
  });
});

test('source: feature files do no work at import time', () => {
  for (const name of FEATURES) {
    const sf = feature(name);
    for (const st of sf.statements) {
      assert.ok(!ts.isExpressionStatement(st), `${name}: top-level expression: ${st.getText().slice(0, 60)}`);
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          let call = false;
          const scan = (n: import('typescript').Node): void => {
            if (ts.isFunctionLike(n)) { return; }
            if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isAwaitExpression(n)) { call = true; }
            ts.forEachChild(n, scan);
          };
          if (d.initializer) { scan(d.initializer); }
          assert.ok(!call, `${name}: eager initializer on ${d.name.getText()}`);
        }
      }
    }
  }
});

test('source: no top-level await in feature files', () => {
  for (const name of FEATURES) {
    const scan = (n: import('typescript').Node): void => {
      if (ts.isFunctionLike(n)) { return; }
      assert.ok(!ts.isAwaitExpression(n), `${name}: top-level await`);
      ts.forEachChild(n, scan);
    };
    scan(feature(name));
  }
});

test('source: feature files do not import the hub', () => {
  for (const name of FEATURES) {
    assert.ok(!runtimeImports(feature(name)).some((m) => /(^|\/)hub$/.test(m)), name);
  }
});

test('source: the terminal runner loads heavy modules lazily', () => {
  const imports = runtimeImports(feature('terminalRunner'));
  for (const heavy of ['child_process', '../../core/fstools']) { assert.ok(!imports.includes(heavy), heavy); }
});

test('source: shell integration APIs newer than the engine are only reached through any', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/host/features/terminalRunner.ts'), 'utf8');
  assert.ok(!/vscode\.window\.onDid(?:Change|End|Start)TerminalShell/.test(src));
  assert.ok(!/\bterm(?:inal)?\.shellIntegration/.test(src));
  assert.ok(/typeof win\.onDidChangeTerminalShellIntegration === 'function'/.test(src));
});

test('source: core modules stay free of vscode', () => {
  for (const rel of ['src/core/inlineEdit.ts', 'src/core/notify.ts']) {
    assert.ok(!runtimeImports(parse(rel)).includes('vscode'), rel);
  }
});
