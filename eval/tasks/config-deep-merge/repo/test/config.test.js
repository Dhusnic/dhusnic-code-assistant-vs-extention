'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

test('top-level values override the defaults', () => {
  assert.equal(loadConfig({ logLevel: 'debug' }).logLevel, 'debug');
  assert.equal(loadConfig({}).server.port, 8080);
});
