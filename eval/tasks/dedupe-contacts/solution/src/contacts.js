'use strict';
const { uniqueBy } = require('./utils/array');

/** Combines the contacts from the phone and from the CRM into one list (phone first), one entry per email. */
function mergeContacts(phone, crm) {
  let anonymous = 0;
  const key = (c) => (c.email ? c.email.trim().toLowerCase() : Symbol(anonymous++));
  return uniqueBy([...phone, ...crm], key);
}

module.exports = { mergeContacts };
