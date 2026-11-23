'use strict';
const { fetchUsers } = require('../api/users');

/** CSV ("id,name" lines, no header) of the active administrators. */
async function exportAdmins(client) {
  const users = await fetchUsers(client, 1, 500, false);
  return users.filter((u) => u.role === 'admin').map((u) => `${u.id},${u.name}`).join('\n');
}

module.exports = { exportAdmins };
