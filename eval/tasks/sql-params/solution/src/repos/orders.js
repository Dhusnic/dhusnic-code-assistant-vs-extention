'use strict';
const { buildWhere } = require('../db/where');

/** Open orders of the given customers. */
function openOrdersFor(db, customerIds) {
  const { sql, params } = buildWhere({ status: 'open', customer_id: customerIds });
  return db.query(`SELECT id, total FROM orders ${sql} ORDER BY id`, params);
}

/** How many orders match the filters. */
async function countOrders(db, filters) {
  const { sql, params } = buildWhere(filters);
  const rows = await db.query(`SELECT COUNT(*) AS n FROM orders ${sql}`.trim(), params);
  return rows[0].n;
}

module.exports = { openOrdersFor, countOrders };
