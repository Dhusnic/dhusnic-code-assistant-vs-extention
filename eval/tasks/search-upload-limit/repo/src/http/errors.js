'use strict';

const STATUS = { E_UPLOAD_TOO_LARGE: 413, E_BAD_TYPE: 415, E_AVATAR_TOO_LARGE: 413 };

/** Maps a thrown error with a code to an HTTP answer. */
function toHttp(e) {
  return { status: STATUS[e.code] ?? 500, body: { error: e.code ?? 'internal', message: e.message } };
}

module.exports = { toHttp };
