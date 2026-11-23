'use strict';

const DEFAULTS = {
  server: { host: '0.0.0.0', port: 8080 },
  db: { host: 'localhost', port: 5432, pool: { min: 1, max: 10 } },
  features: ['search'],
  logLevel: 'info',
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Merges user settings over the defaults: nested objects key by key, arrays and plain values replace. */
function merge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

/** The effective configuration: the user's settings (from config.json) over DEFAULTS. */
function loadConfig(user = {}) {
  return merge(DEFAULTS, user);
}

module.exports = { DEFAULTS, loadConfig, merge };
