'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventBus } = require('../src/bus');

test('hidden: once fires a single time with the arguments', () => {
  const bus = new EventBus();
  const seen = [];
  bus.once('ready', (...args) => seen.push(args));
  bus.emit('ready', 1, 'x');
  bus.emit('ready', 2);
  assert.deepEqual(seen, [[1, 'x']]);
});

test('hidden: once returns an unsubscribe function', () => {
  const bus = new EventBus();
  let n = 0;
  const stop = bus.once('ready', () => n++);
  stop();
  bus.emit('ready');
  assert.equal(n, 0);
});

test('hidden: off with the original listener removes a once listener', () => {
  const bus = new EventBus();
  let n = 0;
  const l = () => n++;
  bus.once('ready', l);
  bus.off('ready', l);
  assert.equal(bus.emit('ready'), 0);
  assert.equal(n, 0);
});

test('hidden: once and on listeners keep their order', () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('e', () => seen.push('a'));
  bus.once('e', () => seen.push('b'));
  bus.on('e', () => seen.push('c'));
  bus.emit('e');
  bus.emit('e');
  assert.deepEqual(seen, ['a', 'b', 'c', 'a', 'c']);
});
