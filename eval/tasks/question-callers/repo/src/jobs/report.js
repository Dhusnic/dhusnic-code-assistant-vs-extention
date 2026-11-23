'use strict';
const { renew } = require('../billing/subscriptions');

/** Renews every due subscription and reports how many succeeded. */
async function renewDue(subs) {
  let ok = 0;
  for (const s of subs) { await renew(s); ok++; }
  return `${ok} renewed`;
}

module.exports = { renewDue };
