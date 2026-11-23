'use strict';
const { chargeCard: charge } = require('../payments/gateway');

/** Nightly job: retries yesterday's failed renewals once. */
async function retryFailed(failures) {
  const results = [];
  for (const f of failures) {
    results.push(await charge(f.card, f.cents).catch((e) => ({ status: 'failed', error: e.message })));
  }
  return results;
}

module.exports = { retryFailed };
