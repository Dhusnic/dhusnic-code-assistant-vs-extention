'use strict';
const path = require('path');

/** Resolves a user-supplied path against root and makes sure it stays inside root. */
function resolveInside(root, userPath) {
  const full = path.resolve(root, userPath);
  if (!full.startsWith(root)) {
    const e = new Error(`path escapes the storage root: ${userPath}`);
    e.code = 'EOUTSIDE';
    throw e;
  }
  return full;
}

module.exports = { resolveInside };
