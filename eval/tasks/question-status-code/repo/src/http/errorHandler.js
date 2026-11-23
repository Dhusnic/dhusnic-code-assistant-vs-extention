'use strict';
const { HttpError, ForbiddenError } = require('../errors');

// SEC-112: for resources that belong to other users we answer as if they did not exist, so that ids can't be
// probed. Projects are visible to everybody, so they keep the honest answer.
const HIDDEN_WHEN_FORBIDDEN = new Set(['comment', 'attachment']);

function toResponse(err) {
  if (err instanceof ForbiddenError && HIDDEN_WHEN_FORBIDDEN.has(err.resource)) {
    return { status: 404, body: { error: 'not found' } };
  }
  if (err instanceof HttpError) { return { status: err.status, body: { error: err.message } }; }
  return { status: 500, body: { error: 'internal error' } };
}

module.exports = { toResponse };
