'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatMoney } = require('../src/money');

test('hidden: separators and negatives', () => {
  assert.equal(formatMoney(123450), '$1,234.50');
  assert.equal(formatMoney(-123450), '-$1,234.50');
  assert.equal(formatMoney(123456789), '$1,234,567.89');
  assert.equal(formatMoney(5), '$0.05');
  assert.equal(formatMoney(-5), '-$0.05');
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(formatMoney(100000), '$1,000.00');
});

test('hidden: currencies', () => {
  assert.equal(formatMoney(250000, 'EUR'), '€2,500.00');
  assert.equal(formatMoney(-99, 'GBP'), '-£0.99');
  assert.equal(formatMoney(1050, 'INR'), '₹10.50');
  assert.throws(() => formatMoney(1, 'XYZ'), /XYZ/);
});
