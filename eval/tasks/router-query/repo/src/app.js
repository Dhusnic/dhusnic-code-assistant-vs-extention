'use strict';
const { Router } = require('./router');

/** The users API. */
function createApp(users) {
  return new Router()
    .add('GET', '/users', (req) => ({ status: 200, body: users.filter((u) => !req.query?.role || u.role === req.query.role) }))
    .add('GET', '/users/:id', (req) => {
      const u = users.find((x) => x.id === req.params.id);
      return u ? { status: 200, body: u } : { status: 404 };
    });
}

module.exports = { createApp };
