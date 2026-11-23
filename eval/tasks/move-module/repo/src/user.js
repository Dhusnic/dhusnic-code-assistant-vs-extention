'use strict';
const strings = require('./utils/strings');

function displayName(user) {
  return strings.titleCase(`${user.first} ${user.last}`);
}

module.exports = { displayName };
