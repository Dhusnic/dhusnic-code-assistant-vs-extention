'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chargeCard } = require('../src/payments/gateway');

test('chargeCard needs a token', async () => {
  await assert.rejects(chargeCard({}, 100), /token missing/);
});
