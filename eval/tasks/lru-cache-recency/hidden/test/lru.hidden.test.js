'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LruCache } = require('../src/lru');
const { cachedPrices } = require('../src/prices');

test('hidden: get refreshes recency', () => {
  const c = new LruCache(2);
  c.set('a', 1).set('b', 2);
  assert.equal(c.get('a'), 1);
  c.set('c', 3);
  assert.equal(c.has('a'), true);
  assert.equal(c.has('b'), false);
});

test('hidden: updating a key refreshes it and keeps the size', () => {
  const c = new LruCache(2);
  c.set('a', 1).set('b', 2).set('a', 10).set('c', 3);
  assert.equal(c.size, 2);
  assert.equal(c.get('a'), 10);
  assert.equal(c.has('b'), false);
});

test('hidden: has does not refresh, missing get returns undefined', () => {
  const c = new LruCache(2);
  c.set('a', 1).set('b', 2);
  c.has('a');
  c.set('c', 3);
  assert.equal(c.has('a'), false);
  assert.equal(c.get('zzz'), undefined);
  assert.equal(c.size, 2);
});

test('hidden: hot prices stay cached', () => {
  let lookups = 0;
  const price = cachedPrices((sku) => { lookups++; return sku.length; }, 2);
  price('aa'); price('bbb'); price('aa'); price('c'); price('aa');
  assert.equal(lookups, 3);
});
