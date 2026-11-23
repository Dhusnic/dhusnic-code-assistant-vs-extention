'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listTickets } = require('../src/api/tickets');
const { pageParams } = require('../src/api/pagination');
const { BATCH_SIZE, batches } = require('../src/cli/batch');
const { CHUNK_ROWS } = require('../src/export/chunks');
const settings = require('../src/settings');

const all = Array.from({ length: 300 }, (_, i) => ({ id: i }));

test('hidden: default page size is 25', () => {
  assert.equal(listTickets(all, {}).items.length, 25);
  assert.deepEqual(pageParams(), { limit: 25, offset: 0 });
  assert.equal(listTickets(all, { limit: '500' }).items.length, 100);
});

test('hidden: unrelated sizes are unchanged', () => {
  assert.equal(BATCH_SIZE, 20);
  assert.equal(batches(all).length, 15);
  assert.equal(CHUNK_ROWS, 20);
  assert.equal(settings.SESSION_TTL_MINUTES, 20);
});
