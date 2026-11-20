'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDuration } = require('../src/format');

test('durations are m:ss', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(600), '10:00');
});
