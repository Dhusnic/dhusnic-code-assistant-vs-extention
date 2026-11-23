'use strict';
const path = require('path');

/** Resolves a user-supplied path against root; throws (code EOUTSIDE) unless the result is root or inside it. */
function resolveInside(root, userPath) {
  const base = path.resolve(root);
  const full = path.resolve(base, userPath);
  const rel = path.relative(base, full);
  if (rel === '' ) { return full; }
  if (rel.startsWith('..') && (rel === '..' || rel.startsWith(`..${path.sep}`)) || path.isAbsolute(rel)) {
    const e = new Error(`path escapes the storage root: ${userPath}`);
    e.code = 'EOUTSIDE';
    throw e;
  }
  return full;
}

module.exports = { resolveInside };
