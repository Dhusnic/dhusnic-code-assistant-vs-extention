'use strict';
const { resolveInside } = require('./files');

/** GET /files/<path>: answers with the absolute file name to stream, or 403. */
function serveFile(root, requestPath) {
  try {
    return { status: 200, file: resolveInside(root, decodeURIComponent(requestPath)) };
  } catch (e) {
    if (e.code === 'EOUTSIDE') { return { status: 403 }; }
    throw e;
  }
}

module.exports = { serveFile };
