'use strict';
const { buildWhere } = require('../db/where');

/** Open orders of the given customers. */
function openOrdersFor(db, customerIds) {
  const where = buildWhere({ status: 'open', customer_id: customerIds });
  return db.query(`SELECT id, total FROM orders ${where} ORDER BY id`, []);
}

/** How many orders match the filters. */
async function countOrders(db, filters) {
  const where = buildWhere(filters);
  const rows = await db.query(`SELECT COUNT(*) AS n FROM orders ${where}`.trim(), []);
  return rows[0].n;
}

module.exports = { openOrdersFor, countOrders };
