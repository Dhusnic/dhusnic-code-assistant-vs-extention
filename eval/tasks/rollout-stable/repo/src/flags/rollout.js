'use strict';
const FLAGS = require('./definitions');

/** Whether the flag is on for this user. Unknown flags are off. */
function isEnabled(flagName, userId, flags = FLAGS) {
  const flag = flags[flagName];
  if (!flag) { return false; }
  return Math.random() * 100 < flag.rollout;
}

module.exports = { isEnabled };
