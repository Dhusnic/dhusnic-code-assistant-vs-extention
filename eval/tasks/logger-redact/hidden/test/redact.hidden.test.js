'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../src/logger');
const { login } = require('../src/login');

function capture() {
  const lines = [];
  return { lines, log: createLogger({ write: (l) => lines.push(JSON.parse(l)), clock: () => 'T' }) };
}

test('hidden: sensitive keys are redacted at any depth', () => {
  const { lines, log } = capture();
  log.info('x', { user: 'ann', password: 'p', nested: { accessToken: 't', deeper: { clientSecret: 's', ok: 1 } }, list: [{ Authorization: 'Bearer z', id: 2 }, 'plain'] });
  assert.deepEqual(lines[0], {
    time: 'T', level: 'info', msg: 'x', user: 'ann', password: '[REDACTED]',
    nested: { accessToken: '[REDACTED]', deeper: { clientSecret: '[REDACTED]', ok: 1 } },
    list: [{ Authorization: '[REDACTED]', id: 2 }, 'plain'],
  });
});

test('hidden: whole objects under a sensitive key are replaced, inputs untouched', () => {
  const { lines, log } = capture();
  const fields = { tokens: { a: 1 }, PASSWORD_HASH: 'h', count: 0, nothing: null };
  log.error('y', fields);
  assert.deepEqual(lines[0], { time: 'T', level: 'error', msg: 'y', tokens: '[REDACTED]', PASSWORD_HASH: '[REDACTED]', count: 0, nothing: null });
  assert.deepEqual(fields, { tokens: { a: 1 }, PASSWORD_HASH: 'h', count: 0, nothing: null });
});

test('hidden: login does not leak the password', () => {
  const { lines, log } = capture();
  const users = new Map([['ann', { password: 'hunter2' }]]);
  assert.equal(login(log, users, { user: 'ann', password: 'hunter2' }, { authorization: 'Basic abc' }), true);
  assert.ok(!JSON.stringify(lines).includes('hunter2'));
  assert.ok(!JSON.stringify(lines).includes('Basic abc'));
  assert.equal(lines[0].user, 'ann');
});
