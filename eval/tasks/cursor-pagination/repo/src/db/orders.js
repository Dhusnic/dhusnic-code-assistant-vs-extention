'use strict';
const { orders } = require('./store');

/** One page of orders in id order. */
function listOrders(offset, limit) {
  return orders.slice(offset, offset + limit);
}

module.exports = { listOrders };
