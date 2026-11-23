'use strict';
const { listOrders } = require('../db/orders');

/** Total revenue in cents over every order, read page by page. */
function totalRevenue(pageSize = 50) {
  let total = 0;
  for (let offset = 0; ; offset += pageSize) {
    const page = listOrders(offset, pageSize);
    for (const o of page) { total += o.cents; }
    if (page.length < pageSize) { return total; }
  }
}

module.exports = { totalRevenue };
