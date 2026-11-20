'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { paginate, pageCount } = require('../src/paginate');

const items = Array.from({ length: 10 }, (_, i) => i + 1);

test('the first page starts at the first item', () => {
  assert.deepEqual(paginate(items, 1, 3), [1, 2, 3]);
});

test('the last page holds the remainder', () => {
  assert.deepEqual(paginate(items, 4, 3), [10]);
});

test('the page count rounds up', () => {
  assert.equal(pageCount(10, 3), 4);
  assert.equal(pageCount(9, 3), 3);
  assert.equal(pageCount(0, 3), 0);
});
