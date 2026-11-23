'use strict';
const { fetchUsers } = require('../api/users');

/** CSV ("id,name" lines, no header) of the active administrators. */
async function exportAdmins(client) {
  const users = await fetchUsers(client, { page: 1, pageSize: 500, role: 'admin' });
  return users.map((u) => `${u.id},${u.name}`).join('\n');
}

module.exports = { exportAdmins };
