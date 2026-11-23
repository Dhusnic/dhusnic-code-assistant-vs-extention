'use strict';
const { buildWhere } = require('../db/where');

/** Customers matching the filters. `db.query(sql, params)` returns rows. */
function findCustomers(db, filters) {
  const { sql, params } = buildWhere(filters);
  return db.query(`SELECT * FROM customers ${sql}`.trim(), params);
}

module.exports = { findCustomers };
