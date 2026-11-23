'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trims and lowercases an email address as typed by a user. */
function normalizeEmail(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

/** True when email looks like local@domain.tld (no spaces, one @). */
function isValidEmail(email) {
  return EMAIL_RE.test(email);
}

module.exports = { normalizeEmail, isValidEmail };
