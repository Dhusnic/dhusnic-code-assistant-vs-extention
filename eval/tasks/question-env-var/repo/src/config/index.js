'use strict';
const os = require('os');
const path = require('path');
const { setting } = require('./env');

const DATA_ROOT = '/var/lib/acme';

module.exports = {
  port: () => Number(setting('PORT', '8080')),
  uploadRoot: () => setting('UPLOAD_ROOT', `${DATA_ROOT}/uploads`),
  scratchDir: () => setting('TMP_DIR', path.join(os.tmpdir(), 'acme')),
  thumbnailsDir: () => setting('THUMBS_DIR', `${DATA_ROOT}/thumbs`),
};
