'use strict';
const { calcTotal } = require('./total');

/** Turns an order into what the checkout page shows. */
function checkout(order) {
  const total = calcTotal(order.lines, order.discount);
  return { id: order.id, total, status: total > 0 ? 'due' : 'free' };
}

module.exports = { checkout };
