'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { route } = require('../src/http/routes');

const MIB = 1024 * 1024;
const upload = (size) => route({ method: 'POST', path: '/documents', file: { name: 'f.pdf', type: 'application/pdf', size } });
const avatar = (size) => route({ method: 'PUT', path: '/me/avatar', file: { name: 'a.png', type: 'image/png', size } });

test('hidden: exactly 10 MiB is allowed, one byte more is not', () => {
  assert.equal(upload(10 * MIB).status, 201);
  assert.equal(upload(10 * 1000 * 1000 + 5).status, 201);
  const r = upload(10 * MIB + 1);
  assert.equal(r.status, 413);
  assert.equal(r.body.error, 'E_UPLOAD_TOO_LARGE');
});

test('hidden: the avatar limit is unchanged', () => {
  assert.equal(avatar(511999).status, 200);
  assert.equal(avatar(512000).status, 413);
});
