'use strict';
const { titleCase, ellipsis } = require('./text/strings');

/** The card shown in product lists. */
function productCard(p) {
  return { title: titleCase(p.name), blurb: ellipsis(p.description, 40) };
}

module.exports = { productCard };
