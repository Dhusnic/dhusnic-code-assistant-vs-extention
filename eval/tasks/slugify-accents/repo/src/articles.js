'use strict';
const { slugify } = require('./text/slug');

/** The public URL path of an article. */
function articlePath(article) {
  return `/blog/${article.year}/${slugify(article.title)}`;
}

module.exports = { articlePath };
