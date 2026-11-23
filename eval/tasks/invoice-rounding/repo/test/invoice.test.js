'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { invoiceTotals } = require('../src/invoice');

test('a simple invoice', () => {
  assert.deepEqual(invoiceTotals([{ price: 10, quantity: 2 }], 0.1), { subtotal: 20, tax: 2, total: 22 });
});
