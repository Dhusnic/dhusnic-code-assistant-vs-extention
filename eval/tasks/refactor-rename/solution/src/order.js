'use strict';
const { calculateOrderTotal } = require('./total');

/** Turns an order into what the checkout page shows. */
function checkout(order) {
  const total = calculateOrderTotal(order.lines, order.discount);
  return { id: order.id, total, status: total > 0 ? 'due' : 'free' };
}

module.exports = { checkout };
