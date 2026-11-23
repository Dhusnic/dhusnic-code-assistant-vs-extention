'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rateLimited } = require('../src/middleware');

test('the middleware asks the limiter', () => {
  const fake = { allow: () => true, remaining: () => 4 };
  const h = rateLimited(fake, () => ({ status: 200 }));
  assert.deepEqual(h({ headers: {}, ip: '1.2.3.4' }), { status: 200, headers: { 'x-ratelimit-remaining': '4' } });
});
