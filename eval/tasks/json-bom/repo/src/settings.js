'use strict';
const fs = require('fs');

const DEFAULTS = { syncIntervalSec: 300, folders: [] };

/** Reads the user's settings.json and applies the defaults. */
function loadSettings(file) {
  const user = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...DEFAULTS, ...user };
}

module.exports = { loadSettings, DEFAULTS };
