'use strict';
const FLAGS = require('./definitions');
const { fnv1a } = require('../lib/hash');

/** Whether the flag is on for this user: a stable bucket 0-99 from the hash of "<flag>:<user>". Unknown flags are off. */
function isEnabled(flagName, userId, flags = FLAGS) {
  const flag = flags[flagName];
  if (!flag) { return false; }
  return fnv1a(`${flagName}:${userId}`) % 100 < flag.rollout;
}

module.exports = { isEnabled };
