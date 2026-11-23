'use strict';

/** Exports are written in chunks of 20 rows to keep memory flat. */
const CHUNK_ROWS = 20;

function chunkCount(rows) {
  return Math.ceil(rows / CHUNK_ROWS);
}

module.exports = { CHUNK_ROWS, chunkCount };
