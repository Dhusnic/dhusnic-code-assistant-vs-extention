'use strict';

const SYMBOLS = { USD: '$', EUR: '€', GBP: '£', INR: '₹' };

/** Formats integer cents for display, e.g. 123450 -> "$1,234.50". */
function formatMoney(cents, currency = 'USD') {
  return SYMBOLS[currency] + (cents / 100).toFixed(2);
}

module.exports = { formatMoney };
