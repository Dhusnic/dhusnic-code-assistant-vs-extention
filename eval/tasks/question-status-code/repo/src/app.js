'use strict';
const { authenticate } = require('./middleware/auth');
const { load, requireOwner } = require('./middleware/ownership');
const { toResponse } = require('./http/errorHandler');

const ROUTES = {
  'DELETE /comments/:id': [authenticate, load('comments', 'comment'), requireOwner('comment'), (req, db) => {
    db.comments = db.comments.filter((c) => c !== req.resource);
    return { status: 204 };
  }],
  'DELETE /projects/:id': [authenticate, load('projects', 'project'), requireOwner('project'), (req, db) => {
    db.projects = db.projects.filter((p) => p !== req.resource);
    return { status: 204 };
  }],
};

/** Runs the route's steps in order; the first one that returns a value answers. */
function handle(req, db) {
  const [method, url] = [req.method, req.url];
  const [, kind, id] = url.split('/');
  const steps = ROUTES[`${method} /${kind}/:id`];
  if (!steps) { return { status: 404, body: { error: 'no such route' } }; }
  req.params = { id };
  try {
    for (const step of steps) {
      const res = step(req, db);
      if (res) { return res; }
    }
    return { status: 500, body: { error: 'no answer' } };
  } catch (e) {
    return toResponse(e);
  }
}

module.exports = { handle };
