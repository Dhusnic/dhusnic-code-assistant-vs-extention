'use strict';
const { normalizeEmail, isValidEmail } = require('../validation/email');

/** PATCH /profile body: { email?, name? }. */
function updateProfile(user, body) {
  const next = { ...user };
  if (body.email !== undefined) {
    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) { return { status: 400, body: { error: 'invalid email' } }; }
    next.email = email;
  }
  if (body.name !== undefined) { next.name = String(body.name).trim(); }
  return { status: 200, body: next };
}

module.exports = { updateProfile };
