'use strict';

/** "hello world" -> "Hello World" */
function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Keeps at most max characters, adding "..." when cut. */
function ellipsis(s, max) {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

module.exports = { titleCase, ellipsis };
