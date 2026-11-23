import { CdpConnection, LaunchedBrowser } from './cdp';

/* ------------------------------------------------------------------ records */

export interface NetRecord {
  id: string; seq: number; url: string; method: string; type: string; start: number; end?: number;
  status?: number; statusText?: string; mime?: string; size?: number; failed?: string; canceled?: boolean;
  blocked?: string; postData?: string; fromCache?: boolean; mocked?: string; document?: boolean;
}
export interface ConsoleRecord { seq: number; level: 'error' | 'warning' | 'info'; text: string; where?: string }
export interface ExceptionRecord { seq: number; text: string; where?: string; stack?: string }
export interface DialogRecord { seq: number; type: string; message: string }

/** One fault-injection rule: the matching requests fail, answer with a canned response, or are delayed. */
export interface MockRule {
  match: string; method?: string;
  action: 'fail' | 'respond' | 'delay';
  status?: number; body?: string; contentType?: string; headers?: Record<string, string>;
  error?: string; delayMs?: number; times?: number; hits: number;
}

export const FAIL_REASONS = ['Failed', 'Aborted', 'TimedOut', 'AccessDenied', 'ConnectionClosed', 'ConnectionReset', 'ConnectionRefused', 'ConnectionAborted', 'ConnectionFailed', 'NameNotResolved', 'InternetDisconnected', 'AddressUnreachable', 'BlockedByClient', 'BlockedByResponse'];

export const NETWORK_PRESETS: Record<string, { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number }> = {
  none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  'slow-3g': { offline: false, latency: 2000, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 },
  'fast-3g': { offline: false, latency: 560, downloadThroughput: 180 * 1024, uploadThroughput: 84 * 1024 },
  'slow-4g': { offline: false, latency: 150, downloadThroughput: 400 * 1024, uploadThroughput: 200 * 1024 },
};

