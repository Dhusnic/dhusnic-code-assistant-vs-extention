'use strict';
const { normalizeEmail, isValidEmail } = require('../validation/email');

/** POST /invite body: { emails: string[] }. Invalid addresses are reported, valid ones invited once each. */
function invite(body) {
  const invited = [];
  const rejected = [];
  for (const raw of body.emails ?? []) {
    const email = normalizeEmail(raw);
    if (isValidEmail(email)) {
      if (!invited.includes(email)) { invited.push(email); }
    } else {
      rejected.push(raw);
    }
  }
  return { status: 200, body: { invited, rejected } };
}

module.exports = { invite };
