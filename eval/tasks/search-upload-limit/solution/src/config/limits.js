'use strict';

module.exports = {
  /** Largest document upload: 10 MiB, inclusive. */
  MAX_DOCUMENT_BYTES: 10 * 1024 * 1024,
  ALLOWED_TYPES: ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'],
};
