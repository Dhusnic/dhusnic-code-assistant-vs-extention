'use strict';

/**
 * The same local date and time n calendar months later (n may be negative). When the target month is shorter,
 * the day is clamped to its last day (Jan 31 + 1 month = Feb 28/29). The input is not modified.
 */
function addMonths(date, n) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

module.exports = { addMonths };
