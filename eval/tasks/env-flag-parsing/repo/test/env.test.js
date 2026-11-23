'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { flag, int } = require('../src/env');

test('flag: true and fallback', () => {
  assert.equal(flag('X', { X: 'true' }), true);
  assert.equal(flag('X', {}, true), true);
});

test('int parses whole numbers', () => {
  assert.equal(int('N', { N: '12' }), 12);
  assert.throws(() => int('N', { N: '1.5' }), /N must be a whole number/);
});
