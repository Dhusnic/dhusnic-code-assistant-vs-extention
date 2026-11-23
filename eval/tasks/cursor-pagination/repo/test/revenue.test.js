'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { totalRevenue } = require('../src/reports/revenue');
const { orders } = require('../src/db/store');

test('revenue covers every order', () => {
  assert.equal(totalRevenue(), orders.reduce((n, o) => n + o.cents, 0));
});
