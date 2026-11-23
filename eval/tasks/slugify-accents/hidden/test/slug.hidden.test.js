'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { slugify } = require('../src/text/slug');
const { articlePath } = require('../src/articles');

test('hidden: accents become plain letters', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
  assert.equal(slugify('São Paulo à la carte'), 'sao-paulo-a-la-carte');
  assert.equal(articlePath({ year: 2023, title: 'Naïve Café' }), '/blog/2023/naive-cafe');
});

test('hidden: separators collapse and are trimmed', () => {
  assert.equal(slugify('  Hello,   World!!  '), 'hello-world');
  assert.equal(slugify('--a--b--'), 'a-b');
  assert.equal(slugify('Top 10 Tips (2024)'), 'top-10-tips-2024');
});
