'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LruCache } = require('../src/lru');

test('keeps at most capacity entries', () => {
  const c = new LruCache(2);
  c.set('a', 1).set('b', 2).set('c', 3);
  assert.equal(c.size, 2);
  assert.equal(c.has('a'), false);
});
