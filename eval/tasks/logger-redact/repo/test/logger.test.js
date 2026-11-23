'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../src/logger');

test('one JSON line per call', () => {
  const lines = [];
  const log = createLogger({ write: (l) => lines.push(l), clock: () => 'T' });
  log.warn('disk low', { freeMb: 12 });
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ time: 'T', level: 'warn', msg: 'disk low', freeMb: 12 }]);
});
