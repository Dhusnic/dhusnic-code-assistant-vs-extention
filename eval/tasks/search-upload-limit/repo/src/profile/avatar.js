'use strict';

/** Avatars are small on purpose: 512 KB (decimal, as the mobile apps document it), exclusive. */
const MAX_AVATAR_BYTES = 512 * 1000;

function setAvatar(file) {
  if (file.size >= MAX_AVATAR_BYTES) {
    const e = new Error('avatar too large');
    e.code = 'E_AVATAR_TOO_LARGE';
    throw e;
  }
  return { ok: true };
}

module.exports = { setAvatar, MAX_AVATAR_BYTES };
