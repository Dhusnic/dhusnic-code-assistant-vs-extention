/**
 * Extra context for inline completions (core/completionContext.ts): import parsing and resolution, signature
 * extraction, open-tab snippet selection and ordering, and fitting everything into the character budget.
 * File reads go through an in-memory map; nothing touches the disk or the network.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  ContextSnippet, OpenFile, extractSignatures, fitSnippets, gatherContext, importSnippets, isSensitivePath, parseImports, tabSnippets,
} from '../core/completionContext';

const reader = (files: Record<string, string>) => {
  const reads: string[] = [];
  return { reads, read: async (p: string) => { reads.push(p); return files[p]; } };
};

const MATH_TS = `import { x } from './dep';
export function add(a: number, b: number): number {
  return a + b;
}
export async function fetchAll<T>(urls: string[],
  opts?: { retries: number }): Promise<T[]> {
  return [];
}
function hidden() {}
export interface Point {
  x: number;
  y: number;
}
export type Shape = 'circle' | 'square';
export type Mode =
  | 'a'
  | 'b';
export const twice = (n: number): number => n * 2;
export const LIMIT: number = 10;
export class Calc extends Base {
  private secret = 1;
  total: number;
  constructor(public start: number) {
    super();
  }
  add(n: number): this {
    if (n) { this.total += n; }
    return this;
  }
  private reset(): void {}
}
`;

test('imports: TS named, default, namespace and require imports resolve relative to the file', () => {
  const refs = parseImports('src/app/main.ts', `import { add, type Point as P } from '../lib/math';
import Calc from './calc.js';
import * as u from "./util";
import fs from 'fs';
const { a, b: bb } = require('./req');
`);
  assert.equal(refs.length, 4, 'bare package imports are ignored');
  assert.deepEqual(refs[0].names, ['add', 'Point']);
  assert.equal(refs[0].candidates[0], 'src/lib/math.ts');
  assert.ok(refs[0].candidates.includes('src/lib/math/index.ts'));
  assert.equal(refs[1].names, undefined);
  assert.equal(refs[1].candidates[0], 'src/app/calc.ts', '.js specifiers map to .ts sources first');
  assert.equal(refs[2].names, undefined);
  assert.deepEqual(refs[3].names, ['a', 'b']);
});

test('imports: Python relative and absolute from-imports; paths outside the workspace are dropped', () => {
  const refs = parseImports('pkg/sub/mod.py', `from .helpers import load, save as s
from ..core.models import (
    User,
    Group,
)
from pkg.util import *
from . import siblings
from ....outside import nope
import os
`);
  assert.deepEqual(refs[0], { candidates: ['pkg/sub/helpers.py', 'pkg/sub/helpers/__init__.py', 'pkg/sub/helpers.pyi'], names: ['load', 'save'] });
  assert.equal(refs[1].candidates[0], 'pkg/core/models.py');
  assert.deepEqual(refs[1].names, ['User', 'Group']);
  assert.equal(refs[2].candidates[0], 'pkg/util.py'); assert.equal(refs[2].names, undefined);
  assert.equal(refs[3].candidates[0], 'pkg/sub/siblings.py');
  assert.equal(refs.length, 4);
});

test('signatures: TS functions, classes with public members, interfaces, types and consts without bodies', () => {
  const s = extractSignatures('math.ts', MATH_TS);
  assert.match(s, /^export function add\(a: number, b: number\): number;$/m);
  assert.match(s, /export async function fetchAll<T>\(urls: string\[\],\n {2}opts\?: \{ retries: number \}\): Promise<T\[\]>;/);
  assert.ok(!s.includes('hidden') && !s.includes('return a + b'), 'no private functions or bodies');
  assert.match(s, /export interface Point \{\n {2}x: number;\n {2}y: number;\n\}/);
  assert.match(s, /export type Shape = 'circle' \| 'square';/);
  assert.match(s, /export type Mode =\n {2}\| 'a'\n {2}\| 'b';/);
  assert.match(s, /export const twice = \(n: number\): number => …;/);
  assert.match(s, /export const LIMIT: number;/);
  assert.match(s, /export class Calc extends Base \{\n {2}total: number;\n {2}constructor\(public start: number\);\n {2}add\(n: number\): this;\n\}/);
  assert.ok(!/secret|reset|if \(n\)/.test(s), 'private members and statements are left out');
});

test('signatures: limited to the imported names; Python def/class headers', () => {
  assert.equal(extractSignatures('math.ts', MATH_TS, ['add']), 'export function add(a: number, b: number): number;');
  const py = `import os

def load(path: str,
         mode: str = "r") -> dict:
    return {}

def _private():
    pass

class Store(Base):
    """Doc."""
    def __init__(self, root):
        self.root = root

    def get(self, key) -> str:  # comment
        return ""

    def _hidden(self):
        pass

VALUE = 3
`;
  assert.equal(extractSignatures('m.py', py), 'def load(path: str,\n         mode: str = "r") -> dict: ...\nclass Store(Base):\n    def __init__(self, root): ...\n    def get(self, key) -> str: ...');
  assert.equal(extractSignatures('m.py', py, ['Store']).split('\n')[0], 'class Store(Base):');
  assert.equal(extractSignatures('m.go', 'func A() {}'), '', 'unsupported languages give nothing');
});

test('importSnippets: reads the first existing candidate, skips missing, sensitive and repeated files', async () => {
  const r = reader({ 'src/lib/math.ts': MATH_TS, 'src/util/index.ts': 'export function u(): void {}\n' });
  const out = await importSnippets('src/main.ts', `import { add } from './lib/math';\nimport * as u from './util';\nimport { k } from './missing';\nimport { add as a2 } from './lib/math';\nimport e from './.env';\n`, r.read);
  assert.deepEqual(out.map((s) => s.path), ['src/lib/math.ts', 'src/util/index.ts']);
  assert.equal(out[0].text, 'export function add(a: number, b: number): number;');
  assert.equal(out[0].kind, 'import');
  assert.ok(!r.reads.some((p) => p.includes('.env')), 'sensitive files are never read');
});

const cur = { file: 'src/a.ts', language: 'typescript', prefix: 'const total = computeInvoiceTotal(order, ', suffix: ')\n' };
const filler = (n: number, name: string) => Array.from({ length: n }, (_, i) => `const ${name}${i} = ${i};`).join('\n');

test('tabs: picks the window that shares identifiers with the cursor; same language first, then MRU order', () => {
  const open: OpenFile[] = [
    { path: 'docs/notes.md', language: 'markdown', text: 'computeInvoiceTotal takes an order' },
    { path: 'src/b.ts', language: 'typescript', text: `${filler(40, 'before')}\nexport function computeInvoiceTotal(order: Order, tax: number) {\n  return order.lines.length * tax;\n}\n${filler(40, 'after')}` },
    { path: 'src/c.ts', language: 'typescript', text: 'export const unrelatedThing = 1;' },
    { path: 'src/d.js', language: '', text: 'computeInvoiceTotal(order)' },
    { path: '.env', language: 'dotenv', text: 'computeInvoiceTotal=secret' },
    { path: 'src/a.ts', language: 'typescript', text: 'computeInvoiceTotal' },
  ];
  const s = tabSnippets(open, cur);
  assert.deepEqual(s.map((x) => x.path), ['src/b.ts', 'src/d.js', 'docs/notes.md'], 'no-overlap, sensitive and current files are skipped');
  assert.ok(s[0].text.includes('export function computeInvoiceTotal(order: Order'));
  assert.ok(s[0].text.split('\n').length <= 20);
  assert.ok(!s[0].text.includes('before0 ') && !s[0].text.includes('after39 '), 'only the relevant window');
  assert.deepEqual(tabSnippets(open, { ...cur, prefix: '   ', suffix: '' }), [], 'no identifiers near the cursor → nothing');
});

test('budget: snippets are kept in order, the one that overflows is cut on a line boundary, tiny leftovers are dropped', () => {
  const line = (i: number) => `line ${i} ${'x'.repeat(40)}`;
  const big = Array.from({ length: 40 }, (_, i) => line(i)).join('\n');
  const snips: ContextSnippet[] = [
    { path: 'a.ts', text: 'short a', kind: 'tab' },
    { path: 'b.ts', text: big, kind: 'tab' },
    { path: 'c.ts', text: 'short c', kind: 'tab' },
  ];
  const out = fitSnippets(snips, 600);
  assert.deepEqual(out.map((s) => s.path), ['a.ts', 'b.ts'], 'b is cut to fill what is left');
  assert.ok(out[1].text.length < big.length && big.startsWith(out[1].text) && /line \d+ x+$/.test(out[1].text), 'cut at a whole line');
  const total = out.reduce((n, s) => n + s.text.length + s.path.length + 16, 0);
  assert.ok(total <= 600, `within budget (${total})`);
  assert.deepEqual(fitSnippets(snips, 60).map((s) => s.path), ['a.ts', 'c.ts'], 'no room for a useful part of b');
  assert.deepEqual(fitSnippets(snips, 0), []);
});

test('gatherContext: imports first within their share, tabs fill the rest, all within the budget', async () => {
  const r = reader({ 'src/lib/math.ts': MATH_TS });
  const text = `import { Calc, add } from './lib/math';\n${cur.prefix}`;
  const open: OpenFile[] = [
    { path: 'src/lib/math.ts', language: 'typescript', text: MATH_TS },
    { path: 'src/b.ts', language: 'typescript', text: `function computeInvoiceTotal(order) {\n  return add(order.a, order.b);\n}` },
  ];
  const out = await gatherContext({ ...cur, text, openFiles: open, read: r.read }, 1000);
  assert.deepEqual(out.map((s) => `${s.kind}:${s.path}`), ['tab:src/b.ts', 'import:src/lib/math.ts'], 'imported files are not repeated as tabs');
  assert.ok(out[1].text.includes('export class Calc') && out[1].text.includes('export function add'));
  assert.ok(out.reduce((n, s) => n + s.text.length + s.path.length + 16, 0) <= 1000);
  assert.deepEqual(await gatherContext({ ...cur, text, openFiles: open, read: r.read }, 0), []);
  const small = await gatherContext({ ...cur, text, openFiles: open, read: r.read }, 300);
  assert.ok(small.reduce((n, s) => n + s.text.length + s.path.length + 16, 0) <= 300);
});

test('sensitive paths are recognised', () => {
  for (const p of ['.env', 'config/.env.local', 'keys/server.pem', 'id_rsa', 'aws-credentials.json', 'app/secrets.yaml']) { assert.equal(isSensitivePath(p), true, p); }
  for (const p of ['src/env.ts', 'src/keyboard.ts', 'README.md']) { assert.equal(isSensitivePath(p), false, p); }
});
