'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isEnabled } = require('../src/flags/rollout');
const { fnv1a } = require('../src/lib/hash');

test('hidden: decisions follow the hash and never use Math.random', () => {
  const real = Math.random;
  Math.random = () => { throw new Error('Math.random must not be used'); };
  try {
    for (let i = 0; i < 300; i++) {
      const user = `user-${i}`;
      assert.equal(isEnabled('newCheckout', user), fnv1a(`newCheckout:${user}`) % 100 < 30, user);
      assert.equal(isEnabled('darkMode', user), true);
      assert.equal(isEnabled('legacyCart', user), false);
    }
  } finally {
    Math.random = real;
  }
});

test('hidden: custom flag tables and stability', () => {
  const flags = { beta: { rollout: 50 } };
  const a = Array.from({ length: 50 }, (_, i) => isEnabled('beta', `u${i}`, flags));
  const b = Array.from({ length: 50 }, (_, i) => isEnabled('beta', `u${i}`, flags));
  assert.deepEqual(a, b);
  assert.ok(a.includes(true) && a.includes(false));
});
