'use strict';
const { pay } = require('../payments');

/** Places the order: totals the cart and pays for it. */
async function checkout(cart, customer) {
  const totalCents = cart.items.reduce((n, i) => n + i.cents * i.qty, 0);
  const charge = await pay({ customer, totalCents });
  return { status: 'placed', chargeId: charge.id };
}

module.exports = { checkout };
