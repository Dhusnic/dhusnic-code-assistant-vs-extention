'use strict';
const { TtlCache } = require('./cache');

/** Users by id, cached for a minute. `db.findUser(id)` returns a promise. */
function createUserService(db, { ttlMs = 60_000, now } = {}) {
  const cache = new TtlCache({ ttlMs, now });
  return {
    getUser: (id) => cache.getOrLoad(`user:${id}`, () => db.findUser(id)),
  };
}

module.exports = { createUserService };
