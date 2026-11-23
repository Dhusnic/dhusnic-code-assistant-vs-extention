'use strict';

/** Reads a boolean feature flag from the environment. */
function flag(name, env = process.env, fallback = false) {
  const value = env[name];
  if (value === undefined) { return fallback; }
  return Boolean(value);
}

/** Reads a whole number from the environment. */
function int(name, env = process.env, fallback = 0) {
  const value = env[name];
  if (value === undefined || value.trim() === '') { return fallback; }
  const n = Number(value);
  if (!Number.isInteger(n)) { throw new Error(`${name} must be a whole number, got "${value}"`); }
  return n;
}

module.exports = { flag, int };
