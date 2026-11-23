'use strict';
const path = require('path');
const config = require('../config');

/** Where an uploaded file is stored: <upload root>/<tenant>/<file id>. */
function uploadPath(tenant, fileId) {
  return path.posix.join(config.uploadRoot(), tenant, fileId);
}

module.exports = { uploadPath };