export const DEVICES: Record<string, { width: number; height: number; scale: number; mobile: boolean; ua?: string }> = {
  desktop: { width: 1366, height: 800, scale: 1, mobile: false },
  laptop: { width: 1280, height: 720, scale: 1, mobile: false },
  tablet: { width: 820, height: 1180, scale: 2, mobile: true, ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  mobile: { width: 390, height: 844, scale: 3, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
};

const API_TYPES = new Set(['XHR', 'Fetch']);
const LONG_LIVED = new Set(['WebSocket', 'EventSource']);
const MAX_NET = 3000;
const MAX_LOG = 600;

/** "*" is a wildcard; without one the pattern matches anywhere in the URL. */
export function urlMatches(url: string, pattern: string): boolean {
  if (!pattern || pattern === '*') { return true; }
  if (!pattern.includes('*')) { return url.includes(pattern); }
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(url) || re.test(url.replace(/^[a-z]+:\/\/[^/]+/i, ''));
}

export const shortUrl = (url: string, max = 140): string => {
  let s = url;
  try { const u = new URL(url); s = u.origin + u.pathname + u.search; } catch { /* keep */ }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

/* ------------------------------------------------------------------ in-page helpers */

/** Runs in the page: finds an element by CSS selector, "text=…", "label=…" or "placeholder=…". */
const FIND_JS = String.raw`function __find(sel) {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const m = /^(text|label|placeholder|role)=(.*)$/s.exec(sel);
  if (!m) { const all = [...document.querySelectorAll(sel)]; return all.find(visible) || all[0] || null; }
  const want = norm(m[2]);
  if (m[1] === 'placeholder') { return [...document.querySelectorAll('[placeholder]')].find((e) => norm(e.getAttribute('placeholder')) === want) || [...document.querySelectorAll('[placeholder]')].find((e) => norm(e.getAttribute('placeholder')).includes(want)) || null; }
  if (m[1] === 'label') {
    for (const l of document.querySelectorAll('label')) { if (norm(l.innerText) === want || norm(l.innerText).includes(want)) { if (l.control) return l.control; const i = l.querySelector('input,select,textarea'); if (i) return i; } }
    return [...document.querySelectorAll('[aria-label]')].find((e) => norm(e.getAttribute('aria-label')) === want) || null;
  }
  if (m[1] === 'role') { const [role, name] = m[2].split(':'); return [...document.querySelectorAll('[role="' + role + '"],' + role)].find((e) => !name || norm(e.innerText || e.getAttribute('aria-label')).includes(norm(name))) || null; }
  const pool = [...document.querySelectorAll('button,a,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],input[type=submit],input[type=button],summary,label,option,li,td,th,h1,h2,h3,h4,h5,h6,p,span,div')].filter(visible);
  const text = (e) => norm(e.innerText || e.value || e.getAttribute('aria-label'));
  const exact = pool.filter((e) => text(e) === want);
  const cands = exact.length ? exact : pool.filter((e) => text(e).includes(want));
  cands.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
  return cands[0] || null;
}`;

const OUTLINE_JS = String.raw`(() => {
  ${FIND_JS}
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const q = (v) => '"' + String(v).replace(/"/g, '\\"') + '"';
  const sel = (el) => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && document.querySelectorAll('#' + el.id).length === 1) return '#' + el.id;
    for (const a of ['data-testid', 'data-test', 'data-cy', 'data-qa', 'name', 'aria-label']) {
      const v = el.getAttribute(a); if (v && v.length < 60) { const s = el.tagName.toLowerCase() + '[' + a + '=' + q(v) + ']'; if (document.querySelectorAll(s).length === 1) return s; }
    }
    const t = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
    if (t && t.length <= 40 && __find('text=' + t) === el) return 'text=' + t;
    const path = []; let e = el;
    while (e && e.nodeType === 1 && path.length < 5) { let s = e.tagName.toLowerCase(); const p = e.parentElement; if (p) { const same = [...p.children].filter((c) => c.tagName === e.tagName); if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(e) + 1) + ')'; } path.unshift(s); e = p; if (e && e.id && /^[A-Za-z][\w-]*$/.test(e.id)) { path.unshift('#' + e.id); break; } }
    return path.join(' > ');
  };
  const out = [];
  for (const el of document.querySelectorAll('a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[contenteditable=true]')) {
    if (!visible(el) || out.length >= 80) continue;
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type') || el.getAttribute('role') || '';
    const field = tag === 'input' || tag === 'select' || tag === 'textarea';
    // A field is named by its <label> (what the user reads), not by its "name" attribute or its option texts.
    const fieldLabel = field && el.labels && el.labels[0] ? el.labels[0].innerText : '';
    let label = (field
      ? fieldLabel || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || ''
      : el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const checkable = type === 'checkbox' || type === 'radio';
    const shown = tag === 'select' ? (el.selectedOptions[0] ? el.selectedOptions[0].text.trim() : '') : field && !checkable && !['submit', 'button', 'reset', 'image', 'file'].includes(type) ? (type === 'password' && el.value ? '••••' : el.value) : '';
    const state = [el.disabled ? 'disabled' : '', checkable ? (el.checked ? 'checked' : 'unchecked') : '', el.required ? 'required' : '', shown ? 'value=' + JSON.stringify(String(shown).slice(0, 40)) : ''].filter(Boolean).join(' ');
    out.push(tag + (type ? '[' + type + ']' : '') + (label ? ' "' + label + '"' : '') + (state ? ' (' + state + ')' : '') + '  →  ' + sel(el));
  }
  const broken = [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.src)).map((i) => i.currentSrc || i.src).slice(0, 20);
  return { title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n'), elements: out, broken };
})()`;

const AUDIT_JS = String.raw`(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const paint = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
  const res = performance.getEntriesByType('resource');
  const biggest = res.map((r) => ({ url: r.name, kb: Math.round((r.transferSize || r.encodedBodySize || 0) / 1024), ms: Math.round(r.duration) })).sort((a, b) => b.kb - a.kb).slice(0, 5);
  const slowest = res.map((r) => ({ url: r.name, ms: Math.round(r.duration) })).sort((a, b) => b.ms - a.ms).slice(0, 5);
  const name = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('value') || (el.querySelector && el.querySelector('img[alt]') && el.querySelector('img[alt]').alt) || '').trim();
  const a11y = [];
  const imgs = [...document.querySelectorAll('img:not([alt])')]; if (imgs.length) a11y.push(imgs.length + ' image(s) without alt text, e.g. ' + (imgs[0].getAttribute('src') || '').slice(0, 80));
  const btns = [...document.querySelectorAll('button,[role=button],a[href]')].filter((b) => !name(b)); if (btns.length) a11y.push(btns.length + ' button/link(s) without an accessible name');
  const inputs = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]),select,textarea')].filter((i) => !(i.labels && i.labels.length) && !i.getAttribute('aria-label') && !i.getAttribute('aria-labelledby') && !i.getAttribute('title')); if (inputs.length) a11y.push(inputs.length + ' form field(s) without a label' + (inputs[0].name ? ', e.g. name=' + inputs[0].name : ''));
  if (!document.documentElement.lang) a11y.push('<html> has no lang attribute');
  if (!document.title.trim()) a11y.push('the page has no <title>');
  const h1 = document.querySelectorAll('h1').length; if (h1 !== 1) a11y.push(h1 + ' <h1> headings (expected 1)');
  const ids = {}; for (const e of document.querySelectorAll('[id]')) ids[e.id] = (ids[e.id] || 0) + 1;
  const dup = Object.keys(ids).filter((k) => ids[k] > 1); if (dup.length) a11y.push('duplicate id(s): ' + dup.slice(0, 5).join(', '));
  if (!document.querySelector('meta[name=viewport]')) a11y.push('no <meta name="viewport"> (mobile layout will be zoomed out)');
  // Without a viewport meta tag a phone lays the page out wider than its screen and zooms out, so compare with the screen too.
  const overflow = document.documentElement.scrollWidth > Math.min(window.innerWidth, screen.width) + 1;
  const mixed = location.protocol === 'https:' ? res.filter((r) => r.name.startsWith('http:')).map((r) => r.name).slice(0, 5) : [];
  return {
    timing: nav ? { ttfb: Math.round(nav.responseStart - nav.requestStart), domContentLoaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), transferKB: Math.round((nav.transferSize || 0) / 1024) } : null,
    paint, resources: res.length, totalKB: Math.round(res.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024), biggest, slowest,
    a11y, overflow, screen: screen.width + 'x' + screen.height, viewport: window.innerWidth + 'x' + window.innerHeight, docWidth: document.documentElement.scrollWidth, mixed,
    dom: document.getElementsByTagName('*').length,
  };
})()`;

/** Runs in the page: turns a table, grid or repeated rows into an array of objects keyed by the header cells. */
const TABLE_JS = String.raw`(sel, rowSel, cellSel) => {
  ${FIND_JS}
  const root = sel ? __find(sel) : (document.querySelector('table, [role=grid], [role=table]'));
  if (!root) return { error: 'No element matches ' + (sel || 'a table') };
  const clean = (e) => (e.innerText || e.value || '').replace(/\s+/g, ' ').trim();
  let rows, header;
  if (rowSel) { rows = [...root.querySelectorAll(rowSel)]; }
  else if (root.tagName === 'TABLE') { rows = [...root.rows]; }
  else { rows = [...root.querySelectorAll('[role=row]')]; }
  const cellsOf = (r) => [...r.querySelectorAll(cellSel || (root.tagName === 'TABLE' && !rowSel ? ':scope > th, :scope > td' : '[role=columnheader],[role=cell],[role=gridcell],[role=rowheader],th,td'))];
  if (!rowSel) {
    const headRow = rows.find((r) => r.querySelector('th,[role=columnheader]'));
    if (headRow) { header = cellsOf(headRow).map(clean); rows = rows.filter((r) => r !== headRow && !r.closest('thead')); }
  }
  const data = rows.map(cellsOf).filter((c) => c.length).map((c) => c.map(clean));
  if (!header) header = (data.length && rowSel) ? data[0].map((_, i) => 'col' + (i + 1)) : (data.shift() || []);
  header = header.map((h, i) => h || 'col' + (i + 1));
  return { header, rows: data.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] === undefined ? null : cells[i]]))) };
}`;

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', keyCode: 9 }, Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 }, Delete: { code: 'Delete', keyCode: 46 }, Space: { code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 }, PageUp: { code: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', keyCode: 34 },
};

/* ------------------------------------------------------------------ session */

export interface OpenOptions { timeoutMs?: number; headers?: Record<string, string>; device?: string; waitFor?: string }
export interface PageSnapshot { title: string; url: string; text: string; elements: string[]; broken: string[] }

export class BrowserSession {
  readonly net: NetRecord[] = [];
  readonly consoleLog: ConsoleRecord[] = [];
  readonly exceptions: ExceptionRecord[] = [];
  readonly dialogs: DialogRecord[] = [];
  private byId = new Map<string, NetRecord>();
  private seq = 0;
  private inflight = new Set<string>();
  private loadWaiters: Array<() => void> = [];
  private rules: MockRule[] = [];
  private fetchOn = false;
  private sessionId = '';
  private mainFrame = '';
  slowMs = 3000;
  lastUsed = Date.now();
  network = 'none';
  /** The main frame's URL, kept current from navigation events (read synchronously by the safety guard). */
  url = 'about:blank';
  /** Mark taken when the current page started loading. */
  pageStart = 0;

  private constructor(private b: LaunchedBrowser) {}

  static async start(b: LaunchedBrowser, opts: { slowMs?: number } = {}): Promise<BrowserSession> {
    const s = new BrowserSession(b);
    if (opts.slowMs) { s.slowMs = opts.slowMs; }
    await s.attach();
    return s;
  }

  get cdp(): CdpConnection { return this.b.cdp; }
  get closed(): boolean { return this.b.cdp.closed; }

  private send(method: string, params: object = {}, timeoutMs?: number): Promise<any> {
    this.lastUsed = Date.now();
    return this.b.cdp.send(method, params, this.sessionId, timeoutMs);
  }

  private async attach(): Promise<void> {
    const { targetInfos } = await this.b.cdp.send('Target.getTargets');
    let page = (targetInfos as any[]).find((t) => t.type === 'page');
    if (!page) { const { targetId } = await this.b.cdp.send('Target.createTarget', { url: 'about:blank' }); page = { targetId }; }
    const { sessionId } = await this.b.cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    this.sessionId = sessionId;
    this.mainFrame = page.targetId;
    this.b.cdp.on((method, p, sid) => { if (sid === this.sessionId) { this.onEvent(method, p); } });
    await Promise.all([
      this.send('Page.enable'), this.send('Runtime.enable'), this.send('Log.enable'),
      this.send('Network.enable', { maxPostDataSize: 65536 }),
      this.send('Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => undefined),
    ]);
    await this.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => undefined);
  }

  /* ---------- events */

  private onEvent(method: string, p: any): void {
    switch (method) {
      case 'Network.requestWillBeSent': {
        if (p.redirectResponse) {
          const prev = this.byId.get(p.requestId);
          if (prev) { prev.status = p.redirectResponse.status; prev.end = p.timestamp * 1000; this.byId.delete(p.requestId); }
        }
        const r: NetRecord = { id: p.requestId, seq: ++this.seq, url: p.request.url, method: p.request.method, type: p.type ?? 'Other', start: p.timestamp * 1000, postData: p.request.postData, document: p.type === 'Document' && p.frameId === this.mainFrame };
        // A new top-level document starts a new page: audits and logs "for this page" start here.
        if (r.document) { this.pageStart = r.seq - 1; }
        this.push(this.net, r, MAX_NET);
        this.byId.set(p.requestId, r);
        if (!LONG_LIVED.has(r.type) && !r.url.startsWith('data:')) { this.inflight.add(p.requestId); }
        break;
      }
      case 'Network.responseReceived': {
        const r = this.byId.get(p.requestId);
        if (r) { r.status = p.response.status; r.statusText = p.response.statusText; r.mime = p.response.mimeType; r.fromCache = !!p.response.fromDiskCache; }
        break;
      }
      case 'Network.loadingFinished': {
        const r = this.byId.get(p.requestId);
        if (r) { r.end = p.timestamp * 1000; r.size = p.encodedDataLength; }
        this.inflight.delete(p.requestId);
        break;
      }
      case 'Network.loadingFailed': {
        const r = this.byId.get(p.requestId);
        if (r) {
          r.end = p.timestamp * 1000;
          r.canceled = !!p.canceled;
          // Requests blocked by browser_simulate come with a reason ("inspector") but no error text.
          r.blocked = p.blockedReason === 'inspector' ? undefined : p.blockedReason ?? p.corsErrorStatus?.corsError;
          r.failed = p.blockedReason === 'inspector' ? 'blocked by browser_simulate' : p.errorText || (p.blockedReason ? `blocked (${p.blockedReason})` : 'failed');
          if (p.blockedReason === 'inspector') { r.mocked = 'block'; }
        }
        this.inflight.delete(p.requestId);
        break;
      }
      case 'Runtime.consoleAPICalled': {
        const level = p.type === 'error' || p.type === 'assert' ? 'error' : p.type === 'warning' ? 'warning' : undefined;
        if (!level) { break; }
        const text = (p.args ?? []).map((a: any) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description ?? a.type)).join(' ');
        const f = p.stackTrace?.callFrames?.[0];
        this.push(this.consoleLog, { seq: ++this.seq, level, text: text.slice(0, 2000), where: f ? `${shortUrl(f.url, 80)}:${f.lineNumber + 1}` : undefined }, MAX_LOG);
        break;
      }
      case 'Log.entryAdded': {
        const e = p.entry;
        if (e.level !== 'error' && e.level !== 'warning') { break; }
        // Network failures are reported from the network log, with more detail.
        if (e.source === 'network') { break; }
        this.push(this.consoleLog, { seq: ++this.seq, level: e.level, text: String(e.text).slice(0, 2000), where: e.url ? `${shortUrl(e.url, 80)}${e.lineNumber !== undefined ? `:${e.lineNumber + 1}` : ''}` : undefined }, MAX_LOG);
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails ?? {};
        const text = d.exception?.description?.split('\n')[0] ?? d.text ?? 'Uncaught exception';
        const stack = d.exception?.description?.split('\n').slice(1, 6).join('\n');
        this.push(this.exceptions, { seq: ++this.seq, text: text.slice(0, 1000), where: d.url ? `${shortUrl(d.url, 80)}:${(d.lineNumber ?? 0) + 1}:${(d.columnNumber ?? 0) + 1}` : undefined, stack }, MAX_LOG);
        break;
      }
      case 'Page.javascriptDialogOpening':
        this.push(this.dialogs, { seq: ++this.seq, type: p.type, message: String(p.message).slice(0, 500) }, MAX_LOG);
        void this.send('Page.handleJavaScriptDialog', { accept: true, promptText: '' }).catch(() => undefined);
        break;
      case 'Page.frameNavigated':
        if (!p.frame?.parentId && p.frame?.url) { this.url = p.frame.url + (p.frame.urlFragment ?? ''); }
        break;
      case 'Page.navigatedWithinDocument':
        if (p.frameId === this.mainFrame && p.url) { this.url = p.url; }
        break;
      case 'Page.loadEventFired':
        for (const w of this.loadWaiters.splice(0)) { w(); }
        break;
      case 'Fetch.requestPaused':
        void this.onPaused(p).catch(() => undefined);
        break;
    }
  }

  private push<T>(arr: T[], v: T, max: number): void { arr.push(v); if (arr.length > max) { arr.splice(0, arr.length - max); } }

  /** A mark: reports list only what happened after it. */
  mark(): number { return this.seq; }

  /* ---------- fault injection */

  private async onPaused(p: any): Promise<void> {
    const url: string = p.request.url;
    const rule = this.rules.find((r) => (!r.method || r.method.toUpperCase() === p.request.method) && urlMatches(url, r.match) && (r.times === undefined || r.hits < r.times));
    if (!rule) { await this.send('Fetch.continueRequest', { requestId: p.requestId }); return; }
    rule.hits++;
    const rec = this.byId.get(p.networkId ?? '') ;
    if (rec) { rec.mocked = rule.action; }
    if (rule.action === 'fail') {
      await this.send('Fetch.failRequest', { requestId: p.requestId, errorReason: rule.error && FAIL_REASONS.includes(rule.error) ? rule.error : 'Failed' });
    } else if (rule.action === 'respond') {
      const headers = Object.entries({ 'Content-Type': rule.contentType ?? (rule.body?.trim().startsWith('{') || rule.body?.trim().startsWith('[') ? 'application/json' : 'text/plain'), 'Access-Control-Allow-Origin': '*', ...(rule.headers ?? {}) }).map(([name, value]) => ({ name, value: String(value) }));
      await this.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: rule.status ?? 200, responseHeaders: headers, body: Buffer.from(rule.body ?? '', 'utf8').toString('base64') });
    } else {
      await new Promise((r) => setTimeout(r, Math.min(rule.delayMs ?? 3000, 120_000)));
      await this.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => undefined);
    }
  }

  async setRules(rules: MockRule[]): Promise<void> {
    this.rules = rules;
    if (rules.length && !this.fetchOn) { await this.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }); this.fetchOn = true; }
    if (!rules.length && this.fetchOn) { await this.send('Fetch.disable'); this.fetchOn = false; }
  }

  get mockRules(): readonly MockRule[] { return this.rules; }

  async setNetwork(preset: string): Promise<void> {
    const c = NETWORK_PRESETS[preset];
    if (!c) { throw new Error(`Unknown network preset "${preset}". Use one of: ${Object.keys(NETWORK_PRESETS).join(', ')}.`); }
    await this.send('Network.emulateNetworkConditions', c);
    this.network = preset;
  }

  async setBlocked(patterns: string[]): Promise<void> { await this.send('Network.setBlockedURLs', { urls: patterns }); }

  async setDevice(name: string): Promise<void> {
    const d = DEVICES[name];
    if (!d) { throw new Error(`Unknown device "${name}". Use one of: ${Object.keys(DEVICES).join(', ')}.`); }
    await this.send('Emulation.setDeviceMetricsOverride', { width: d.width, height: d.height, deviceScaleFactor: d.scale, mobile: d.mobile });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: d.mobile }).catch(() => undefined);
    if (d.ua) { await this.send('Emulation.setUserAgentOverride', { userAgent: d.ua }).catch(() => undefined); }
  }

  async setHeaders(headers: Record<string, string>): Promise<void> { await this.send('Network.setExtraHTTPHeaders', { headers }); }

  async setCookies(cookies: Array<{ name: string; value: string; url: string }>): Promise<void> {
    for (const c of cookies) { await this.send('Network.setCookie', c); }
  }

  /* ---------- navigation and waiting */

  async open(url: string, timeoutMs = 30_000): Promise<{ error?: string; ms: number }> {
    const t0 = Date.now();
    const loaded = this.waitLoad(timeoutMs);
    const r = await this.send('Page.navigate', { url }, timeoutMs);
    if (r.errorText) { return { error: r.errorText, ms: Date.now() - t0 }; }
    const ok = await loaded;
    await this.idle(Math.max(1000, timeoutMs - (Date.now() - t0)));
    return { ms: Date.now() - t0, ...(ok ? {} : { error: `the load event did not fire within ${Math.round(timeoutMs / 1000)} s` }) };
  }

  async history(action: 'back' | 'forward' | 'reload', timeoutMs = 30_000): Promise<void> {
    const loaded = this.waitLoad(timeoutMs);
    const before = this.url;
    if (action === 'reload') { await this.send('Page.reload', { ignoreCache: true }); await loaded; }
    else {
      await this.evaluate(action === 'back' ? 'history.back()' : 'history.forward()');
      // Pages restored from the back/forward cache (and single-page apps) change URL without a new load event.
      const end = Date.now() + Math.min(timeoutMs, 10_000);
      while (this.url === before && Date.now() < end) { await new Promise((r) => setTimeout(r, 50)); }
      await Promise.race([loaded, new Promise((r) => setTimeout(r, 300))]);
    }
    await this.idle(5000);
  }

  private waitLoad(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.loadWaiters = this.loadWaiters.filter((w) => w !== done); resolve(false); }, timeoutMs);
      const done = () => { clearTimeout(t); resolve(true); };
      this.loadWaiters.push(done);
    });
  }

  /** Waits until no request has been in flight for `quietMs`, or `maxMs` passed (polling apps never go quiet). */
  async idle(maxMs = 5000, quietMs = 500): Promise<boolean> {
    const end = Date.now() + maxMs;
    let quietSince = this.inflight.size ? 0 : Date.now();
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 100));
      if (this.inflight.size) { quietSince = 0; continue; }
      if (!quietSince) { quietSince = Date.now(); }
      if (Date.now() - quietSince >= quietMs) { return true; }
    }
    return false;
  }

  async waitFor(what: { selector?: string; text?: string; gone?: string; urlContains?: string; ms?: number }, timeoutMs = 10_000): Promise<string> {
    if (what.ms) { await new Promise((r) => setTimeout(r, Math.min(what.ms!, 60_000))); return `waited ${what.ms} ms`; }
    const end = Date.now() + timeoutMs;
    const check = what.selector ? `!!(${FIND_JS})(${JSON.stringify(what.selector)})`
      : what.gone ? `!(${FIND_JS})(${JSON.stringify(what.gone)})`
      : what.text ? `(document.body && document.body.innerText || '').toLowerCase().includes(${JSON.stringify(what.text.toLowerCase())})`
      : what.urlContains ? `location.href.includes(${JSON.stringify(what.urlContains)})` : 'true';
    while (Date.now() < end) {
      if (await this.evaluate(check).catch(() => false)) { return 'ok'; }
      await new Promise((r) => setTimeout(r, 150));
    }
    const label = what.selector ? `element ${what.selector}` : what.gone ? `${what.gone} to disappear` : what.text ? `text "${what.text}"` : `URL containing "${what.urlContains}"`;
    throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${label}.`);
  }

  /* ---------- page access */

  async evaluate(expression: string, timeoutMs = 15_000): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, timeoutMs);
    if (r.exceptionDetails) { throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text ?? 'evaluation failed'); }
    return r.result?.value;
  }

  snapshot(): Promise<PageSnapshot> { return this.evaluate(OUTLINE_JS); }
  audit(): Promise<any> { return this.evaluate(AUDIT_JS); }

  async table(selector?: string, rowSelector?: string, cellSelector?: string): Promise<{ header: string[]; rows: Array<Record<string, string | null>> }> {
    const r = await this.evaluate(`(${TABLE_JS})(${JSON.stringify(selector ?? '')}, ${JSON.stringify(rowSelector ?? '')}, ${JSON.stringify(cellSelector ?? '')})`);
    if (r?.error) { throw new Error(r.error); }
    return r;
  }

  async read(selector: string | undefined, what: 'text' | 'html' | 'value' | 'attributes' | 'count'): Promise<any> {
    const s = JSON.stringify(selector ?? 'body');
    const body = {
      text: `el.innerText`,
      html: `el.outerHTML`,
      value: `('value' in el) ? el.value : el.innerText`,
      attributes: `Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]))`,
      count: '',
    }[what];
    if (what === 'count') { return this.evaluate(`(() => { ${FIND_JS}; const s = ${s}; return /^(text|label|placeholder|role)=/.test(s) ? (__find(s) ? 1 : 0) : document.querySelectorAll(s).length; })()`); }
    return this.evaluate(`(() => { ${FIND_JS}; const el = __find(${s}); if (!el) throw new Error('No element matches ' + ${s}); return ${body}; })()`);
  }

  /** Scrolls the element into view and returns its centre, or why it cannot be clicked. */
  private async locate(selector: string): Promise<{ x: number; y: number; covered?: string }> {
    const r = await this.evaluate(`(() => { ${FIND_JS}; const el = __find(${JSON.stringify(selector)}); if (!el) return { missing: true };
      el.scrollIntoView({ block: 'center', inline: 'center' }); const b = el.getBoundingClientRect();
      if (!b.width || !b.height) return { hidden: true };
      const x = b.left + b.width / 2, y = b.top + b.height / 2; const top = document.elementFromPoint(x, y);
      const covered = top && top !== el && !el.contains(top) && !top.contains(el) ? (top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + (top.className && typeof top.className === 'string' ? '.' + top.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')) : undefined;
      return { x, y, covered, disabled: !!el.disabled }; })()`);
    if (r?.missing) { throw new Error(`No element matches ${selector}.`); }
    if (r?.hidden) { throw new Error(`${selector} exists but is not visible.`); }
    if (r?.disabled) { throw new Error(`${selector} is disabled.`); }
    return r;
  }

  async click(selector: string, opts: { double?: boolean; right?: boolean } = {}): Promise<string> {
    const { x, y, covered } = await this.locate(selector);
    const button = opts.right ? 'right' : 'left';
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    const clicks = opts.double ? 2 : 1;
    for (let i = 1; i <= clicks; i++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i });
    }
    return covered ? `clicked ${selector} (warning: ${covered} was on top of it, so the click may have hit that instead)` : `clicked ${selector}`;
  }

  async hover(selector: string): Promise<string> {
    const { x, y } = await this.locate(selector);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    return `hovered ${selector}`;
  }

  async type(selector: string, text: string, clear = true): Promise<string> {
    await this.evaluate(`(() => { ${FIND_JS}; const el = __find(${JSON.stringify(selector)}); if (!el) throw new Error('No element matches ' + ${JSON.stringify(selector)});
      el.scrollIntoView({ block: 'center' }); el.focus();
      if (${clear}) { if (typeof el.select === 'function') el.select(); else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }
      else if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') { try { el.setSelectionRange(el.value.length, el.value.length); } catch {} } })()`);
    if (text) { await this.send('Input.insertText', { text }); } else if (clear) { await this.press('Delete'); }
    return `typed ${text.length} character(s) into ${selector}`;
  }

  async press(key: string): Promise<string> {
    const parts = key.split('+');
    const main = parts.pop()!;
    const mods = parts.reduce((m, p) => m | ({ Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 } as Record<string, number>)[p] || m, 0);
    const k = KEYS[main] ?? (main.length === 1 ? { code: `Key${main.toUpperCase()}`, keyCode: main.toUpperCase().charCodeAt(0), text: mods & ~8 ? undefined : main } : undefined);
    if (!k) { throw new Error(`Unknown key "${main}". Use a single character or one of: ${Object.keys(KEYS).join(', ')}.`); }
    const base = { key: main === 'Space' ? ' ' : main, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: mods };
    await this.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    return `pressed ${key}`;
  }

  async select(selector: string, option: string): Promise<string> {
    const r = await this.evaluate(`(() => { ${FIND_JS}; const el = __find(${JSON.stringify(selector)}); if (!el) throw new Error('No element matches ' + ${JSON.stringify(selector)});
      if (el.tagName !== 'SELECT') throw new Error(${JSON.stringify(selector)} + ' is not a <select>: click it and then click the option instead.');
      const want = ${JSON.stringify(option)}.trim().toLowerCase();
      const o = [...el.options].find((o) => o.value.toLowerCase() === want) || [...el.options].find((o) => o.text.trim().toLowerCase() === want) || [...el.options].find((o) => o.text.trim().toLowerCase().includes(want));
      if (!o) throw new Error('No option "' + ${JSON.stringify(option)} + '". Options: ' + [...el.options].map((o) => o.text.trim()).slice(0, 20).join(', '));
      el.value = o.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return o.text.trim(); })()`);
    return `selected "${r}" in ${selector}`;
  }

  async upload(selector: string, files: string[]): Promise<string> {
    const r = await this.send('Runtime.evaluate', { expression: `(() => { ${FIND_JS}; return __find(${JSON.stringify(selector)}); })()` });
    const objectId = r.result?.objectId;
    if (!objectId) { throw new Error(`No element matches ${selector}.`); }
    await this.send('DOM.setFileInputFiles', { files, objectId });
    return `attached ${files.length} file(s) to ${selector}`;
  }

  async scroll(to: 'top' | 'bottom' | string): Promise<string> {
    if (to === 'top' || to === 'bottom') { await this.evaluate(`window.scrollTo(0, ${to === 'top' ? 0 : 'document.body.scrollHeight'})`); return `scrolled to the ${to}`; }
    await this.locate(to);
    return `scrolled to ${to}`;
  }

  async screenshot(opts: { fullPage?: boolean; selector?: string } = {}): Promise<Buffer> {
    let clip: any;
    if (opts.selector) {
      await this.locate(opts.selector);
      const b = await this.evaluate(`(() => { ${FIND_JS}; const r = __find(${JSON.stringify(opts.selector)}).getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
      clip = { ...b, scale: 1 };
    } else if (opts.fullPage) {
      const m = await this.send('Page.getLayoutMetrics');
      const size = m.cssContentSize ?? m.contentSize;
      clip = { x: 0, y: 0, width: Math.min(size.width, 4000), height: Math.min(size.height, 16000), scale: 1 };
    }
    const r = await this.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) }, 60_000);
    return Buffer.from(r.data, 'base64');
  }

  async responseBody(id: string): Promise<string> {
    const r = await this.send('Network.getResponseBody', { requestId: id });
    return r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
  }

  find(idOrPattern: string, apiOnly = true): NetRecord | undefined {
    const direct = this.net.find((r) => r.id === idOrPattern);
    if (direct) { return direct; }
    const all = this.net.filter((r) => (!apiOnly || API_TYPES.has(r.type)) && urlMatches(r.url, idOrPattern));
    return all[all.length - 1];
  }

  async close(): Promise<void> { await this.b.kill(); }

  /* ---------- reports */

  /** Everything that went wrong after `since`, worst first. */
  problems(since: number): string[] {
    const out: string[] = [];
    const net = this.net.filter((r) => r.seq > since);
    const doc = net.filter((r) => r.document).pop();
    if (doc?.status && doc.status >= 400) { out.push(`✘ Page HTTP ${doc.status} ${doc.statusText ?? ''}: ${shortUrl(doc.url)}`.trim()); }
    for (const e of this.exceptions.filter((x) => x.seq > since).slice(0, 15)) { out.push(`✘ JavaScript error: ${e.text}${e.where ? ` (${e.where})` : ''}${e.stack ? `\n    ${e.stack.split('\n').slice(0, 3).map((l) => l.trim()).join('\n    ')}` : ''}`); }
    for (const r of net.filter((x) => x.failed && !x.canceled).slice(0, 25)) {
      out.push(`✘ ${API_TYPES.has(r.type) ? 'API call' : r.type} failed: ${r.method} ${shortUrl(r.url)} → ${r.failed}${r.blocked ? ` (${r.blocked})` : ''}${r.mocked && r.mocked !== 'block' ? ' [simulated]' : ''} [${r.id}]`);
    }
    for (const r of net.filter((x) => !x.failed && x.status && x.status >= 400 && !x.document).slice(0, 25)) {
      // A missing favicon is cosmetic: worth a note, not a failure.
      const minor = /\/favicon\.ico(\?|$)/i.test(r.url);
      out.push(`${minor ? '⚠' : '✘'} ${API_TYPES.has(r.type) ? 'API' : r.type} ${r.method} ${shortUrl(r.url)} → HTTP ${r.status} ${r.statusText ?? ''}${r.end ? ` (${secs(r.end - r.start)})` : ''}${r.mocked ? ' [simulated]' : ''} [${r.id}]`.replace(/ +\(/, ' ('));
    }
    const errs = this.consoleLog.filter((c) => c.seq > since && c.level === 'error');
    for (const c of errs.slice(0, 15)) { out.push(`✘ Console error: ${c.text.split('\n')[0].slice(0, 400)}${c.where ? ` (${c.where})` : ''}`); }
    if (errs.length > 15) { out.push(`  … and ${errs.length - 15} more console errors`); }
    for (const d of this.dialogs.filter((x) => x.seq > since)) { out.push(`⚠ ${d.type} dialog shown (accepted automatically): "${d.message}"`); }
    for (const r of net.filter((x) => x.end && !x.failed && x.end - x.start >= this.slowMs).slice(0, 10)) { out.push(`⚠ Slow: ${r.method} ${shortUrl(r.url)} took ${secs(r.end! - r.start)}${r.mocked === 'delay' ? ' [simulated]' : ''}`); }
    const pending = net.filter((x) => !x.end && !LONG_LIVED.has(x.type) && this.inflight.has(x.id));
    for (const r of pending.slice(0, 5)) { out.push(`⚠ Still pending: ${r.method} ${shortUrl(r.url)} (no response yet)`); }
    const warns = this.consoleLog.filter((c) => c.seq > since && c.level === 'warning');
    if (warns.length) { out.push(`⚠ ${warns.length} console warning(s), e.g. ${warns[0].text.split('\n')[0].slice(0, 200)}`); }
    return out;
  }

  summary(since: number): string {
    const net = this.net.filter((r) => r.seq > since);
    const api = net.filter((r) => API_TYPES.has(r.type));
    const bytes = net.reduce((s, r) => s + (r.size ?? 0), 0);
    return `${net.length} request(s), ${api.length} API call(s), ${bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`}`;
  }

  apiCalls(since = 0, filter?: { match?: string; failedOnly?: boolean; all?: boolean }): NetRecord[] {
    return this.net.filter((r) => r.seq > since && (filter?.all || API_TYPES.has(r.type) || r.document) && (!filter?.match || urlMatches(r.url, filter.match))
      && (!filter?.failedOnly || !!r.failed || (r.status ?? 0) >= 400));
  }

  static line(r: NetRecord): string {
    const result = r.failed ? `FAILED ${r.failed}` : r.status ? `${r.status}` : 'pending';
    const time = r.end ? secs(r.end - r.start) : '';
    const size = r.size ? `${r.size >= 1024 ? `${Math.round(r.size / 1024)} KB` : `${r.size} B`}` : '';
    return `[${r.id}] ${r.method} ${shortUrl(r.url)} → ${result}${[time, size, r.type, r.mocked ? `simulated:${r.mocked}` : ''].filter(Boolean).map((x) => ` · ${x}`).join('')}`;
  }
}
