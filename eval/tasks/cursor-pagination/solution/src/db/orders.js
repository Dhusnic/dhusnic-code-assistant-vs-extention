'use strict';
const { orders } = require('./store');

/**
 * One page of orders in id order, after the cursor (an order id). nextCursor is the id of the last item,
 * or null when nothing follows it.
 */
function listOrders({ after, limit = 50 } = {}) {
  const start = after === undefined || after === null ? 0 : orders.findIndex((o) => o.id > after);
  const items = start < 0 ? [] : orders.slice(start, start + limit);
  const last = items[items.length - 1];
  const more = last !== undefined && orders.some((o) => o.id > last.id);
  return { items, nextCursor: more ? last.id : null };
}

module.exports = { listOrders };
