'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { resolveInside } = require('../src/files');

const root = path.join(os.tmpdir(), 'store');

test('paths inside the root resolve', () => {
  assert.equal(resolveInside(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
});

test('parent escapes are refused', () => {
  assert.throws(() => resolveInside(root, '../etc/passwd'), { code: 'EOUTSIDE' });
});
