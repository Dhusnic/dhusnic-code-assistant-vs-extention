'use strict';

const SYMBOLS = { USD: '$', EUR: '€', GBP: '£', INR: '₹' };

/** Formats integer cents for display, e.g. 123450 -> "$1,234.50", -5 -> "-$0.05". */
function formatMoney(cents, currency = 'USD') {
  const symbol = SYMBOLS[currency];
  if (!symbol) { throw new Error(`Unknown currency: ${currency}`); }
  const abs = Math.abs(Math.round(cents));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${symbol}${whole}.${frac}`;
}

module.exports = { formatMoney };
