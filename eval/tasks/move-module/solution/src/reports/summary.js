'use strict';
const { ellipsis } = require('../text/strings');
const { productCard } = require('../product');

/** One line per product: "<title>: <blurb>", each at most 60 characters. */
function summary(products) {
  return products.map((p) => { const c = productCard(p); return ellipsis(`${c.title}: ${c.blurb}`, 60); }).join('\n');
}

module.exports = { summary };
