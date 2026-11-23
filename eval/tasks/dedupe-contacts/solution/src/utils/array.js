'use strict';

/** Splits items into chunks of at most size. */
function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) { out.push(items.slice(i, i + size)); }
  return out;
}

/** Items with duplicate keys removed: the first occurrence of each key is kept, in the original order. */
function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) { return false; }
    seen.add(key);
    return true;
  });
}

module.exports = { chunk, uniqueBy };
