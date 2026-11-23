'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { route } = require('../src/http/routes');

test('small pdf upload is stored', () => {
  const r = route({ method: 'POST', path: '/documents', file: { name: 'a.pdf', type: 'application/pdf', size: 1000 } });
  assert.equal(r.status, 201);
});

test('wrong type is 415', () => {
  assert.equal(route({ method: 'POST', path: '/documents', file: { name: 'a.exe', type: 'application/x-msdownload', size: 10 } }).status, 415);
});
