'use strict';

function literal(v) {
  return typeof v === 'number' ? String(v) : `'${v}'`;
}

/** A WHERE clause for { column: value } filters, e.g. { status: 'open', id: [1, 2] }. */
function buildWhere(filters) {
  const parts = Object.entries(filters).map(([col, v]) => {
    if (v === null) { return `${col} IS NULL`; }
    if (Array.isArray(v)) { return v.length ? `${col} IN (${v.map(literal).join(', ')})` : '1 = 0'; }
    return `${col} = ${literal(v)}`;
  });
  return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
}

module.exports = { buildWhere };
