'use strict';
const { MAX_DOCUMENT_BYTES, ALLOWED_TYPES } = require('../config/limits');

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

/** Throws a coded error when an uploaded document breaks the storage rules. */
function checkDocument(file) {
  if (!ALLOWED_TYPES.includes(file.type)) { fail('E_BAD_TYPE', `type ${file.type} is not allowed`); }
  if (file.size > MAX_DOCUMENT_BYTES) { fail('E_UPLOAD_TOO_LARGE', `file is larger than ${MAX_DOCUMENT_BYTES} bytes`); }
}

module.exports = { checkDocument };
