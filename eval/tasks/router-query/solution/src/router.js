'use strict';

/**
 * A tiny router: patterns like /users/:id; handlers get { ...req, params, query } and return { status, body }.
 * The query string never affects matching; path parameters are percent-decoded (malformed escapes answer 400).
 */
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  /** req: { method, url }. */
  handle(req) {
    const q = req.url.indexOf('?');
    const pathname = q < 0 ? req.url : req.url.slice(0, q);
    const query = {};
    for (const [k, v] of new URLSearchParams(q < 0 ? '' : req.url.slice(q + 1))) {
      query[k] = Object.prototype.hasOwnProperty.call(query, k) ? [].concat(query[k], v) : v;
    }
    const parts = pathname.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== req.method || r.parts.length !== parts.length) { continue; }
      const params = {};
      let ok = true;
      for (let i = 0; i < r.parts.length && ok; i++) {
        const p = r.parts[i];
        if (p.startsWith(':')) {
          try { params[p.slice(1)] = decodeURIComponent(parts[i]); } catch { return { status: 400 }; }
        } else {
          ok = p === parts[i];
        }
      }
      if (ok) { return r.handler({ ...req, params, query }); }
    }
    return { status: 404 };
  }
}

module.exports = { Router };
