'use strict';

/** Formats a date as YYYY-MM-DD in local time. */
function formatDate(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Formats a duration in seconds as m:ss. */
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

module.exports = { formatDate, formatDuration };
