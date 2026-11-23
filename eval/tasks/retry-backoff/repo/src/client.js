'use strict';
const { retry } = require('./retry');

/** GETs a URL through the given transport, retrying on network errors and 5xx answers. */
async function getJson(transport, url, { attempts = 3 } = {}) {
  return retry(async () => {
    const res = await transport(url);
    if (res.status >= 500) { throw new Error(`HTTP ${res.status} for ${url}`); }
    return JSON.parse(res.body);
  }, { attempts });
}

module.exports = { getJson };
