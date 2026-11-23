'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { articlePath } = require('../src/articles');

test('article paths', () => {
  assert.equal(articlePath({ year: 2024, title: 'Hello World' }), '/blog/2024/hello-world');
});
