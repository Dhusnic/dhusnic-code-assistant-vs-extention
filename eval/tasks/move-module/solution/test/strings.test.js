'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { titleCase, ellipsis } = require('../src/text/strings');

test('titleCase', () => assert.equal(titleCase('red apple'), 'Red Apple'));
test('ellipsis', () => assert.equal(ellipsis('abcdefgh', 6), 'abc...'));
