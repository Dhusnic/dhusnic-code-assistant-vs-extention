'use strict';
const { fetchUsers } = require('../api/users');

/** Number of active users (the dashboard shows at most 1000). */
async function countActiveUsers(client) {
  const users = await fetchUsers(client, 1, 1000, false);
  return users.length;
}

module.exports = { countActiveUsers };
