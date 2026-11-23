'use strict';
const { listOrders } = require('../db/orders');

/** Total revenue in cents over every order, read page by page. */
function totalRevenue(pageSize = 50) {
  let total = 0;
  let after;
  do {
    const page = listOrders({ after, limit: pageSize });
    for (const o of page.items) { total += o.cents; }
    after = page.nextCursor;
  } while (after !== null);
  return total;
}

module.exports = { totalRevenue };
