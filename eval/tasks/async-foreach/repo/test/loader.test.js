'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAll } = require('../src/loader');

const delay = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

test('loads every id', async () => {
  assert.deepEqual(await loadAll([1, 2, 3], (id) => delay(5, { id })), [{ id: 1 }, { id: 2 }, { id: 3 }]);
});
