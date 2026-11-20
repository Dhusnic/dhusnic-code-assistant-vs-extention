import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SecretVault } from '../../core/redact';

// Timing tests run in the slow stage, one file at a time (--test-concurrency=1): next to 900 other tests the CPU is
// shared and the bound measures the machine, not the algorithm.

test('redact: 2MB inputs finish in under 500ms, including adversarial shapes', () => {
  const size = 2 * 1024 * 1024;
  const fill = (s: string) => s.repeat(Math.ceil(size / s.length)).slice(0, size);
  const shapes: Record<string, string> = {
    prose: fill('The quick brown fox jumps over the lazy dog. const value = compute(42);\n'),
    letters: fill('a'),
    keys: fill('password='),
    keysSpaced: fill('password = a '),
    quotes: fill('token="'),
    pemOpen: fill('-----BEGIN PRIVATE KEY-----\n'),
    jwtDash: fill('eyJ-'),
    jwtDots: fill('eyJabcdefghij.'),
    urls: fill('a://b:c'),
    urlAt: fill('x://a:b@'),
    conn: fill('pwd=a;'),
    bearer: fill('Bearer '),
    auth: fill('Authorization: '),
    dashes: fill('xoxb-'),
    placeholders: fill('‹secret:generic:1›'),
  };
  for (const [name, text] of Object.entries(shapes)) {
    // Best of three: the bound is about the algorithm, not about other processes on a busy machine.
    let ms = Infinity;
    for (let i = 0; i < 3 && ms >= 500; i++) {
      const t0 = performance.now();
      new SecretVault().redact(text);
      ms = Math.min(ms, performance.now() - t0);
    }
    assert.ok(ms < 500, `${name} took ${ms.toFixed(0)}ms`);
  }
});
