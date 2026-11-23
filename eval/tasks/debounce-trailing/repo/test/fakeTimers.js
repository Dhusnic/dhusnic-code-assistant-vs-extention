'use strict';

/** Manual timers: advance(ms) runs everything that became due. */
function fakeTimers() {
  let now = 0, seq = 0;
  const due = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; due.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { due.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && due.has(id)) { due.delete(id); t.fn(); }
      }
    },
    pending: () => due.size,
  };
}

module.exports = { fakeTimers };
