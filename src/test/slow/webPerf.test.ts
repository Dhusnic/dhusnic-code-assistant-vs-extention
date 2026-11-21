import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { htmlToDoc } from '../../core/web/extract/html';

// Timing test moved from web_extract.test.ts: it runs in the slow stage, one file at a time (--test-concurrency=1),
// because next to 1000 other tests the CPU is shared and the 2 s bound measures the machine, not the parser.

const BASE = 'https://example.com/docs/page.html';

test('5 MB pathological HTML finishes quickly', () => {
  const cases = [
    '<div>'.repeat(200_000) + 'deep text' + '<p>x'.repeat(200_000),
    '<b><i><a href="/x">'.repeat(100_000),
    '<table><tr><td>'.repeat(80_000) + 'cell',
    '<pre>' + ' '.repeat(2_000_000) + 'x' + '\n'.repeat(1_000_000) + 'y</pre>' + '<p a="'.repeat(10) + '<!--' + '<'.repeat(100_000),
    '<blockquote>'.repeat(100_000) + 'q '.repeat(1_500_000),
    '<ul><li>'.repeat(100_000) + '`'.repeat(200_000),
    '<a href="/x">y</a>'.repeat(150_000),
  ];
  for (const html of cases) {
    const started = Date.now();
    const doc = htmlToDoc(html, BASE);
    const ms = Date.now() - started;
    assert.ok(ms < 2000, `took ${ms} ms for input of ${html.length} chars`);
    assert.equal(typeof doc.markdown, 'string');
  }
  // 5 MB each: 1M unclosed <div>s, and 1.25M paragraphs (past the element budget the rest is kept as text).
  let started = Date.now();
  assert.equal(htmlToDoc(`${'<div>'.repeat(1_000_000)}end`, BASE).markdown, 'end');
  assert.ok(Date.now() - started < 2000);
  started = Date.now();
  const flat = htmlToDoc('<p>x'.repeat(1_250_000), BASE);
  assert.ok(Date.now() - started < 2000);
  assert.ok(flat.warnings.some((w) => w.startsWith('Very large page')));
  assert.ok(flat.markdown.endsWith('xxxx'));
});
