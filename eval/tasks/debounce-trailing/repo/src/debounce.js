'use strict';

/** Calls fn once, `wait` ms after the last call of a burst. */
function debounce(fn, wait, timers = { setTimeout, clearTimeout }) {
  let timer = null;
  let firstArgs = null;
  return function debounced(...args) {
    if (timer === null) { firstArgs = args; }
    timers.clearTimeout(timer);
    timer = timers.setTimeout(() => { timer = null; fn(...firstArgs); }, wait);
  };
}

module.exports = { debounce };
