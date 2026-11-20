'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const total = require('../src/total');
const { checkout } = require('../src/order');
const { report } = require('../src/report');

test('hidden: the function is exported under its new name only', () => {
  assert.equal(typeof total.calculateOrderTotal, 'function');
  assert.equal(Object.keys(total).length, 1);
});

test('hidden: behaviour is unchanged', () => {
  const lines = [{ price: 3, quantity: 3 }];
  assert.equal(total.calculateOrderTotal(lines, 0.25), 6.75);
  assert.equal(checkout({ id: 'x', lines }).total, 9);
  assert.equal(report([{ id: 'x', lines }]), 'x: 9.00');
});
