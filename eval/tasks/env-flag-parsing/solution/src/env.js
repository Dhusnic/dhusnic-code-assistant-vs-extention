'use strict';

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off']);

/** Reads a boolean feature flag from the environment. */
function flag(name, env = process.env, fallback = false) {
  const value = (env[name] ?? '').trim().toLowerCase();
  if (value === '') { return fallback; }
  if (TRUE.has(value)) { return true; }
  if (FALSE.has(value)) { return false; }
  throw new Error(`${name} must be true/false, 1/0, yes/no or on/off, got "${env[name]}"`);
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
