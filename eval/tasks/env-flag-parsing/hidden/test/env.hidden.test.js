'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { flag } = require('../src/env');
const { features } = require('../src/features');

test('hidden: false-like values are false', () => {
  for (const v of ['false', 'FALSE', '0', 'no', 'No', 'off', ' false ']) { assert.equal(flag('F', { F: v }, true), false, v); }
});

test('hidden: true-like values are true', () => {
  for (const v of ['true', 'True', '1', 'yes', 'ON', ' on ']) { assert.equal(flag('F', { F: v }), true, v); }
});

test('hidden: empty means fallback, junk throws with the name', () => {
  assert.equal(flag('F', { F: '' }, true), true);
  assert.equal(flag('F', { F: '   ' }, false), false);
  assert.throws(() => flag('FEATURE_BETA', { FEATURE_BETA: 'maybe' }), /FEATURE_BETA/);
});

test('hidden: features() uses the flags', () => {
  assert.deepEqual(features({ FEATURE_BETA: 'false', FEATURE_NEW_SEARCH: '0' }), { beta: false, newSearch: false, maxUploads: 4 });
});
