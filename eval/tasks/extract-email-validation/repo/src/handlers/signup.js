'use strict';

/** POST /signup body: { email, password }. Returns { status, body }. */
function signup(body, users) {
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { return { status: 400, body: { error: 'invalid email' } }; }
  if (users.has(email)) { return { status: 409, body: { error: 'already registered' } }; }
  if (String(body.password ?? '').length < 8) { return { status: 400, body: { error: 'password too short' } }; }
  users.set(email, { email });
  return { status: 201, body: { email } };
}

module.exports = { signup };
