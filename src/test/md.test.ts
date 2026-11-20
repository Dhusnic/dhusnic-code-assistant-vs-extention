import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { md } = require(path.join(__dirname, '..', '..', 'media', 'md.js'));

test('tables: the exact answer from the bug report (blank lines between rows) renders as a table', () => {
  const src = [
    'Log Collector Health Color Meanings',
    '| Color | Status Code | Meaning |', '',
    '|-------|-------------|---------|', '',
    '| green | status: 1 | All hosts are healthy - Every configured Logstash/Vector host is responding |', '',
    '| orange | status: 2 | Degraded - Some hosts are up but not all are green |', '',
    '| red | status: 0 | All hosts down - No hosts are responding or reporting healthy |',
  ].join('\n');
  const out = md(src);
  assert.match(out, /<p>Log Collector Health Color Meanings<\/p>/);
  assert.match(out, /<table><thead><tr><th>Color<\/th><th>Status Code<\/th><th>Meaning<\/th><\/tr><\/thead>/);
  assert.equal((out.match(/<tr>/g) || []).length, 4, 'header + 3 rows');
  assert.match(out, /<td>orange<\/td><td>status: 2<\/td>/);
  assert.doesNotMatch(out.replace(/data-src="[^"]*"/g, ''), /\|-------\|/, 'separator row is not printed as text');
  assert.match(out, /data-src="\| Color \| Status Code \| Meaning \|\n\|-------\|/, 'the original markdown is kept for the Copy button');
});

test('tables: standard GFM, alignment, inline formatting, escaped pipes, ragged rows', () => {
  const out = md('| a | b | c |\n|:--|:-:|--:|\n| **x** | `y|z` | 1 \\| 2 |\n| only one |');
  assert.match(out, /<th style="text-align:left">a<\/th><th style="text-align:center">b<\/th><th style="text-align:right">c<\/th>/);
  assert.match(out, /<td style="text-align:left"><b>x<\/b><\/td>/);
  assert.match(out, /1 \| 2/);
  assert.match(out, /<tr><td style="text-align:left">only one<\/td><td style="text-align:center"><\/td><td style="text-align:right"><\/td><\/tr>/, 'missing cells are padded');
});

test('tables: tables without outer pipes and text around them', () => {
  const out = md('Intro\n\nName | Value\n--- | ---\nk | v\n\nOutro');
  assert.match(out, /<p>Intro<\/p><div class="tablewrap" data-src="Name \| Value\n--- \| ---\nk \| v"><div class="tbar">/);
  assert.match(out, /data-copy-table="md"[\s\S]*data-copy-table="tsv"/, 'every table has Copy and Copy-for-Excel buttons');
  assert.match(out, /<td>k<\/td><td>v<\/td>/);
  assert.match(out, /<\/table><\/div><p>Outro<\/p>$/);
});

test('tables: cell content is escaped (no HTML injection)', () => {
  const out = md('| a |\n|---|\n| <img src=x onerror=alert(1)> |');
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img/);
});

test('tables: a lone pipe in prose is not a table', () => {
  assert.doesNotMatch(md('use a | b to pipe'), /<table>/);
  assert.doesNotMatch(md('| just one line |'), /<table>/);
});

test('mermaid: fenced mermaid becomes a renderable block, flagged complete only when the fence is closed', () => {
  const done = md('```mermaid\ngraph TD\n  A-->B\n```');
  assert.match(done, /class="mermaid-block" data-complete="1" data-src="graph TD\n {2}A--&gt;B"/);
  const streaming = md('```mermaid\ngraph TD\n  A-->');
  assert.match(streaming, /data-complete="0"/);
  assert.match(md('```mermaid\ngraph TD; A["<script>"]-->B\n```'), /&lt;script&gt;/);
});

test('extras: deeper headings, rules, task lists, strikethrough', () => {
  const out = md('#### Deep\n---\n- [x] done\n- [ ] todo\n~~old~~');
  assert.match(out, /<h4>Deep<\/h4><hr>/);
  assert.match(out, /<ul class="tasks"><li><input type="checkbox" disabled checked> done<\/li><li><input type="checkbox" disabled> todo<\/li><\/ul>/);
  assert.match(out, /<s>old<\/s>/);
});

test('tables: a horizontal rule under a line that happens to contain pipes is not a table', () => {
  const out = md('a | b | c\n---\nnext');
  assert.doesNotMatch(out, /<table>/);
  assert.match(out, /<hr>/);
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { inline: mdInline, autolink } = require(path.join(__dirname, '..', '..', 'media', 'md.js'));

test('links: the sources line from the bug report renders as two clickable links', () => {
  const out = md('**Source**: [MDN - Using the Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch) and [MDN - AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)');
  assert.match(out, /<b>Source<\/b>/);
  assert.match(out, /<a href="https:\/\/developer\.mozilla\.org\/en-US\/docs\/Web\/API\/Fetch_API\/Using_Fetch" class="ext-link" data-href="[^"]+" title="[^"]+">MDN - Using the Fetch API<\/a>/);
  assert.match(out, />MDN - AbortController<\/a>/);
  assert.doesNotMatch(out, /\]\(/, 'no raw markdown link syntax left');
});

test('links: bare URLs, <autolinks>, query strings and trailing punctuation', () => {
  const out = mdInline('See https://example.com/a_b?x=1&y=2. Or <https://example.org/z> (https://example.net/p).');
  assert.match(out, /<a href="https:\/\/example\.com\/a_b\?x=1&amp;y=2"[^>]*>https:\/\/example\.com\/a_b\?x=1&amp;y=2<\/a>\./);
  assert.match(out, />https:\/\/example\.org\/z<\/a>/);
  assert.match(out, /\(<a href="https:\/\/example\.net\/p"[^>]*>https:\/\/example\.net\/p<\/a>\)/);
  assert.doesNotMatch(out, /&lt;https/);
});

test('links: emphasis inside a URL is untouched, link text keeps formatting and code', () => {
  const out = mdInline('[**bold** `code`](https://x.example/a*b*c~~d~~) and https://y.example/__init__*x*');
  assert.match(out, /href="https:\/\/x\.example\/a\*b\*c~~d~~"/);
  assert.match(out, /><b>bold<\/b> <code>code<\/code><\/a>/);
  assert.match(out, /href="https:\/\/y\.example\/__init__\*x"/);
});

test('links: unsafe schemes stay text, code spans are not linkified, attributes cannot be broken out of', () => {
  const out = mdInline('[click](javascript:alert(1)) [f](file:///etc/passwd) `https://in.code/x` [q](https://a.example/"onmouseover="x)');
  assert.doesNotMatch(out, /href="javascript/);
  assert.doesNotMatch(out, /href="file/);
  assert.match(out, /<code>https:\/\/in\.code\/x<\/code>/);
  assert.doesNotMatch(out, /"onmouseover="/);
  assert.match(mdInline('[mail me](mailto:a@b.example)'), /href="mailto:a@b\.example"/);
});

test('links: plain-text info messages get clickable URLs and nothing else', () => {
  const out = autolink('[1] Fetch API — https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API · official docs\n<b>not bold</b>');
  assert.match(out, /\[1\] Fetch API — <a href="https:\/\/developer\.mozilla\.org\/en-US\/docs\/Web\/API\/Fetch_API"/);
  assert.match(out, /&lt;b&gt;not bold&lt;\/b&gt;/);
});
