'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv } = require('../src/csv');
const { importContacts } = require('../src/importContacts');

test('simple rows', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
});

test('contacts', () => {
  assert.deepEqual(importContacts('name,company,email\nAnn,Initech,ann@initech.test\n'), [{ name: 'Ann', company: 'Initech', email: 'ann@initech.test' }]);
});
