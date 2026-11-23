'use strict';
const { checkDocument } = require('./guards');

let nextId = 1;

/** Stores an uploaded document after validating it; returns its id. */
function handleUpload(file) {
  checkDocument(file);
  return { id: `doc-${nextId++}`, name: file.name, size: file.size };
}

module.exports = { handleUpload };
