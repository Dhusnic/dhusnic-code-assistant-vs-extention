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
