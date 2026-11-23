'use strict';
const { LruCache } = require('./lru');

/** Wraps a slow price lookup with an LRU cache of the given size. */
function cachedPrices(lookup, size = 100) {
  const cache = new LruCache(size);
  return (sku) => {
    if (cache.has(sku)) { return cache.get(sku); }
    const price = lookup(sku);
    cache.set(sku, price);
    return price;
  };
}

module.exports = { cachedPrices };
