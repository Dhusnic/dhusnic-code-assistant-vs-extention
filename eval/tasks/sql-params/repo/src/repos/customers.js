'use strict';
const { buildWhere } = require('../db/where');

/** Customers matching the filters. `db.query(sql, params)` returns rows. */
function findCustomers(db, filters) {
  const where = buildWhere(filters);
  return db.query(`SELECT * FROM customers ${where}`.trim(), []);
}

module.exports = { findCustomers };
