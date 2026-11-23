'use strict';
const { fnv1a } = require('./hash');

/** Which of n database shards stores a tenant. */
function shardFor(tenantId, n) {
  return fnv1a(tenantId) % n;
}

module.exports = { shardFor };
