'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, loadConfig } = require('../src/config');

test('hidden: the new defaults', () => {
  assert.equal(DEFAULTS.timeoutMs, 5000);
  assert.equal(DEFAULTS.verbose, false);
  assert.equal(DEFAULTS.retries, 3);
  assert.equal(DEFAULTS.baseUrl, 'http://localhost:8080');
});

test('hidden: overrides still win', () => {
  assert.equal(loadConfig({ verbose: true }).verbose, true);
});
