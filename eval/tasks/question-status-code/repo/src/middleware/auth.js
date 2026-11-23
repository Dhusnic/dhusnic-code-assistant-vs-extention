'use strict';
const { UnauthorizedError } = require('../errors');

function authenticate(req) {
  if (!req.user) { throw new UnauthorizedError(); }
}

module.exports = { authenticate };
