'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { titleCase } = require('../src/text/strings');
const { productCard } = require('../src/product');
const { displayName } = require('../src/user');
const { summary } = require('../src/reports/summary');

test('hidden: behaviour is unchanged after the move', () => {
  assert.equal(titleCase('a b'), 'A B');
  assert.deepEqual(productCard({ name: 'green tea', description: 'short' }), { title: 'Green Tea', blurb: 'short' });
  assert.equal(displayName({ first: 'ada', last: 'lovelace' }), 'Ada Lovelace');
  assert.equal(summary([{ name: 'x', description: 'y' }]), 'X: y');
});
