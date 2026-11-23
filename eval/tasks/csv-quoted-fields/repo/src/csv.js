'use strict';

/** Parses CSV text into an array of rows, each an array of field strings. */
function parseCsv(text) {
  return text.split('\n').filter((line) => line !== '').map((line) => line.split(','));
}

module.exports = { parseCsv };
