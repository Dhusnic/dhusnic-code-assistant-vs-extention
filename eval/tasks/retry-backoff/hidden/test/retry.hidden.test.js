'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { retry } = require('../src/retry');

test('hidden: one attempt never sleeps', async () => {
  const waits = [];
  await assert.rejects(retry(async () => { throw new Error('nope'); }, { attempts: 1, sleep: async (ms) => { waits.push(ms); } }), /nope/);
  assert.deepEqual(waits, []);
});

test('hidden: backoff doubles', async () => {
  const waits = [];
  let n = 0;
  await assert.rejects(retry(async () => { n++; throw new Error(`e${n}`); }, { attempts: 4, baseDelayMs: 10, sleep: async (ms) => { waits.push(ms); } }), /e4/);
  assert.deepEqual(waits, [10, 20, 40]);
});

test('hidden: first success returns at once', async () => {
  const waits = [];
  assert.equal(await retry(async (i) => i * 7, { sleep: async (ms) => { waits.push(ms); } }), 7);
  assert.deepEqual(waits, []);
});
