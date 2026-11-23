'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv } = require('../src/csv');
const { importContacts } = require('../src/importContacts');

test('hidden: quoted commas', () => {
  assert.deepEqual(parseCsv('name,company\nBob,"Acme, Inc."\n'), [['name', 'company'], ['Bob', 'Acme, Inc.']]);
});

test('hidden: doubled quotes and line breaks inside quotes', () => {
  assert.deepEqual(parseCsv('a,b\n"say ""hi""","line1\nline2"\n'), [['a', 'b'], ['say "hi"', 'line1\nline2']]);
});

test('hidden: CRLF, empty fields and no trailing newline', () => {
  assert.deepEqual(parseCsv('a,b,c\r\n1,,3\r\n,"",x'), [['a', 'b', 'c'], ['1', '', '3'], ['', '', 'x']]);
});

test('hidden: contacts with commas in the company', () => {
  assert.deepEqual(importContacts('name,company,email\r\nBob,"Acme, Inc.",bob@acme.test\r\n'), [{ name: 'Bob', company: 'Acme, Inc.', email: 'bob@acme.test' }]);
});
