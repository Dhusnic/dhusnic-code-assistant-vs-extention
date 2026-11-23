'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateOrderTotal } = require('../src/total');
const { checkout } = require('../src/order');
const { report } = require('../src/report');

const lines = [{ price: 2.5, quantity: 4 }, { price: 1.25, quantity: 2 }];

test('calculateOrderTotal sums lines and applies the discount', () => {
  assert.equal(calculateOrderTotal(lines), 12.5);
  assert.equal(calculateOrderTotal(lines, 0.1), 11.25);
  assert.equal(calculateOrderTotal([]), 0);
});

test('checkout marks free orders', () => {
  assert.deepEqual(checkout({ id: 'a', lines }), { id: 'a', total: 12.5, status: 'due' });
  assert.equal(checkout({ id: 'b', lines: [] }).status, 'free');
});

test('report prints one line per order', () => {
  assert.equal(report([{ id: 'a', lines }, { id: 'b', lines, discount: 0.5 }]), 'a: 12.50\nb: 6.25');
});
