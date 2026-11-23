'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compose } = require('../src/compose');

test('hidden: downstream errors reach upstream catch blocks', async () => {
  const ctx = {};
  await compose([
    async (c, next) => { try { await next(); } catch (e) { c.caught = e.message; } },
    () => { throw new Error('sync boom'); },
  ])(ctx);
  assert.equal(ctx.caught, 'sync boom');
  await assert.rejects(compose([async (c, next) => next(), async () => { throw new Error('async boom'); }])({}), /async boom/);
  await assert.rejects(compose([() => { throw new Error('first'); }])({}), /first/);
});

test('hidden: next() twice rejects', async () => {
  await assert.rejects(compose([async (c, next) => { await next(); await next(); }])({}), /next\(\) called multiple times/);
});

test('hidden: the outer next runs last, an empty chain resolves', async () => {
  const seen = [];
  await compose([async (c, next) => { seen.push('a'); await next(); seen.push('c'); }])({}, async () => { await new Promise((r) => setTimeout(r, 5)); seen.push('b'); });
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.equal(await compose([])({}), undefined);
});

test('hidden: next returns a promise even at the end of the chain', async () => {
  let returned;
  await compose([(c, next) => { returned = next(); return returned; }])({});
  assert.equal(typeof returned?.then, 'function');
});
