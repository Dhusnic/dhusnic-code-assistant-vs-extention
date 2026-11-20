import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import {
  MAX_REFERENCES, applyTextEdits, displayPath, findSymbolColumn, formatLocations, formatOutline, insideRoot, isValidNewName, offsetAt,
} from '../core/nav';

const ROOT = path.resolve('/ws');
const abs = (p: string) => path.join(ROOT, p);

/* ------------------------------------------------------------------ findSymbolColumn */

test('findSymbolColumn: whole-word match on the given line, 0-based result', () => {
  const lines = ['const userName = 1;', 'print(user, userName);'];
  assert.deepEqual(findSymbolColumn(lines, 2, 'user'), { line: 1, character: 6 });
  assert.deepEqual(findSymbolColumn(lines, 2, 'userName'), { line: 1, character: 12 });
});

test('findSymbolColumn: identifiers with $ and _ are not matched inside longer names', () => {
  const lines = ['let $el = _x + $el2 + a_x;', 'use($el)'];
  assert.deepEqual(findSymbolColumn(lines, 1, '$el'), { line: 0, character: 4 });
  assert.deepEqual(findSymbolColumn(lines, 1, '_x'), { line: 0, character: 10 });
  assert.equal(findSymbolColumn(['a_x'], 1, 'x'), undefined);
});

test('findSymbolColumn: searches ±3 lines, nearest first, and gives up beyond that', () => {
  const lines = ['foo', '', '', '', '', '', '', 'bar', '', 'foo'];
  assert.deepEqual(findSymbolColumn(lines, 8, 'bar'), { line: 7, character: 0 });
  assert.deepEqual(findSymbolColumn(lines, 7, 'bar'), { line: 7, character: 0 });
  assert.deepEqual(findSymbolColumn(lines, 8, 'foo'), { line: 9, character: 0 }); // line 10 is 2 away, line 1 is 7 away
  assert.equal(findSymbolColumn(lines, 5, 'missing'), undefined);
  assert.equal(findSymbolColumn(['x'], 1, ''), undefined);
  assert.equal(findSymbolColumn(['x'], NaN, 'x'), undefined);
});

test('findSymbolColumn: CRLF line endings and regex characters in the symbol', () => {
  assert.deepEqual(findSymbolColumn(['a.b(c)\r'], 1, 'c'), { line: 0, character: 4 });
  assert.equal(findSymbolColumn(['abc'], 1, 'a.c'), undefined);
});

/* ------------------------------------------------------------------ paths and locations */

test('insideRoot / displayPath', () => {
  assert.ok(insideRoot(ROOT, abs('src/a.ts')));
  assert.ok(!insideRoot(ROOT, path.resolve('/other/a.ts')));
  assert.equal(displayPath(ROOT, abs('src/a.ts')), 'src/a.ts');
  assert.match(displayPath(ROOT, path.resolve('/lib/x.d.ts')), /x\.d\.ts \(outside workspace\)$/);
});

test('formatLocations: groups by file, sorts, de-duplicates and shows code lines', () => {
  const locs = [
    { file: abs('b.ts'), line: 4, character: 0 },
    { file: abs('a.ts'), line: 9, character: 2 },
    { file: abs('a.ts'), line: 1, character: 0 },
    { file: abs('a.ts'), line: 1, character: 0 },
  ];
  const out = formatLocations(locs, ROOT, (f, l) => `  code ${path.basename(f)}:${l + 1}  `);
  assert.equal(out, [
    '3 locations in 2 files:', '', 'a.ts', '  a.ts:2: code a.ts:2', '  a.ts:10: code a.ts:10', '', 'b.ts', '  b.ts:5: code b.ts:5',
  ].join('\n'));
});

test('formatLocations: caps the list and says how many were left out', () => {
  const locs = Array.from({ length: MAX_REFERENCES + 5 }, (_, i) => ({ file: abs('a.ts'), line: i, character: 0 }));
  const out = formatLocations(locs, ROOT);
  assert.match(out, /^205 locations in 1 file:/);
  assert.match(out, /\[5 more not shown; narrow the search\]$/);
  assert.equal(out.split('\n').filter((l) => l.startsWith('  a.ts:')).length, MAX_REFERENCES);
});

test('formatLocations: outside-workspace files are marked', () => {
  const out = formatLocations([{ file: path.resolve('/lib/x.d.ts'), line: 0, character: 0 }], ROOT);
  assert.match(out, /x\.d\.ts \(outside workspace\)/);
});

/* ------------------------------------------------------------------ edits */

test('offsetAt: handles LF, CRLF and clamps', () => {
  assert.equal(offsetAt('ab\ncd', 1, 1), 4);
  assert.equal(offsetAt('ab\r\ncd', 1, 0), 4);
  assert.equal(offsetAt('ab\r\ncd', 0, 99), 2); // clamps before \r
  assert.equal(offsetAt('ab', 5, 0), 2);
});

test('applyTextEdits: applies from the end regardless of input order', () => {
  const text = 'let foo = foo + 1; foo();';
  const out = applyTextEdits(text, [
    { startOffset: 4, endOffset: 7, newText: 'bar' },
    { startOffset: 19, endOffset: 22, newText: 'bar' },
    { startOffset: 10, endOffset: 13, newText: 'bar' },
  ]);
  assert.equal(out, 'let bar = bar + 1; bar();');
});

test('applyTextEdits: insertions, empty list, invalid and overlapping edits', () => {
  assert.equal(applyTextEdits('ab', [{ startOffset: 1, endOffset: 1, newText: 'X' }]), 'aXb');
  assert.equal(applyTextEdits('ab', []), 'ab');
  assert.throws(() => applyTextEdits('ab', [{ startOffset: 0, endOffset: 5, newText: '' }]), /Invalid edit range/);
  assert.throws(() => applyTextEdits('abcdef', [{ startOffset: 0, endOffset: 3, newText: '' }, { startOffset: 2, endOffset: 4, newText: '' }]), /Overlapping/);
});

/* ------------------------------------------------------------------ outline and names */

test('formatOutline: nested, sorted by line, single-line ranges', () => {
  const out = formatOutline([
    { name: 'helper', kind: 'Function', startLine: 30, endLine: 30 },
    { name: 'User', kind: 'Class', startLine: 1, endLine: 20, children: [
      { name: 'save', kind: 'Method', startLine: 10, endLine: 15, detail: '(): void' },
      { name: 'id', kind: 'Property', startLine: 2, endLine: 2 },
    ] },
  ]);
  assert.equal(out, [
    'class User  (lines 1-20)', '  property id  (line 2)', '  method save (): void  (lines 10-15)', 'function helper  (line 30)',
  ].join('\n'));
});

test('isValidNewName', () => {
  assert.ok(isValidNewName('newName'));
  assert.ok(isValidNewName('$x_1'));
  assert.ok(!isValidNewName(''));
  assert.ok(!isValidNewName('two words'));
  assert.ok(!isValidNewName(42));
});
