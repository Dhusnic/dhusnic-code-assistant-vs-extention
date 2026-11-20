'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { paginate, pageCount } = require('../src/paginate');

const items = Array.from({ length: 10 }, (_, i) => i + 1);

test('hidden: middle pages and pages past the end', () => {
  assert.deepEqual(paginate(items, 2, 3), [4, 5, 6]);
  assert.deepEqual(paginate(items, 5, 3), []);
  assert.deepEqual(paginate(items, 1, 20), items);
});

test('hidden: page count for exact and partial pages', () => {
  assert.equal(pageCount(1, 5), 1);
  assert.equal(pageCount(5, 5), 1);
  assert.equal(pageCount(6, 5), 2);
});
