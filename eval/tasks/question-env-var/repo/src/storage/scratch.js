'use strict';
const path = require('path');
const config = require('../config');

/** Temporary files while an upload is being received. */
function partialPath(uploadId) {
  return path.join(config.scratchDir(), `${uploadId}.part`);
}

module.exports = { partialPath };
