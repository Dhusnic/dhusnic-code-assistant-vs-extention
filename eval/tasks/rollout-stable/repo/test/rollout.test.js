'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isEnabled } = require('../src/flags/rollout');

test('unknown flags are off', () => {
  assert.equal(isEnabled('nope', 'u1'), false);
});
