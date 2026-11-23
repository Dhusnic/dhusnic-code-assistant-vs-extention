'use strict';

/**
 * Sliding-window rate limiter.
 *   createLimiter({ limit, windowMs, now = Date.now }) -> { allow(key), remaining(key), reset(key) }
 */
function createLimiter({ limit, windowMs, now = Date.now }) {
  throw new Error('not implemented');
}

module.exports = { createLimiter };
