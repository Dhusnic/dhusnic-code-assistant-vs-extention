'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { debounce } = require('../src/debounce');
const { fakeTimers } = require('./fakeTimers');

test('a burst runs once after the wait', () => {
  const t = fakeTimers();
  let calls = 0;
  const d = debounce(() => { calls++; }, 100, t);
  d(); d(); d();
  t.advance(99);
  assert.equal(calls, 0);
  t.advance(1);
  assert.equal(calls, 1);
});
