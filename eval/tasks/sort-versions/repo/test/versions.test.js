'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sortVersions, latest } = require('../src/versions');

test('simple ordering', () => {
  assert.deepEqual(sortVersions(['1.2.0', '1.0.0', '1.1.0']), ['1.0.0', '1.1.0', '1.2.0']);
  assert.equal(latest(['0.1.0', '0.3.0', '0.2.0']), '0.3.0');
});
