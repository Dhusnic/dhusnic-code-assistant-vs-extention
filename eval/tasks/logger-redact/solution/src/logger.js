'use strict';

const SENSITIVE = /password|secret|token|authorization/i;

/** A copy of value with every sensitive key's value replaced by "[REDACTED]", at any depth. */
function redact(value) {
  if (Array.isArray(value)) { return value.map(redact); }
  if (value === null || typeof value !== 'object') { return value; }
  const out = {};
  for (const [k, v] of Object.entries(value)) { out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(v); }
  return out;
}

/**
 * Structured logger: one JSON object per line, { time, level, msg, ...fields }, with sensitive fields redacted.
 * `write` and `clock` are injectable for tests.
 */
function createLogger({ write = (line) => process.stdout.write(`${line}\n`), clock = () => new Date().toISOString() } = {}) {
  const log = (level) => (msg, fields = {}) => write(JSON.stringify({ time: clock(), level, msg, ...redact(fields) }));
  return { info: log('info'), warn: log('warn'), error: log('error') };
}

module.exports = { createLogger, redact };
