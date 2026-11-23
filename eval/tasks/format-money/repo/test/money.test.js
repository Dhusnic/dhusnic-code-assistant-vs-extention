'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatMoney } = require('../src/money');

test('small amounts', () => {
  assert.equal(formatMoney(999), '$9.99');
});
