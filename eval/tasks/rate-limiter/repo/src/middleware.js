'use strict';

/** Answers 429 when the client (by API key, else by IP) is over its limit; otherwise calls the handler. */
function rateLimited(limiter, handler) {
  return (req) => {
    const key = req.headers['x-api-key'] ?? req.ip;
    if (!limiter.allow(key)) { return { status: 429, headers: { 'x-ratelimit-remaining': '0' } }; }
    const res = handler(req);
    return { ...res, headers: { ...(res.headers ?? {}), 'x-ratelimit-remaining': String(limiter.remaining(key)) } };
  };
}

module.exports = { rateLimited };
