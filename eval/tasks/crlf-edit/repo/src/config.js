'use strict';

/** Default settings; callers override them with their own. */
const DEFAULTS = {
  retries: 3,
  timeoutMs: 1000,
  baseUrl: 'http://localhost:8080',
};

/** The defaults with the caller's overrides applied. */
function loadConfig(overrides = {}) {
  return { ...DEFAULTS, ...overrides };
}

module.exports = { DEFAULTS, loadConfig };
