'use strict';
const { listOrders } = require('../db/orders');

/** CSV of every order for one customer: header "id,cents", then one line per order. */
function exportCustomer(customer) {
  const lines = ['id,cents'];
  let offset = 0;
  for (;;) {
    const page = listOrders(offset, 25);
    if (!page.length) { break; }
    for (const o of page) { if (o.customer === customer) { lines.push(`${o.id},${o.cents}`); } }
    offset += page.length;
  }
  return lines.join('\n');
}

module.exports = { exportCustomer };
