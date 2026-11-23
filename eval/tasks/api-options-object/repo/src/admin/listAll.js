'use strict';
const { fetchUsers } = require('../api/users');

/** Every user, active or not, page by page (100 per page). */
async function listAllUsers(client) {
  const all = [];
  for (let page = 1; ; page++) {
    const items = await fetchUsers(client, page, 100, true);
    all.push(...items);
    if (items.length < 100) { return all; }
  }
}

module.exports = { listAllUsers };
