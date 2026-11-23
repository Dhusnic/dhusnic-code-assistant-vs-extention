'use strict';
const { LIST_DEFAULTS } = require('../settings');

/** Reads ?limit and ?offset from a query object, applying the defaults and the maximum. */
function pageParams(query = {}) {
  const limit = query.limit === undefined ? LIST_DEFAULTS.limit : Math.min(Number(query.limit), LIST_DEFAULTS.maxLimit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  return { limit, offset };
}

module.exports = { pageParams };
