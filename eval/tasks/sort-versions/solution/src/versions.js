'use strict';

function parse(v) {
  const [core, pre] = v.replace(/^v/, '').split('-', 2);
  return { nums: core.split('.').map(Number), pre: pre === undefined ? [] : pre.split('.') };
}

function comparePre(a, b) {
  if (!a.length || !b.length) { return (b.length ? 1 : 0) - (a.length ? 1 : 0); }
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) { return -1; }
    if (b[i] === undefined) { return 1; }
    const an = /^\d+$/.test(a[i]), bn = /^\d+$/.test(b[i]);
    if (an && bn) { if (Number(a[i]) !== Number(b[i])) { return Number(a[i]) - Number(b[i]); } continue; }
    if (an !== bn) { return an ? -1 : 1; }
    if (a[i] !== b[i]) { return a[i] < b[i] ? -1 : 1; }
  }
  return 0;
}

function compare(x, y) {
  const a = parse(x), b = parse(y);
  for (let i = 0; i < 3; i++) { if ((a.nums[i] ?? 0) !== (b.nums[i] ?? 0)) { return (a.nums[i] ?? 0) - (b.nums[i] ?? 0); } }
  return comparePre(a.pre, b.pre);
}

/** Versions from oldest to newest (semantic-version order). */
function sortVersions(list) {
  return [...list].sort(compare);
}

/** The newest final release; the newest pre-release only when there is no final release. */
function latest(list) {
  const sorted = sortVersions(list);
  const finals = sorted.filter((v) => !v.includes('-'));
  return (finals.length ? finals : sorted).pop();
}

module.exports = { sortVersions, latest };
