'use strict';

/** Returns the items shown on one page. Pages are numbered from 1. */
function paginate(items, page, pageSize) {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

/** Number of pages needed to show every item. */
function pageCount(total, pageSize) {
  return Math.ceil(total / pageSize);
}

module.exports = { paginate, pageCount };
