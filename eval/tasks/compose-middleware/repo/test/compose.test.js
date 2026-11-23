'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compose } = require('../src/compose');

const tick = () => new Promise((r) => setTimeout(r, 5));

test('runs async middleware in onion order and waits for all of it', async () => {
  const seen = [];
  await compose([
    async (ctx, next) => { seen.push(1); await next(); seen.push(6); },
    async (ctx, next) => { seen.push(2); await tick(); seen.push(3); await next(); seen.push(5); },
    async () => { await tick(); seen.push(4); },
  ])({});
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
});

test('the pipeline waits for the upstream answer', async () => {
  const { pipeline } = require('../src/pipeline');
  const ctx = { path: '/x', headers: { authorization: 'Bearer t' } };
  await pipeline(async () => { await tick(); return { status: 200, body: 'ok' }; })(ctx);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body, 'ok');
  assert.equal(typeof ctx.timeMs, 'number');
});
