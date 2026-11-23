'use strict';
const { ForbiddenError, NotFoundError } = require('../errors');

/** Loads req.params.id from the given collection into req.resource. */
const load = (collection, name) => (req, db) => {
  req.resource = db[collection].find((x) => x.id === req.params.id);
  if (!req.resource) { throw new NotFoundError(name); }
};

/** Only the author (or an admin) may change a resource. */
const requireOwner = (name) => (req) => {
  if (req.user.role !== 'admin' && req.resource.authorId !== req.user.id) { throw new ForbiddenError(name); }
};

module.exports = { load, requireOwner };
