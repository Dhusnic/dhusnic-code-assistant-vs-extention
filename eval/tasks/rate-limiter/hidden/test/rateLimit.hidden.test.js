'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('../src/rateLimit');
const { rateLimited } = require('../src/middleware');

function clock() { let t = 1000; return { now: () => t, advance: (ms) => { t += ms; } }; }

test('hidden: allows up to the limit within the window', () => {
  const c = clock();
  const l = createLimiter({ limit: 3, windowMs: 1000, now: c.now });
  assert.deepEqual([l.allow('a'), l.allow('a'), l.allow('a'), l.allow('a')], [true, true, true, false]);
  assert.equal(l.remaining('a'), 0);
  assert.equal(l.allow('b'), true);
  assert.equal(l.remaining('b'), 2);
});

test('hidden: the window slides', () => {
  const c = clock();
  const l = createLimiter({ limit: 2, windowMs: 1000, now: c.now });
  l.allow('k');
  c.advance(600);
  l.allow('k');
  assert.equal(l.allow('k'), false);
  c.advance(399);
  assert.equal(l.allow('k'), false);
  c.advance(1);
  assert.equal(l.remaining('k'), 1);
  assert.equal(l.allow('k'), true);
  assert.equal(l.allow('k'), false);
});

test('hidden: rejected requests are not counted, reset forgets', () => {
  const c = clock();
  const l = createLimiter({ limit: 1, windowMs: 100, now: c.now });
  l.allow('k');
  for (let i = 0; i < 5; i++) { c.advance(10); l.allow('k'); }
  c.advance(50);
  assert.equal(l.allow('k'), true);
  l.reset('k');
  assert.equal(l.remaining('k'), 1);
  assert.equal(createLimiter({ limit: 5, windowMs: 10 }).remaining('new'), 5);
});

test('hidden: the middleware answers 429 over the limit', () => {
  const c = clock();
  const h = rateLimited(createLimiter({ limit: 1, windowMs: 1000, now: c.now }), () => ({ status: 200 }));
  assert.equal(h({ headers: { 'x-api-key': 'k1' } }).status, 200);
  assert.equal(h({ headers: { 'x-api-key': 'k1' } }).status, 429);
  assert.equal(h({ headers: {}, ip: '10.0.0.1' }).status, 200);
});
