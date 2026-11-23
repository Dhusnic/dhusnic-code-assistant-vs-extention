'use strict';

/**
 * Structured logger: one JSON object per line, { time, level, msg, ...fields }.
 * `write` and `clock` are injectable for tests.
 */
function createLogger({ write = (line) => process.stdout.write(`${line}\n`), clock = () => new Date().toISOString() } = {}) {
  const log = (level) => (msg, fields = {}) => write(JSON.stringify({ time: clock(), level, msg, ...fields }));
  return { info: log('info'), warn: log('warn'), error: log('error') };
}

module.exports = { createLogger };
