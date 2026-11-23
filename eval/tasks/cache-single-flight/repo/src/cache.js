'use strict';

/** A small in-memory cache whose entries expire after ttlMs. */
class TtlCache {
  constructor({ ttlMs, now = Date.now }) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
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

  /** The cached value, or the loader's result (which is then cached). */
  async getOrLoad(key, loader) {
    const hit = this.get(key);
    if (hit !== undefined) { return hit; }
    const value = await loader(key);
    this.set(key, value);
    return value;
  }
}

module.exports = { TtlCache };
