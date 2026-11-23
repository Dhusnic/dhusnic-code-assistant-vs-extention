'use strict';

/** Least-recently-used cache with a fixed number of entries. */
class LruCache {
  constructor(capacity) {
    if (!(capacity > 0)) { throw new Error('capacity must be positive'); }
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key) {
    return this.map.get(key);
  }

  has(key) {
    return this.map.has(key);
  }

  set(key, value) {
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
