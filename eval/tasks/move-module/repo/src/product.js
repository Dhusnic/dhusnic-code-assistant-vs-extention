'use strict';
const { titleCase, ellipsis } = require('./utils/strings');

/** The card shown in product lists. */
function productCard(p) {
  return { title: titleCase(p.name), blurb: ellipsis(p.description, 40) };
}

module.exports = { productCard };
