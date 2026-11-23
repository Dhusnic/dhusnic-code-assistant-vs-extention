'use strict';

/** The CLI sends updates to the server in batches of this many tickets. */
const BATCH_SIZE = 20;

function batches(items) {
  const out = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) { out.push(items.slice(i, i + BATCH_SIZE)); }
  return out;
}

module.exports = { BATCH_SIZE, batches };
