'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchUsers } = require('../src/api/users');
const { listAllUsers } = require('../src/admin/listAll');
const { countActiveUsers } = require('../src/reports/activeUsers');
const { exportAdmins } = require('../src/export/admins');

function fakeClient(pages) {
  const calls = [];
  return {
    calls,
    get: async (p, query) => {
      calls.push({ path: p, query: { ...query } });
      const items = typeof pages === 'function' ? pages(query) : pages[(query.page ?? 1) - 1] ?? [];
      return { items, total: items.length };
    },
  };
}

test('hidden: fetchUsers takes an options object with defaults', async () => {
  const c = fakeClient([[{ id: 1 }]]);
  assert.deepEqual(await fetchUsers(c), [{ id: 1 }]);
  assert.deepEqual(c.calls[0], { path: '/users', query: { page: 1, pageSize: 50, active: true } });
  await fetchUsers(c, { page: 3, pageSize: 10, includeInactive: true, role: 'auditor' });
  assert.deepEqual(c.calls[1].query, { page: 3, pageSize: 10, role: 'auditor' });
});

test('hidden: listAllUsers pages through everyone, inactive included', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  const c = fakeClient([full, [{ id: 100 }]]);
  assert.equal((await listAllUsers(c)).length, 101);
  assert.deepEqual(c.calls.map((x) => x.query), [{ page: 1, pageSize: 100 }, { page: 2, pageSize: 100 }]);
});

test('hidden: countActiveUsers asks for active users only', async () => {
  const c = fakeClient([[{ id: 1 }, { id: 2 }, { id: 3 }]]);
  assert.equal(await countActiveUsers(c), 3);
  assert.deepEqual(c.calls[0].query, { page: 1, pageSize: 1000, active: true });
});

test('hidden: exportAdmins lets the server filter by role', async () => {
  const c = fakeClient((q) => (q.role === 'admin' ? [{ id: 7, name: 'Ann', role: 'admin' }, { id: 9, name: 'Raj', role: 'admin' }] : [{ id: 1, name: 'Bob', role: 'user' }]));
  assert.equal(await exportAdmins(c), '7,Ann\n9,Raj');
  assert.deepEqual(c.calls[0].query, { page: 1, pageSize: 500, active: true, role: 'admin' });
});
