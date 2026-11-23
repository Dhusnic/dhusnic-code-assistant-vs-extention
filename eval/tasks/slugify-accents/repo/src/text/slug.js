'use strict';

/** Turns a title into a URL slug: lowercase letters and digits separated by dashes. */
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/^-|-$/g, '');
}

module.exports = { slugify };
