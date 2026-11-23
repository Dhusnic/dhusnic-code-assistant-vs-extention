'use strict';
const { addMonths } = require('./dates');

/** Billing dates for the next `count` cycles of a monthly subscription that started on `anchor`. */
function upcomingBillingDates(anchor, count) {
  return Array.from({ length: count }, (_, i) => addMonths(anchor, i + 1));
}

module.exports = { upcomingBillingDates };
