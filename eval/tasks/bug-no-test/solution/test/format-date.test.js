'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDate } = require('../src/format');

test('months are 1-based and zero-padded', () => assert.equal(formatDate(new Date(2024, 2, 5)), '2024-03-05'));
