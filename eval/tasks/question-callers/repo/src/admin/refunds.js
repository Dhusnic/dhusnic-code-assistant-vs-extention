'use strict';
const { refundCharge } = require('../payments/gateway');

// Unlike chargeCard(), refunds are idempotent at the provider, so we don't keep our own lock here.
async function refund(order) {
  return refundCharge(order.chargeId);
}

module.exports = { refund };
