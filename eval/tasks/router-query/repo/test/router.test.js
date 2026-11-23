'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('../src/router');

test('matches params and trailing slashes', () => {
  const r = new Router().add('GET', '/users/:id', (req) => ({ status: 200, body: req.params }));
  assert.deepEqual(r.handle({ method: 'GET', url: '/users/7/' }), { status: 200, body: { id: '7' } });
  assert.deepEqual(r.handle({ method: 'POST', url: '/users/7' }), { status: 404 });
});
