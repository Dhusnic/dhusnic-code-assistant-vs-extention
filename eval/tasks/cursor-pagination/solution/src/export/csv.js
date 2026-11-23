'use strict';
const { listOrders } = require('../db/orders');

/** CSV of every order for one customer: header "id,cents", then one line per order. */
function exportCustomer(customer) {
  const lines = ['id,cents'];
  let after;
  do {
    const page = listOrders({ after, limit: 25 });
    for (const o of page.items) { if (o.customer === customer) { lines.push(`${o.id},${o.cents}`); } }
    after = page.nextCursor;
  } while (after !== null);
  return lines.join('\n');
}

module.exports = { exportCustomer };
