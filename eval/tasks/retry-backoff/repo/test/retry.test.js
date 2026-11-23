'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { retry } = require('../src/retry');

function failing(times) {
  const calls = [];
  return { calls, fn: async (n) => { calls.push(n); if (calls.length <= times) { throw new Error(`fail ${calls.length}`); } return 'ok'; } };
}

test('succeeds on the third attempt', async () => {
  const f = failing(2);
  const waits = [];
  assert.equal(await retry(f.fn, { attempts: 3, baseDelayMs: 100, sleep: async (ms) => { waits.push(ms); } }), 'ok');
  assert.deepEqual(f.calls, [1, 2, 3]);
  assert.deepEqual(waits, [100, 200]);
});

test('gives up after all attempts with the last error', async () => {
  const f = failing(10);
  const waits = [];
  await assert.rejects(retry(f.fn, { attempts: 3, baseDelayMs: 100, sleep: async (ms) => { waits.push(ms); } }), /fail 3/);
  assert.deepEqual(waits, [100, 200]);
});
