'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSettings } = require('../src/settings');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-'));
const write = (name, buf) => { const f = path.join(dir, name); fs.writeFileSync(f, buf); return f; };

test('hidden: a UTF-8 BOM is accepted', () => {
  const f = write('bom.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"folders":["C:/Docs"]}\r\n')]));
  assert.deepEqual(loadSettings(f), { syncIntervalSec: 300, folders: ['C:/Docs'] });
});

test('hidden: empty files mean defaults', () => {
  assert.deepEqual(loadSettings(write('empty.json', '')), { syncIntervalSec: 300, folders: [] });
  assert.deepEqual(loadSettings(write('blank.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(' \r\n')]))), { syncIntervalSec: 300, folders: [] });
});

test('hidden: invalid JSON names the file', () => {
  const f = write('broken.json', '{ "a": ');
  assert.throws(() => loadSettings(f), (e) => e instanceof Error && e.message.includes(f));
});
