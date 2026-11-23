'use strict';
const fs = require('fs');

const DEFAULTS = { syncIntervalSec: 300, folders: [] };

/** Reads the user's settings.json (a UTF-8 BOM is allowed, an empty file means no settings) and applies the defaults. */
function loadSettings(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) { return { ...DEFAULTS }; }
  let user;
  try { user = JSON.parse(text); } catch (e) { throw new Error(`${file}: invalid JSON (${e.message})`); }
  return { ...DEFAULTS, ...user };
}

module.exports = { loadSettings, DEFAULTS };
