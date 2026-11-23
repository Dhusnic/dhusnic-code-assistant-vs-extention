'use strict';

/** Turns a title into a URL slug: lowercase letters and digits separated by dashes; accents are dropped. */
function slugify(title) {
  return title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { slugify };
