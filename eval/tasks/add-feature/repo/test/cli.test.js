'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/cli');

test('list prints items in stock', () => {
  assert.equal(run(['list']), 'apple 3\nbanana 5');
});

test('list --all includes empty items', () => {
  assert.equal(run(['list', '--all']), 'apple 3\nbanana 5\ncherry 0');
});

test('list --json prints a pretty JSON array', () => {
  const expected = [{ name: 'apple', count: 3 }, { name: 'banana', count: 5 }];
  assert.equal(run(['list', '--json']), JSON.stringify(expected, null, 2));
});

test('list --json --all includes empty items', () => {
  assert.deepEqual(JSON.parse(run(['list', '--json', '--all'])).map((i) => i.name), ['apple', 'banana', 'cherry']);
});

test('unknown commands are reported', () => {
  assert.equal(run(['sell']), 'Unknown command: sell');
});
