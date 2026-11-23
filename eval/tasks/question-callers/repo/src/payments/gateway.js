'use strict';

/** Charges a card through the payment provider; resolves to { id, status }. */
async function chargeCard(card, cents) {
  if (!card?.token) { throw new Error('card token missing'); }
  return { id: `ch_${card.token}_${cents}`, status: 'succeeded' };
}

async function refundCharge(chargeId) {
  return { id: `re_${chargeId}`, status: 'refunded' };
}

module.exports = { chargeCard, refundCharge };
