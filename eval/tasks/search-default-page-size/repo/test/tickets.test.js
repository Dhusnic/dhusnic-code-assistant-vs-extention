'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listTickets } = require('../src/api/tickets');

const all = Array.from({ length: 300 }, (_, i) => ({ id: i }));

test('explicit limit and offset', () => {
  assert.deepEqual(listTickets(all, { limit: '2', offset: '5' }).items, [{ id: 5 }, { id: 6 }]);
});

test('limit is capped at 100', () => {
  assert.equal(listTickets(all, { limit: '500' }).items.length, 100);
});
