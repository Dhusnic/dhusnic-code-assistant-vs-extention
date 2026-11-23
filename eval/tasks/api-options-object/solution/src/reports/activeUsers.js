'use strict';
const { fetchUsers } = require('../api/users');

/** Number of active users (the dashboard shows at most 1000). */
async function countActiveUsers(client) {
  const users = await fetchUsers(client, { page: 1, pageSize: 1000 });
  return users.length;
}

module.exports = { countActiveUsers };
