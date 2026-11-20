'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/cli');

test('hidden: --json works in either order with --all', () => {
  assert.equal(run(['list', '--all', '--json']), run(['list', '--json', '--all']));
  assert.equal(JSON.parse(run(['list', '--all', '--json'])).length, 3);
});

test('hidden: --json with custom items and an empty result', () => {
  const items = [{ name: 'kiwi', count: 0 }];
  assert.equal(run(['list', '--json'], items), '[]');
  assert.deepEqual(JSON.parse(run(['list', '--json', '--all'], items)), [{ name: 'kiwi', count: 0 }]);
});

test('hidden: plain output is unchanged', () => {
  assert.equal(run(['list'], [{ name: 'fig', count: 2 }]), 'fig 2');
});
