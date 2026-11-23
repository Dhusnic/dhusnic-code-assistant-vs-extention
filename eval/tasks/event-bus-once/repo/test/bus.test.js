'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventBus } = require('../src/bus');

test('on/emit/off', () => {
  const bus = new EventBus();
  const seen = [];
  const stop = bus.on('save', (a, b) => seen.push(a + b));
  assert.equal(bus.emit('save', 1, 2), 1);
  stop();
  assert.equal(bus.emit('save', 1, 2), 0);
  assert.deepEqual(seen, [3]);
});
