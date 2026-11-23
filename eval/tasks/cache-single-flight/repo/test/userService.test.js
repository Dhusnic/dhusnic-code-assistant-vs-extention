'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUserService } = require('../src/userService');

test('a user is loaded once and then cached', async () => {
  let calls = 0;
  const svc = createUserService({ findUser: async (id) => { calls++; return { id }; } });
  assert.deepEqual(await svc.getUser(1), { id: 1 });
  assert.deepEqual(await svc.getUser(1), { id: 1 });
  assert.equal(calls, 1);
});
