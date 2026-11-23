'use strict';
const strings = require('./text/strings');

function displayName(user) {
  return strings.titleCase(`${user.first} ${user.last}`);
}

module.exports = { displayName };
