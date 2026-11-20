'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

test('overrides win over defaults', () => {
  assert.equal(loadConfig({ retries: 5 }).retries, 5);
  assert.equal(loadConfig().baseUrl, 'http://localhost:8080');
});
