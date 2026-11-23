'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { addMonths } = require('../src/dates');
const { upcomingBillingDates } = require('../src/billing');

test('hidden: month ends clamp', () => {
  assert.deepEqual(addMonths(new Date(2024, 0, 31, 10, 30), 1), new Date(2024, 1, 29, 10, 30));
  assert.deepEqual(addMonths(new Date(2023, 0, 31), 1), new Date(2023, 1, 28));
  assert.deepEqual(addMonths(new Date(2024, 2, 31), 1), new Date(2024, 3, 30));
  assert.deepEqual(addMonths(new Date(2024, 7, 31), 6), new Date(2025, 1, 28));
});

test('hidden: negative months and years', () => {
  assert.deepEqual(addMonths(new Date(2024, 2, 31), -1), new Date(2024, 1, 29));
  assert.deepEqual(addMonths(new Date(2024, 0, 15), -13), new Date(2022, 11, 15));
  assert.deepEqual(addMonths(new Date(2024, 4, 31), 0), new Date(2024, 4, 31));
});

test('hidden: the input is not modified', () => {
  const d = new Date(2024, 0, 31);
  addMonths(d, 1);
  assert.deepEqual(d, new Date(2024, 0, 31));
});

test('hidden: billing on the 31st', () => {
  assert.deepEqual(upcomingBillingDates(new Date(2024, 0, 31), 3), [new Date(2024, 1, 29), new Date(2024, 2, 31), new Date(2024, 3, 30)]);
});
