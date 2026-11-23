'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { signup } = require('../src/handlers/signup');
const { invite } = require('../src/handlers/invite');

test('signup normalizes the email', () => {
  const users = new Map();
  assert.deepEqual(signup({ email: ' Ann@Example.COM ', password: 'longenough' }, users), { status: 201, body: { email: 'ann@example.com' } });
});

test('invite rejects bad addresses', () => {
  assert.deepEqual(invite({ emails: ['a@b.co', 'nope', 'A@B.co'] }).body, { invited: ['a@b.co'], rejected: ['nope'] });
});
