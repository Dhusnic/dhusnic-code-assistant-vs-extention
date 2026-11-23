'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, loadConfig } = require('../src/config');

const snapshot = JSON.stringify(DEFAULTS);

test('hidden: nested objects merge key by key', () => {
  const c = loadConfig({ db: { host: 'db.internal' } });
  assert.deepEqual(c.db, { host: 'db.internal', port: 5432, pool: { min: 1, max: 10 } });
  assert.deepEqual(c.server, { host: '0.0.0.0', port: 8080 });
});

test('hidden: merging works at any depth', () => {
  const c = loadConfig({ db: { pool: { max: 50 } } });
  assert.deepEqual(c.db.pool, { min: 1, max: 50 });
  assert.equal(c.db.port, 5432);
});

test('hidden: arrays and plain values replace', () => {
  const c = loadConfig({ features: ['export'], server: { port: 9000 }, extra: { a: 1 } });
  assert.deepEqual(c.features, ['export']);
  assert.equal(c.server.port, 9000);
  assert.equal(c.server.host, '0.0.0.0');
  assert.deepEqual(c.extra, { a: 1 });
  assert.equal(loadConfig({ db: { pool: null } }).db.pool, null);
});

test('hidden: DEFAULTS are never modified', () => {
  loadConfig({ db: { host: 'x', pool: { min: 5 } }, features: [] });
  assert.equal(JSON.stringify(DEFAULTS), snapshot);
});
