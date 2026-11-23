'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { resolveInside } = require('../src/files');
const { serveFile } = require('../src/serve');

const root = path.join(os.tmpdir(), 'store');

test('hidden: sibling folders with the same prefix are outside', () => {
  assert.throws(() => resolveInside(root, path.join(os.tmpdir(), 'store2', 'secret.txt')), { code: 'EOUTSIDE' });
  assert.throws(() => resolveInside(root, '../store2/secret.txt'), { code: 'EOUTSIDE' });
  assert.equal(serveFile(root, '..%2Fstore-backup%2Fx').status, 403);
});

test('hidden: the root itself and normalized inner paths are fine', () => {
  assert.equal(resolveInside(root, '.'), root);
  assert.equal(resolveInside(root + path.sep, 'x'), path.join(root, 'x'));
  assert.equal(resolveInside(root, 'a/../b/./c.txt'), path.join(root, 'b', 'c.txt'));
  assert.equal(resolveInside(path.join(root, 'sub', '..'), 'f'), path.join(root, 'f'));
  assert.equal(serveFile(root, 'docs%2Fa.txt').file, path.join(root, 'docs', 'a.txt'));
});

test('hidden: absolute paths elsewhere are outside', () => {
  assert.throws(() => resolveInside(root, path.parse(root).root), { code: 'EOUTSIDE' });
});
