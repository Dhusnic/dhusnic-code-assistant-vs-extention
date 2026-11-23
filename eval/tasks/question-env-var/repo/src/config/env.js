'use strict';

/** Every setting is read from an environment variable with this prefix (since 1.10). */
const PREFIX = 'ACME_';

/** The value of ACME_<key>, or fallback when it is unset or empty. */
function setting(key, fallback, env = process.env) {
  const value = env[PREFIX + key];
  return value === undefined || value === '' ? fallback : value;
}

module.exports = { setting, PREFIX };
