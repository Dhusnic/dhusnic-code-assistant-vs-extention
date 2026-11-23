'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { addMonths } = require('../src/dates');

test('mid-month dates move by whole months', () => {
  assert.deepEqual(addMonths(new Date(2024, 0, 15, 9, 0), 1), new Date(2024, 1, 15, 9, 0));
  assert.deepEqual(addMonths(new Date(2024, 10, 10), 3), new Date(2025, 1, 10));
});
