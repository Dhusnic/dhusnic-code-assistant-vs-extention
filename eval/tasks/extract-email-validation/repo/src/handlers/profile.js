'use strict';

/** PATCH /profile body: { email?, name? }. */
function updateProfile(user, body) {
  const next = { ...user };
  if (body.email !== undefined) {
    const email = String(body.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { return { status: 400, body: { error: 'invalid email' } }; }
    next.email = email;
  }
  if (body.name !== undefined) { next.name = String(body.name).trim(); }
  return { status: 200, body: next };
}

module.exports = { updateProfile };
