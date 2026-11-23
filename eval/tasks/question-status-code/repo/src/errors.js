'use strict';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
class UnauthorizedError extends HttpError { constructor() { super(401, 'sign in first'); } }
class NotFoundError extends HttpError { constructor(what) { super(404, `${what} not found`); } }
/** `resource` names what was protected, e.g. 'comment'. */
class ForbiddenError extends HttpError { constructor(resource) { super(403, `not allowed to change this ${resource}`); this.resource = resource; } }

module.exports = { HttpError, UnauthorizedError, NotFoundError, ForbiddenError };
