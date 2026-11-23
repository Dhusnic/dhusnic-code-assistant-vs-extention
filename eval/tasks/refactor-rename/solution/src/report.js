'use strict';
const { calculateOrderTotal } = require('./total');

/** One line per order: "<id>: <total with 2 decimals>". */
function report(orders) {
  return orders.map((o) => `${o.id}: ${calculateOrderTotal(o.lines, o.discount).toFixed(2)}`).join('\n');
}

module.exports = { report };
