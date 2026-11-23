'use strict';

/**
 * Fetches one page of users. `client.get(path, query)` resolves to { items, total }.
 * Inactive users are left out unless includeInactive is true.
 */
async function fetchUsers(client, page, pageSize, includeInactive) {
  const query = { page, pageSize };
  if (!includeInactive) { query.active = true; }
  const res = await client.get('/users', query);
  return res.items;
}

module.exports = { fetchUsers };
