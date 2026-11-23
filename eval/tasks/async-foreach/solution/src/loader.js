'use strict';

/** Loads every id with fetchOne(id), concurrently, and returns the results in the order of ids. */
async function loadAll(ids, fetchOne) {
  return Promise.all(ids.map((id) => fetchOne(id)));
}

module.exports = { loadAll };
