import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { waitForQuiet } from '../core/settle';

/** A fake event source: fire() emits a change, disposed counts dispose calls. */
function source() {
  const s = { listener: undefined as undefined | (() => void), disposed: 0, fire: () => s.listener?.() };
  const subscribe = (fn: () => void) => { s.listener = fn; return { dispose: () => { s.disposed++; s.listener = undefined; } }; };
  return { s, subscribe };
}

test('waitForQuiet: resolves "quiet" when nothing changes and disposes the subscription', async () => {
  const { s, subscribe } = source();
  const t0 = Date.now();
  assert.equal(await waitForQuiet(subscribe, { quietMs: 30, maxMs: 1000 }), 'quiet');
  assert.ok(Date.now() - t0 < 500);
  assert.equal(s.disposed, 1);
});

test('waitForQuiet: each change restarts the quiet timer', async () => {
  const { s, subscribe } = source();
  const t0 = Date.now();
  const p = waitForQuiet(subscribe, { quietMs: 60, maxMs: 2000 });
  for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 30)); s.fire(); }
  assert.equal(await p, 'quiet');
  assert.ok(Date.now() - t0 >= 150, 'should wait past the last change');
  assert.equal(s.disposed, 1);
});

test('waitForQuiet: gives up with "timeout" when changes never stop', async () => {
  const { s, subscribe } = source();
  const iv = setInterval(() => s.fire(), 10);
  try {
    assert.equal(await waitForQuiet(subscribe, { quietMs: 50, maxMs: 150 }), 'timeout');
  } finally { clearInterval(iv); }
  assert.equal(s.disposed, 1);
});

test('waitForQuiet: an abort resolves "aborted" at once, also when already aborted', async () => {
  const { s, subscribe } = source();
  const ac = new AbortController();
  const p = waitForQuiet(subscribe, { quietMs: 1000, maxMs: 5000, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  assert.equal(await p, 'aborted');
  assert.equal(s.disposed, 1);

  const pre = new AbortController(); pre.abort();
  const b = source();
  assert.equal(await waitForQuiet(b.subscribe, { quietMs: 10, maxMs: 100, signal: pre.signal }), 'aborted');
  assert.equal(b.s.disposed, 0, 'never subscribed when already aborted');
});
