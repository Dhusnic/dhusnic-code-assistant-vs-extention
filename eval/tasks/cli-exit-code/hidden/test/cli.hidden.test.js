'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bin = path.join(__dirname, '..', 'bin', 'validate-config.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
const file = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

test('hidden: valid file', () => {
  const r = run(file('ok.json', '{"service":"api","replicas":3}'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'OK');
});

test('hidden: invalid content exits 1 with problems on stderr', () => {
  const r = run(file('bad.json', '{"replicas":0}'));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /service: required string/);
  assert.match(r.stderr, /replicas: whole number/);
  const j = run(file('broken.json', '{ nope'));
  assert.equal(j.status, 1);
  assert.equal(j.stdout, '');
  assert.notEqual(j.stderr.trim(), '');
});

test('hidden: usage and read errors exit 2', () => {
  const u = run();
  assert.equal(u.status, 2);
  assert.equal(u.stdout, '');
  assert.match(u.stderr, /usage/i);
  const m = run(path.join(dir, 'missing.json'));
  assert.equal(m.status, 2);
  assert.equal(m.stdout, '');
});
