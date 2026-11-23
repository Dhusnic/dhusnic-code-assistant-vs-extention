'use strict';

/** Logs a login attempt and checks the password. */
function login(logger, users, body, headers) {
  logger.info('login attempt', { user: body.user, body, headers });
  const u = users.get(body.user);
  return Boolean(u && u.password === body.password);
}

module.exports = { login };
