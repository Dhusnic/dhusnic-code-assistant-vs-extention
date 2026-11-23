'use strict';

/** Totals of an invoice. lines: [{ price, quantity }], taxRate: e.g. 0.2 for 20 %. */
function invoiceTotals(lines, taxRate) {
  const subtotal = lines.reduce((n, l) => n + l.price * l.quantity, 0);
  const tax = subtotal * taxRate;
  const round = (x) => Math.round(x * 100) / 100;
  return { subtotal: round(subtotal), tax: round(tax), total: round(subtotal + tax) };
}

module.exports = { invoiceTotals };
