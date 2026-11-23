'use strict';
const { pageParams } = require('./pagination');

/** GET /tickets */
function listTickets(all, query) {
  const { limit, offset } = pageParams(query);
  return { items: all.slice(offset, offset + limit), total: all.length };
}

module.exports = { listTickets };
