'use strict';
const { parseCsv } = require('./csv');

/** Turns a contacts export (header row: name,company,email) into contact objects. */
function importContacts(text) {
  const [header, ...rows] = parseCsv(text);
  return rows.map((row) => Object.fromEntries(header.map((h, i) => [h.trim(), row[i] ?? ''])));
}

module.exports = { importContacts };
