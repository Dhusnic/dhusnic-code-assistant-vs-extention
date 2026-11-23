'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chunk } = require('../src/utils/array');

test('chunk', () => assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]));
