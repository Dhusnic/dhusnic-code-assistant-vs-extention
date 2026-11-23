'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEmail, isValidEmail } = require('../src/validation/email');
const { signup } = require('../src/handlers/signup');
const { invite } = require('../src/handlers/invite');
const { updateProfile } = require('../src/handlers/profile');

test('hidden: the shared module', () => {
  assert.equal(normalizeEmail('  Bob@Example.ORG '), 'bob@example.org');
  assert.equal(isValidEmail('bob@example.org'), true);
  for (const bad of ['', 'bob', 'bob@', '@x.io', 'a b@c.io', 'a@b']) { assert.equal(isValidEmail(bad), false, bad); }
});

test('hidden: handlers behave as before', () => {
  const users = new Map([['ann@x.io', {}]]);
  assert.equal(signup({ email: 'ANN@x.io', password: 'longenough' }, users).status, 409);
  assert.equal(signup({ email: 'bad', password: 'longenough' }, users).status, 400);
  assert.deepEqual(invite({ emails: [' C@D.io', 'x@'] }).body, { invited: ['c@d.io'], rejected: ['x@'] });
  assert.deepEqual(updateProfile({ email: 'a@b.io' }, { email: ' New@B.io ', name: ' Ann ' }), { status: 200, body: { email: 'new@b.io', name: 'Ann' } });
  assert.equal(updateProfile({}, { email: 'nope' }).status, 400);
});
