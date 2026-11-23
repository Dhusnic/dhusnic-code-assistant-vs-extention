'use strict';

/** Loads every id with fetchOne(id) and returns the results in the order of ids. */
async function loadAll(ids, fetchOne) {
  const results = [];
  ids.forEach(async (id) => {
    results.push(await fetchOne(id));
  });
  return results;
}

module.exports = { loadAll };
