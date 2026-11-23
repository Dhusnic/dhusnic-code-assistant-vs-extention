'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSettings } = require('../src/settings');

test('plain JSON loads', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'set-')), 'settings.json');
  fs.writeFileSync(f, '{"syncIntervalSec": 60}');
  assert.deepEqual(loadSettings(f), { syncIntervalSec: 60, folders: [] });
});
