'use strict';

/** Versions from oldest to newest. */
function sortVersions(list) {
  return [...list].sort();
}

/** The newest version in the list. */
function latest(list) {
  return sortVersions(list).pop();
}

module.exports = { sortVersions, latest };
