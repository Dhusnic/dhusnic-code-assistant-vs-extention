'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAll } = require('../src/loader');

const delay = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

test('hidden: order follows the ids, not completion', async () => {
  assert.deepEqual(await loadAll([1, 2, 3], (id) => delay(40 - id * 10, id)), [1, 2, 3]);
});

test('hidden: fetches run concurrently', async () => {
  let running = 0, peak = 0;
  await loadAll([1, 2, 3, 4], async (id) => { running++; peak = Math.max(peak, running); await delay(10); running--; return id; });
  assert.equal(peak, 4);
});

test('hidden: a failure rejects', async () => {
  await assert.rejects(loadAll([1, 2], async (id) => { if (id === 2) { throw new Error('no 2'); } return id; }), /no 2/);
  assert.deepEqual(await loadAll([], async () => 1), []);
});
