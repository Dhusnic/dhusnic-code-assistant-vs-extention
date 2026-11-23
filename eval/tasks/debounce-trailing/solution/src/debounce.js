'use strict';

/** Calls fn once, `wait` ms after the last call of a burst, with that last call's arguments and `this`. */
function debounce(fn, wait, timers = { setTimeout, clearTimeout }) {
  let timer = null;
  let pending = null;
  const run = () => {
    const p = pending;
    pending = null;
    timer = null;
    return fn.apply(p.self, p.args);
  };
  function debounced(...args) {
    pending = { self: this, args };
    if (timer !== null) { timers.clearTimeout(timer); }
    timer = timers.setTimeout(run, wait);
  }
  debounced.cancel = () => {
    if (timer !== null) { timers.clearTimeout(timer); }
    timer = null;
    pending = null;
  };
  debounced.flush = () => {
    if (!pending) { return undefined; }
    timers.clearTimeout(timer);
    return run();
  };
  return debounced;
}

module.exports = { debounce };
