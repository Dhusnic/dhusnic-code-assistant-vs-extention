'use strict';

/** Combines the contacts from the phone and from the CRM into one list (phone first). */
function mergeContacts(phone, crm) {
  return [...phone, ...crm];
}

module.exports = { mergeContacts };
