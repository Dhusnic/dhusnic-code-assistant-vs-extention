'use strict';

/**
 * Sliding-window rate limiter: keeps, per key, the times of the requests it allowed within the last window.
 *   createLimiter({ limit, windowMs, now = Date.now }) -> { allow(key), remaining(key), reset(key) }
 */
function createLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();
  const recent = (key) => {
    const t = now();
    const list = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
    hits.set(key, list);
    return list;
  };
  return {
    allow(key) {
      const list = recent(key);
      if (list.length >= limit) { return false; }
      list.push(now());
      return true;
    },
    remaining(key) {
      return Math.max(0, limit - recent(key).length);
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

module.exports = { createLimiter };
