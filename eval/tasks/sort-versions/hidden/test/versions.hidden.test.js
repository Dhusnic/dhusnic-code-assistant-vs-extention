'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sortVersions, latest } = require('../src/versions');

test('hidden: numeric ordering', () => {
  assert.deepEqual(sortVersions(['1.10.0', '1.9.0', '1.2.10', '1.2.9', '10.0.0', '2.0.0']), ['1.2.9', '1.2.10', '1.9.0', '1.10.0', '2.0.0', '10.0.0']);
  assert.deepEqual(sortVersions(['v1.10.0', 'v1.9.0']), ['v1.9.0', 'v1.10.0']);
});

test('hidden: pre-releases', () => {
  assert.deepEqual(sortVersions(['2.0.0', '2.0.0-rc.1', '2.0.0-beta.10', '2.0.0-beta.2', '1.9.9']), ['1.9.9', '2.0.0-beta.2', '2.0.0-beta.10', '2.0.0-rc.1', '2.0.0']);
});

test('hidden: latest prefers final releases', () => {
  assert.equal(latest(['1.9.0', '1.10.0']), '1.10.0');
  assert.equal(latest(['1.0.0', '2.0.0-rc.1']), '1.0.0');
  assert.equal(latest(['2.0.0-rc.1', '2.0.0-rc.2']), '2.0.0-rc.2');
});

test('hidden: the input is not reordered', () => {
  const list = ['1.10.0', '1.9.0'];
  sortVersions(list);
  assert.deepEqual(list, ['1.10.0', '1.9.0']);
});
