'use strict';

/** The same local date and time n calendar months later (n may be negative). */
function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

module.exports = { addMonths };
