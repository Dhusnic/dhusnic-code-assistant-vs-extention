'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { uploadPath } = require('../src/storage/uploads');

test('upload paths are per tenant', () => {
  assert.match(uploadPath('t1', 'f1'), /\/t1\/f1$/);
});
