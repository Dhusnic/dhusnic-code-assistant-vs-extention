'use strict';

/**
 * Fetches one page of users. `client.get(path, query)` resolves to { items, total }.
 * Inactive users are left out unless includeInactive is true; role filters on the server.
 */
async function fetchUsers(client, { page = 1, pageSize = 50, includeInactive = false, role } = {}) {
  const query = { page, pageSize };
  if (!includeInactive) { query.active = true; }
  if (role !== undefined) { query.role = role; }
  const res = await client.get('/users', query);
  return res.items;
}

module.exports = { fetchUsers };
