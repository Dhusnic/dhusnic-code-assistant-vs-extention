'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { uniqueBy, chunk } = require('../src/utils/array');
const { mergeContacts } = require('../src/contacts');

test('hidden: uniqueBy keeps the first of each key, in order', () => {
  assert.deepEqual(uniqueBy([3, 1, 3, 2, 1], (x) => x), [3, 1, 2]);
  assert.deepEqual(uniqueBy([{ k: 'a', v: 1 }, { k: 'b', v: 2 }, { k: 'a', v: 3 }], (o) => o.k), [{ k: 'a', v: 1 }, { k: 'b', v: 2 }]);
  assert.deepEqual(uniqueBy([], (x) => x), []);
  assert.deepEqual(chunk([1], 5), [[1]]);
});

test('hidden: contacts are merged by normalized email', () => {
  const phone = [{ name: 'Ann', email: 'Ann@Example.com ' }, { name: 'Raj' }];
  const crm = [{ name: 'Ann Lee', email: 'ann@example.com' }, { name: 'Bo', email: 'bo@x.io' }, { name: 'Raj K' }];
  assert.deepEqual(mergeContacts(phone, crm), [
    { name: 'Ann', email: 'Ann@Example.com ' }, { name: 'Raj' }, { name: 'Bo', email: 'bo@x.io' }, { name: 'Raj K' },
  ]);
});
