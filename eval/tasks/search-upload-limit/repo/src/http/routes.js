'use strict';
const { handleUpload } = require('../storage/uploads');
const { setAvatar } = require('../profile/avatar');
const { toHttp } = require('./errors');

/** Minimal route table: returns { status, body }. */
function route(req) {
  try {
    if (req.method === 'POST' && req.path === '/documents') { return { status: 201, body: handleUpload(req.file) }; }
    if (req.method === 'PUT' && req.path === '/me/avatar') { return { status: 200, body: setAvatar(req.file) }; }
    return { status: 404, body: { error: 'not found' } };
  } catch (e) {
    return toHttp(e);
  }
}

module.exports = { route };
