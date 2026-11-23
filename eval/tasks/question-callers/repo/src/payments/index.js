'use strict';
const gateway = require('./gateway');

/** Pays an order with the customer's default card. */
function pay(order) {
  return gateway.chargeCard(order.customer.card, order.totalCents);
}

module.exports = { pay };
