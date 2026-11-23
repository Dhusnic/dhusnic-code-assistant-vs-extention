'use strict';

/** A small in-memory cache whose entries expire after ttlMs; concurrent loads of one key are shared. */
class TtlCache {
  constructor({ ttlMs, now = Date.now }) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
    this.inflight = new Map();
  }

  get(key) {
    const e = this.entries.get(key);
    if (!e) { return undefined; }
    if (this.now() >= e.expires) { this.entries.delete(key); return undefined; }
    return e.value;
  }

  set(key, value) {
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
  }

  /** The cached value, or the loader's result (which is then cached). One load per key at a time. */
  getOrLoad(key, loader) {
    const hit = this.get(key);
    if (hit !== undefined) { return Promise.resolve(hit); }
    const running = this.inflight.get(key);
    if (running) { return running; }
    const p = Promise.resolve()
      .then(() => loader(key))
      .then((value) => { this.set(key, value); return value; })
      .finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }
}

module.exports = { TtlCache };
