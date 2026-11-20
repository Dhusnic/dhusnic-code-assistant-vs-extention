'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDate, formatDuration } = require('../src/format');

test('hidden: dates are YYYY-MM-DD, zero-padded, local time', () => {
  assert.equal(formatDate(new Date(2024, 2, 5)), '2024-03-05');
  assert.equal(formatDate(new Date(2023, 11, 31, 23, 59)), '2023-12-31');
  assert.equal(formatDate(new Date(2024, 0, 1, 0, 0)), '2024-01-01');
  assert.equal(formatDate(new Date(2024, 9, 10)), '2024-10-10');
});

test('hidden: durations still work', () => {
  assert.equal(formatDuration(59), '0:59');
});
