'use strict';

/**
 * Combines middleware functions (ctx, next) into one, Koa style. The composed function returns a promise for
 * the whole chain; each next() returns a promise for the rest of it, and errors propagate upstream.
 */
function compose(middleware) {
  return function (ctx, next) {
    let index = -1;
    function dispatch(i) {
      if (i <= index) { return Promise.reject(new Error('next() called multiple times')); }
      index = i;
      const fn = i === middleware.length ? next : middleware[i];
      if (!fn) { return Promise.resolve(); }
      try {
        return Promise.resolve(fn(ctx, () => dispatch(i + 1)));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return dispatch(0);
  };
}

module.exports = { compose };
