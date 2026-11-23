'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('../src/router');
const { createApp } = require('../src/app');

const echo = () => new Router().add('GET', '/users/:id', (req) => ({ status: 200, body: { params: req.params, query: req.query } }))
  .add('GET', '/search', (req) => ({ status: 200, body: { query: req.query } }));

test('hidden: the query string does not affect matching and is parsed', () => {
  assert.deepEqual(echo().handle({ method: 'GET', url: '/users/7?tab=posts&page=2' }), { status: 200, body: { params: { id: '7' }, query: { tab: 'posts', page: '2' } } });
  assert.deepEqual(echo().handle({ method: 'GET', url: '/search' }).body.query, {});
});

test('hidden: repeated keys and decoding', () => {
  assert.deepEqual(echo().handle({ method: 'GET', url: '/search?tag=a&tag=b&q=hello+world&x=%26&tag=c' }).body.query, { tag: ['a', 'b', 'c'], q: 'hello world', x: '&' });
});

test('hidden: params are decoded, malformed escapes answer 400', () => {
  assert.deepEqual(echo().handle({ method: 'GET', url: '/users/ann%20lee' }).body.params, { id: 'ann lee' });
  assert.deepEqual(echo().handle({ method: 'GET', url: '/users/%E0%A4%A' }), { status: 400 });
});

test('hidden: the app filters by role', () => {
  const app = createApp([{ id: '1', role: 'admin' }, { id: '2', role: 'user' }]);
  assert.deepEqual(app.handle({ method: 'GET', url: '/users?role=admin' }).body, [{ id: '1', role: 'admin' }]);
  assert.equal(app.handle({ method: 'GET', url: '/users/2?x=1' }).status, 200);
});
