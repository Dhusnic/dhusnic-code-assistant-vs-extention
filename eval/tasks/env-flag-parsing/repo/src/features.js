'use strict';
const { flag, int } = require('./env');

/** Which optional features are on for this process. */
function features(env = process.env) {
  return {
    beta: flag('FEATURE_BETA', env),
    newSearch: flag('FEATURE_NEW_SEARCH', env, true),
    maxUploads: int('MAX_UPLOADS', env, 4),
  };
}

module.exports = { features };
