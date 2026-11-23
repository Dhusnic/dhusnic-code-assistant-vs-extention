'use strict';

/** 32-bit FNV-1a hash of a string, as an unsigned integer. Used for sharding and bucketing. */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

module.exports = { fnv1a };
