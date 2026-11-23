'use strict';
const { chargeCard } = require('../payments/gateway');

/** Renews a subscription for another period. */
async function renew(sub) {
  const charge = await chargeCard(sub.card, sub.planCents);
  return { ...sub, lastChargeId: charge.id, renewedAt: new Date().toISOString() };
}

module.exports = { renew };
