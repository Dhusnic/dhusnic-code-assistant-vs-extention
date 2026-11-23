'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { debounce } = require('../src/debounce');
const { fakeTimers } = require('./fakeTimers');

test('hidden: the last arguments and this are used', () => {
  const t = fakeTimers();
  const seen = [];
  const obj = { name: 'box', d: null };
  obj.d = debounce(function (q) { seen.push([this && this.name, q]); }, 50, t);
  obj.d('a'); obj.d('ab'); obj.d('abc');
  t.advance(50);
  assert.deepEqual(seen, [['box', 'abc']]);
});

test('hidden: cancel drops the pending call', () => {
  const t = fakeTimers();
  let calls = 0;
  const d = debounce(() => { calls++; }, 50, t);
  d(); d.cancel();
  t.advance(100);
  assert.equal(calls, 0);
  assert.equal(t.pending(), 0);
});

test('hidden: flush runs the pending call now and returns its result', () => {
  const t = fakeTimers();
  let calls = 0;
  const d = debounce((x) => { calls++; return x * 2; }, 50, t);
  assert.equal(d.flush(), undefined);
  assert.equal(calls, 0);
  d(1); d(21);
  assert.equal(d.flush(), 42);
  assert.equal(calls, 1);
  t.advance(100);
  assert.equal(calls, 1, 'not called again after flush');
});

test('hidden: separate bursts each run', () => {
  const t = fakeTimers();
  const seen = [];
  const d = debounce((x) => seen.push(x), 10, t);
  d(1); t.advance(10); d(2); d(3); t.advance(10);
  assert.deepEqual(seen, [1, 3]);
});
