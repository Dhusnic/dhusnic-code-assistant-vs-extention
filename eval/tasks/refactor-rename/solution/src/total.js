'use strict';

/** Sum of price × quantity over the order lines, minus an optional discount (0 to 1), rounded to cents. */
function calculateOrderTotal(lines, discount = 0) {
  const sum = lines.reduce((n, l) => n + l.price * l.quantity, 0);
  return Math.round(sum * (1 - discount) * 100) / 100;
}

module.exports = { calculateOrderTotal };
