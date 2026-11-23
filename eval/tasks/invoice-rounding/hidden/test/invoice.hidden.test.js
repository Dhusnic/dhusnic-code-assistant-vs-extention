'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { invoiceTotals } = require('../src/invoice');

test('hidden: each line is rounded half away from zero', () => {
  assert.deepEqual(invoiceTotals([{ price: 1.005, quantity: 1 }], 0), { subtotal: 1.01, tax: 0, total: 1.01 });
  assert.deepEqual(invoiceTotals([{ price: 0.125, quantity: 1 }, { price: 0.125, quantity: 1 }], 0), { subtotal: 0.26, tax: 0, total: 0.26 });
  assert.deepEqual(invoiceTotals([{ price: 10, quantity: 1 }, { price: -2.345, quantity: 1 }], 0), { subtotal: 7.65, tax: 0, total: 7.65 });
});

test('hidden: tax is rounded on the subtotal', () => {
  assert.deepEqual(invoiceTotals([{ price: 19.99, quantity: 1 }], 0.075), { subtotal: 19.99, tax: 1.5, total: 21.49 });
  assert.deepEqual(invoiceTotals([{ price: 0.1, quantity: 3 }, { price: 0.2, quantity: 1 }], 0.2), { subtotal: 0.5, tax: 0.1, total: 0.6 });
});

test('hidden: empty invoice', () => {
  assert.deepEqual(invoiceTotals([], 0.2), { subtotal: 0, tax: 0, total: 0 });
});
