'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { countActiveUsers } = require('../src/reports/activeUsers');

test('countActiveUsers counts what the server returns', async () => {
  const client = { get: async () => ({ items: [{ id: 1 }, { id: 2 }], total: 2 }) };
  assert.equal(await countActiveUsers(client), 2);
});
