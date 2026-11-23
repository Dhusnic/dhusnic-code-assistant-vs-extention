'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handle } = require('../src/app');

test('authors can delete their comments', () => {
  const db = { comments: [{ id: 'c1', authorId: 'u1' }], projects: [] };
  assert.equal(handle({ method: 'DELETE', url: '/comments/c1', user: { id: 'u1' } }, db).status, 204);
});

test('anonymous users must sign in', () => {
  const db = { comments: [{ id: 'c1', authorId: 'u1' }], projects: [] };
  assert.equal(handle({ method: 'DELETE', url: '/comments/c1' }, db).status, 401);
});
