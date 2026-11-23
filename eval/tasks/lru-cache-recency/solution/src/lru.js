'use strict';

/** Least-recently-used cache with a fixed number of entries. The Map's insertion order is the recency order. */
class LruCache {
  constructor(capacity) {
    if (!(capacity > 0)) { throw new Error('capacity must be positive'); }
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) { return undefined; }
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key) {
    return this.map.has(key);
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return this;
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { LruCache };
