'use strict';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A parameterized WHERE clause for { column: value } filters, e.g. { status: 'open', id: [1, 2] }
 * -> { sql: 'WHERE status = $1 AND id IN ($2, $3)', params: ['open', 1, 2] }.
 */
function buildWhere(filters) {
  const params = [];
  const ph = (v) => { params.push(v); return `$${params.length}`; };
  const parts = Object.entries(filters).map(([col, v]) => {
    if (!IDENT.test(col)) { throw new Error(`Invalid column name: ${col}`); }
    if (v === null) { return `${col} IS NULL`; }
    if (Array.isArray(v)) { return v.length ? `${col} IN (${v.map(ph).join(', ')})` : '1 = 0'; }
    return `${col} = ${ph(v)}`;
  });
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

module.exports = { buildWhere };
