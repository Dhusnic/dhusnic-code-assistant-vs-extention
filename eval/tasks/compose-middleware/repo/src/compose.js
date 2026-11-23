'use strict';

/** Combines middleware functions (ctx, next) into one, Koa style. */
function compose(middleware) {
  return function (ctx) {
    function dispatch(i) {
      const fn = middleware[i];
      if (!fn) { return; }
      fn(ctx, () => dispatch(i + 1));
    }
    dispatch(0);
    return Promise.resolve();
  };
}

module.exports = { compose };
