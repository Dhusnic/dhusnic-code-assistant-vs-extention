'use strict';
const { compose } = require('./compose');

/** The proxy's request pipeline: timing, then auth, then the upstream call. */
function pipeline(upstream) {
  return compose([
    async (ctx, next) => { const t = Date.now(); await next(); ctx.timeMs = Date.now() - t; },
    async (ctx, next) => { if (!ctx.headers?.authorization) { ctx.status = 401; return; } await next(); },
    async (ctx) => { const r = await upstream(ctx.path); ctx.status = r.status; ctx.body = r.body; },
  ]);
}

module.exports = { pipeline };
