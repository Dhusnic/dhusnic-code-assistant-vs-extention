'use strict';

/** Rounds to a whole number, half away from zero, after removing floating-point noise (100.49999999999999 -> 100.5). */
function roundHalfAway(x) {
  const clean = Number(Math.abs(x).toPrecision(12));
  return Math.sign(x) * Math.round(clean) || 0;
}

const toCents = (amount) => roundHalfAway(amount * 100);

/** Totals of an invoice. lines: [{ price, quantity }], taxRate: e.g. 0.2 for 20 %. Computed in integer cents. */
function invoiceTotals(lines, taxRate) {
  const subtotalCents = lines.reduce((n, l) => n + toCents(l.price * l.quantity), 0);
  const taxCents = roundHalfAway(subtotalCents * taxRate);
  return { subtotal: subtotalCents / 100, tax: taxCents / 100, total: (subtotalCents + taxCents) / 100 };
}

module.exports = { invoiceTotals };
