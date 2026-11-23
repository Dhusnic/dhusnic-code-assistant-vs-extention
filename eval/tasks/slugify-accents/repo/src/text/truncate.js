'use strict';

/** Shortens text to at most max characters, ending with an ellipsis when cut. */
function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

module.exports = { truncate };
