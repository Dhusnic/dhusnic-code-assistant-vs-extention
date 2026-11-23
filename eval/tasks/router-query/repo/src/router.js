'use strict';

/** A tiny router: patterns like /users/:id; handlers get { ...req, params } and return { status, body }. */
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
    const parts = req.url.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== req.method || r.parts.length !== parts.length) { continue; }
      const params = {};
      const ok = r.parts.every((p, i) => {
        if (p.startsWith(':')) { params[p.slice(1)] = parts[i]; return true; }
        return p === parts[i];
      });
      if (ok) { return r.handler({ ...req, params }); }
    }
    return { status: 404 };
  }
}

module.exports = { Router };
