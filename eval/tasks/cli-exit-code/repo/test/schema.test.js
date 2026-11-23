'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('../src/schema');

test('valid and invalid configs', () => {
  assert.deepEqual(validate({ service: 'api', replicas: 2 }), []);
  assert.deepEqual(validate({ replicas: 0 }), ['service: required string', 'replicas: whole number >= 1']);
});
