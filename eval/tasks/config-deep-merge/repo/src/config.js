'use strict';

const DEFAULTS = {
  server: { host: '0.0.0.0', port: 8080 },
  db: { host: 'localhost', port: 5432, pool: { min: 1, max: 10 } },
  features: ['search'],
  logLevel: 'info',
};

/** Merges user settings over the defaults. */
function merge(base, override) {
  return { ...base, ...override };
}

/** The effective configuration: the user's settings (from config.json) over DEFAULTS. */
function loadConfig(user = {}) {
  return merge(DEFAULTS, user);
}

module.exports = { DEFAULTS, loadConfig, merge };
