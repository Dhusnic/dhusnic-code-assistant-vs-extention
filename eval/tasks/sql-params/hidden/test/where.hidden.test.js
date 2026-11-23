'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWhere } = require('../src/db/where');
const { findCustomers } = require('../src/repos/customers');
const { openOrdersFor, countOrders } = require('../src/repos/orders');

const recorder = (rows = []) => { const calls = []; return { calls, db: { query: async (sql, params) => { calls.push([sql, params]); return rows; } } }; };

test('hidden: placeholders and params', () => {
  assert.deepEqual(buildWhere({}), { sql: '', params: [] });
  assert.deepEqual(buildWhere({ name: "O'Brien" }), { sql: 'WHERE name = $1', params: ["O'Brien"] });
  assert.deepEqual(buildWhere({ status: 'open', id: [3, 4], deleted_at: null, age: 30 }),
    { sql: 'WHERE status = $1 AND id IN ($2, $3) AND deleted_at IS NULL AND age = $4', params: ['open', 3, 4, 30] });
  assert.deepEqual(buildWhere({ id: [] }), { sql: 'WHERE 1 = 0', params: [] });
});

test('hidden: column names are checked', () => {
  assert.throws(() => buildWhere({ 'name; DROP TABLE x': 1 }));
  assert.throws(() => buildWhere({ '1abc': 1 }));
  assert.deepEqual(buildWhere({ _a1: 1 }), { sql: 'WHERE _a1 = $1', params: [1] });
});

test('hidden: repositories pass the params', async () => {
  const c = recorder();
  await findCustomers(c.db, { name: "O'Brien" });
  assert.deepEqual(c.calls, [['SELECT * FROM customers WHERE name = $1', ["O'Brien"]]]);

  const o = recorder();
  await openOrdersFor(o.db, [5, 6]);
  assert.deepEqual(o.calls, [['SELECT id, total FROM orders WHERE status = $1 AND customer_id IN ($2, $3) ORDER BY id', ['open', 5, 6]]]);

  const n = recorder([{ n: 2 }]);
  assert.equal(await countOrders(n.db, { status: 'paid' }), 2);
  assert.deepEqual(n.calls, [['SELECT COUNT(*) AS n FROM orders WHERE status = $1', ['paid']]]);

  const all = recorder([{ n: 9 }]);
  assert.equal(await countOrders(all.db, {}), 9);
  assert.deepEqual(all.calls, [['SELECT COUNT(*) AS n FROM orders', []]]);
});
