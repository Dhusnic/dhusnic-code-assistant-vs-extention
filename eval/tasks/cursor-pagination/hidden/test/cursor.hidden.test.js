'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listOrders } = require('../src/db/orders');
const { orders, seed, insert } = require('../src/db/store');
const { totalRevenue } = require('../src/reports/revenue');
const { exportCustomer } = require('../src/export/csv');

test('hidden: cursor pages', () => {
  seed(120);
  const p1 = listOrders({});
  assert.equal(p1.items.length, 50);
  assert.equal(p1.items[0].id, 1);
  assert.equal(p1.nextCursor, 50);
  const p3 = listOrders({ after: 100, limit: 50 });
  assert.deepEqual(p3.items.map((o) => o.id), Array.from({ length: 20 }, (_, i) => 101 + i));
  assert.equal(p3.nextCursor, null);
  assert.deepEqual(listOrders({ after: 120 }), { items: [], nextCursor: null });
  assert.equal(listOrders({ after: 110, limit: 10 }).nextCursor, null);
  assert.equal(listOrders({ after: 109, limit: 10 }).nextCursor, 119);
});

test('hidden: no order is skipped when a new one arrives between pages', () => {
  seed(10);
  const p1 = listOrders({ limit: 4 });
  insert({ id: 11, customer: 'c0', cents: 1 });
  orders.splice(0, 1);
  const p2 = listOrders({ after: p1.nextCursor, limit: 100 });
  assert.deepEqual(p2.items.map((o) => o.id), [5, 6, 7, 8, 9, 10, 11]);
});

test('hidden: callers read everything', () => {
  seed(120);
  const all = orders.reduce((n, o) => n + o.cents, 0);
  assert.equal(totalRevenue(), all);
  assert.equal(totalRevenue(7), all);
  const csv = exportCustomer('c3').split('\n');
  assert.equal(csv[0], 'id,cents');
  assert.deepEqual(csv.slice(1).map((l) => Number(l.split(',')[0])), orders.filter((o) => o.customer === 'c3').map((o) => o.id));
});
