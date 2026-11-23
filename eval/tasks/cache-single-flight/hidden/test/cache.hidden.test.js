'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TtlCache } = require('../src/cache');
const { createUserService } = require('../src/userService');

const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

test('hidden: concurrent calls share one load', async () => {
  const d = deferred();
  let calls = 0;
  const cache = new TtlCache({ ttlMs: 1000 });
  const all = Promise.all([1, 2, 3].map(() => cache.getOrLoad('k', () => { calls++; return d.p; })));
  d.resolve('v');
  assert.deepEqual(await all, ['v', 'v', 'v']);
  assert.equal(calls, 1);
});

test('hidden: a rejected load is shared and not cached', async () => {
  const d = deferred();
  let calls = 0;
  const cache = new TtlCache({ ttlMs: 1000 });
  const a = cache.getOrLoad('k', () => { calls++; return d.p; });
  const b = cache.getOrLoad('k', () => { calls++; return d.p; });
  d.reject(new Error('db down'));
  await assert.rejects(a, /db down/);
  await assert.rejects(b, /db down/);
  assert.equal(calls, 1);
  assert.equal(await cache.getOrLoad('k', async () => { calls++; return 'ok'; }), 'ok');
  assert.equal(calls, 2);
});

test('hidden: values expire after ttlMs', async () => {
  let t = 0;
  let calls = 0;
  const cache = new TtlCache({ ttlMs: 100, now: () => t });
  await cache.getOrLoad('k', async () => { calls++; return 'a'; });
  t = 99;
  assert.equal(await cache.getOrLoad('k', async () => { calls++; return 'b'; }), 'a');
  t = 100;
  assert.equal(await cache.getOrLoad('k', async () => { calls++; return 'c'; }), 'c');
  assert.equal(calls, 2);
});

test('hidden: the user service loads concurrently requested users once', async () => {
  let calls = 0;
  const svc = createUserService({ findUser: async (id) => { calls++; await new Promise((r) => setTimeout(r, 5)); return { id }; } });
  const users = await Promise.all([svc.getUser(7), svc.getUser(7), svc.getUser(8)]);
  assert.deepEqual(users, [{ id: 7 }, { id: 7 }, { id: 8 }]);
  assert.equal(calls, 2);
});
