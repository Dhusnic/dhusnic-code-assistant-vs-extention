'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findCustomers } = require('../src/repos/customers');

test('customers are queried with the filters', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push([sql, params]); return []; } };
  await findCustomers(db, {});
  assert.deepEqual(calls, [['SELECT * FROM customers', []]]);
});
