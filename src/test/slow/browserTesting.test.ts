import { describe, it, before, after } from 'node:test';
import * as assert from 'assert/strict';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';
import { tmpDir } from '../helpers';
import { BrowserSession } from '../../core/testing/browser';
import { findBrowser, launchBrowser } from '../../core/testing/cdp';
import { createTestingTools } from '../../core/testing/tools';
import type { Tool, ToolCtx } from '../../core/tool';

/**
 * End to end in a real Chrome/Edge: a small app with deliberate bugs, driven through the agent tools exactly as the
 * model would call them. Skipped when no Chromium-based browser is installed.
 */

const USERS = [
  { id: 1, name: 'Ann Lee', email: 'ann@example.com', price: 1234.5, active: true, joined: '2024-01-05' },
  { id: 2, name: 'Bob Ray', email: 'bob@example.com', price: 10, active: false, joined: '2024-02-01' },
  { id: 3, name: 'Cy Fox', email: 'cy@example.com', price: 7.25, active: true, joined: '2024-03-01' },
];

const APP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Users</title></head><body>
<h1>Users</h1>
<form id="login" onsubmit="login(event)">
  <label for="email">Email</label><input id="email" name="email" type="email">
  <label for="pw">Password</label><input id="pw" name="password" type="password">
  <select id="role" aria-label="Role"><option value="u">User</option><option value="a">Admin</option></select>
  <label><input type="checkbox" id="remember"> Remember me</label>
  <button type="submit">Sign in</button>
</form>
<p id="msg"></p>
<div id="status">Loading…</div>
<table id="users"><thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Price</th><th>Active</th><th>Joined</th></tr></thead><tbody></tbody></table>
<a href="/other.html">Other page</a>
<script>
const fmt = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function load() {
  try {
    const r = await fetch('/api/users');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const { data } = await r.json();
    document.querySelector('#users tbody').innerHTML = data.map((u) =>
      // BUG on purpose: user 3's price is shown wrong.
      '<tr><td>' + u.id + '</td><td>' + u.name + '</td><td>' + u.email + '</td><td>' + fmt(u.id === 3 ? u.price + 1 : u.price) + '</td><td>' + (u.active ? 'Yes' : 'No') + '</td><td>' + new Date(u.joined + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</td></tr>').join('');
    document.getElementById('status').textContent = data.length + ' users';
  } catch (e) {
    document.getElementById('status').textContent = 'Could not load users. Please retry.';
  }
}
async function login(ev) {
  ev.preventDefault();
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.value, password: pw.value, role: role.value, remember: remember.checked }) });
  const j = await r.json();
  document.getElementById('msg').textContent = r.ok ? 'Welcome ' + j.name + ' (' + j.role + ')' : 'Error: ' + j.error;
}
load();
</script></body></html>`;

const BAD = (deadPort: number) => `<!doctype html><html><head><title>Bad</title></head><body><h1>Broken page</h1><img src="/missing.png">
<script>console.error('boom: config missing'); console.warn('deprecated thing'); fetch('/api/crash'); fetch('http://127.0.0.1:${deadPort}/api/down').catch(() => {});
setTimeout(() => { throw new TypeError("Cannot read properties of undefined (reading 'map')"); }, 20); setTimeout(() => alert('Something failed'), 40);</script></body></html>`;

const WIDE = `<!doctype html><html><head><title>Wide</title></head><body><div style="width:1400px">too wide</div><img src="/pixel.gif"><button></button><input id="q"></body></html>`;

describe('testing tools in a real browser', { skip: findBrowser() ? false : 'no Chrome/Edge/Chromium installed' }, () => {
  let server: http.Server;
  let base = '';
  let root = '';
  let deadPort = 0;
  let session: BrowserSession | undefined;
  let starting: Promise<BrowserSession> | undefined;
  let tools: Record<string, Tool>;
  const ctx = (): ToolCtx => ({ root, signal: new AbortController().signal, snapshot: async () => undefined });
  const run = (name: string, args: object = {}) => tools[name].run(args, ctx());

  before(async () => {
    root = await tmpDir('ica-browser-');
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    await fs.writeFile(path.join(root, 'upload.txt'), 'hello');
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const json = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
        const html = (status: number, page: string) => { res.writeHead(status, { 'content-type': 'text/html' }); res.end(page); };
        switch (req.url) {
          case '/': case '/app.html': return html(200, APP);
          case '/other.html': return html(200, '<!doctype html><title>Other</title><h1>Other</h1>');
          case '/bad.html': return html(200, BAD(deadPort));
          case '/wide.html': return html(200, WIDE);
          case '/gone.html': return html(404, '<!doctype html><title>Not found</title><h1>404</h1>');
          case '/pixel.gif': res.writeHead(200, { 'content-type': 'image/gif' }); return res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
          case '/api/users': return json(200, { data: USERS, total: USERS.length });
          case '/api/crash': return json(500, { error: 'db down' });
          case '/api/login': {
            const b = JSON.parse(body || '{}');
            return b.password === 'right' ? json(200, { name: 'Ann', role: b.role }) : json(401, { error: 'Invalid credentials' });
          }
          case '/favicon.ico': res.writeHead(404); return res.end();
        }
        res.writeHead(404); res.end('not found');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const list = createTestingTools({
      browser: async (create) => {
        if (session && !session.closed) { return session; }
        if (!create) { return undefined; }
        starting ??= launchBrowser({ executable: findBrowser()!, headless: true, width: 1366, height: 800 }).then((b) => BrowserSession.start(b, { slowMs: 1500 })).then((s) => { session = s; starting = undefined; return s; });
        return starting;
      },
      closeBrowser: async () => { const had = !!session; await session?.close(); session = undefined; return had; },
      artifactsDir: (r) => path.join(r, 'test-reports', 'screenshots'),
      databases: () => [],
      dbPassword: async () => undefined,
      defaults: () => ({ timeoutSec: 20, ignoreHttpsErrors: false }),
    });
    tools = Object.fromEntries(list.map((t) => [t.spec.function.name, t]));
  });

  after(async () => {
    await session?.close();
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports everything wrong on a broken page', async () => {
    const out = await run('browser_open', { url: `${base}/bad.html` });
    assert.match(out, /Opened .*bad\.html \(HTTP 200\)/);
    assert.match(out, /✘ JavaScript error: TypeError: Cannot read properties of undefined \(reading 'map'\)/);
    assert.match(out, /✘ Console error: boom: config missing/);
    assert.match(out, /✘ API GET .*\/api\/crash → HTTP 500/);
    assert.match(out, new RegExp(`✘ API call failed: GET http://127\.0\.0\.1:${deadPort}/api/down → net::ERR_CONNECTION_REFUSED`));
    assert.match(out, /✘ Image GET .*\/missing\.png → HTTP 404/);
    assert.match(out, /⚠ alert dialog shown \(accepted automatically\): "Something failed"/);
    assert.match(out, /⚠ 1 console warning\(s\), e\.g\. deprecated thing/);
    assert.match(out, /WARNINGS \(\d+\):[\s\S]*⚠ Other GET .*\/favicon\.ico → HTTP 404/, 'a missing favicon is only a warning');
    assert.match(out, /ERRORS \(5\):/);
    assert.ok(!/Broken image/.test(out), 'the 404 image is reported once, not twice');
    assert.match(out, /<page_content[\s\S]*Broken page[\s\S]*<\/page_content>/);
  });

  it('explains pages that do not load at all, and page-level HTTP errors', async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const refused = await run('browser_open', { url: `127.0.0.1:${port}/` });
    assert.match(refused, /✘ PAGE FAILED TO LOAD: http:\/\/127\.0\.0\.1:\d+\/\nReason: net::ERR_CONNECTION_REFUSED — nothing is listening/);
    const notFound = await run('browser_open', { url: `${base}/gone.html` });
    assert.match(notFound, /✘ Page HTTP 404/);
  });

  it('reads the data table and finds the value the UI shows wrong (UI vs API)', async () => {
    const out = await run('browser_open', { url: `${base}/app.html`, wait_for: 'text=3 users' });
    assert.match(out, /✔ No errors detected/);
    assert.match(out, /input\[email\] "Email"  →  #email/);
    assert.match(out, /select "Role" \(value="User"\)  →  #role/);
    assert.match(out, /input\[checkbox\] "Remember me" \(unchecked\)  →  #remember/);
    assert.match(out, /button\[submit\] "Sign in"  →  text=Sign in/);
    const table = await run('browser_read', { what: 'table', selector: '#users' });
    assert.match(table, /3 row\(s\); columns: ID, Name, Email, Price, Active, Joined/);
    assert.match(table, /\| 1 \| Ann Lee \| ann@example\.com \| \$1,234\.50 \| Yes \| Jan 5, 2024 \|/);
    const cmp = await run('data_compare', { expected: { network: '/api/users', path: 'data' }, actual: { page_table: '#users' } });
    assert.match(cmp, /✘ MISMATCH: expected \(API response GET .*\/api\/users \(HTTP 200\)\) has 3 row\(s\), actual \(page table #users\) has 3\. Rows matched by key id\./);
    assert.match(cmp, /Equal rows: 2 · rows with wrong values: 1 · missing: 0 · extra: 0/);
    assert.match(cmp, /✘ id=3 · price: 7\.25 → "\$8\.25"/);
    assert.match(cmp, /Compared fields: id, name, email, price, active, joined/);
    const rules = await run('data_compare', { actual: { page_table: '#users' }, rules: { Email: 'required email', ID: 'unique' } });
    assert.match(rules, /✔ Rules: 2\/2 passed/);
  });

  it('drives a login flow and catches the rejected request', async () => {
    const bad = await run('browser_act', { steps: [
      { type: 'label=Email', text: 'ann@example.com' }, { type: 'label=Password', text: 'wrong' }, { click: 'text=Sign in' }, { wait_for_text: 'Error:' },
    ] });
    assert.match(bad, /all 4 done/);
    assert.match(bad, /✘ API POST .*\/api\/login → HTTP 401 Unauthorized/);
    assert.match(bad, /Error: Invalid credentials/);
    const good = await run('browser_act', { steps: [
      { type: '#pw', text: 'right' }, { select: 'label=Role', option: 'Admin' }, { check: '#remember' }, { press: 'Enter' }, { wait_for_text: 'Welcome Ann (a)' },
    ] });
    assert.match(good, /all 5 done/, good);
    assert.match(good, /selected "Admin"/);
    const list = await run('browser_network', { match: '/api/login' });
    assert.match(list, /2 request\(s\)/);
    const id = /\[([\d.]+)\] POST .*\/api\/login → 200/.exec(list)?.[1];
    assert.ok(id, list);
    const detail = await run('browser_network', { request: id });
    assert.match(detail, /Request body:\n\{"email":"ann@example\.com","password":"right","role":"a","remember":true\}/);
    assert.match(detail, /"name": "Ann"/);
    const failed = await run('browser_network', { filter: 'failed' });
    assert.match(failed, /\/api\/login → 401/);
    assert.ok(!/→ 200/.test(failed));
  });

  it('stops at the first failing step and says why', async () => {
    const out = await run('browser_act', { steps: [{ click: 'text=Sign in' }, { click: '#does-not-exist' }, { click: 'text=Sign in' }], timeout_seconds: 2 });
    assert.match(out, /stopped at step 2 of 3/);
    assert.match(out, /2\. ✘ No element matches #does-not-exist\./);
    const wait = await run('browser_act', { steps: [{ wait_for: '#never' }], timeout_seconds: 1 });
    assert.match(wait, /Timed out after 1 s waiting for element #never/);
    assert.match(await run('browser_act', { steps: [{ dance: true }] }), /1\. ✘ Unknown step \{"dance":true\}/);
  });

  it('simulates a failing API and shows how the page copes', async () => {
    const sim = await run('browser_simulate', { rules: [{ match: '/api/users', action: 'respond', status: 500, body: { error: 'boom' } }] });
    assert.match(sim, /GET|ANY/);
    const out = await run('browser_act', { steps: [{ reload: true }, { wait_for_text: 'Could not load users' }] });
    assert.match(out, /all 2 done/);
    assert.match(out, /✘ API GET .*\/api\/users → HTTP 500 .*\[simulated\]/);
    await run('browser_simulate', { rules: [{ match: '/api/users', action: 'fail', error: 'ConnectionRefused' }] });
    const refused = await run('browser_act', { steps: [{ reload: true }, { wait_for_text: 'Could not load users' }] });
    assert.match(refused, /✘ API call failed: GET .*\/api\/users → net::ERR_CONNECTION_REFUSED \[simulated\]/);
    await run('browser_simulate', { rules: [{ match: '/api/users', action: 'respond', body: '{"data": [' }] });
    const malformed = await run('browser_act', { steps: [{ reload: true }, { wait_for_text: 'Could not load users' }] });
    assert.match(malformed, /all 2 done/);
    await run('browser_simulate', { rules: [{ match: '/api/users', action: 'respond', body: { data: [] } }] });
    const empty = await run('browser_act', { steps: [{ reload: true }, { wait_for_text: '0 users' }] });
    assert.match(empty, /all 2 done/);
    await run('browser_simulate', { rules: [{ match: '/api/users', action: 'delay', delay_ms: 1800 }] });
    const slow = await run('browser_act', { steps: [{ reload: true }, { wait_for_text: '3 users' }], timeout_seconds: 10 });
    assert.match(slow, /⚠ Slow: GET .*\/api\/users took [\d.]+ s \[simulated\]/);
    await run('browser_simulate', { rules: [{ match: '/api/users', action: 'fail', times: 1 }] });
    await run('browser_act', { steps: [{ reload: true }, { wait_for_text: 'Could not load users' }] });
    const retry = await run('browser_act', { steps: [{ reload: true }, { wait_for_text: '3 users' }] });
    assert.match(retry, /all 2 done/, '"times" lets later requests through');
    const cleared = await run('browser_simulate', { clear: true });
    assert.match(cleared, /All simulation cleared/);
  });

  it('simulates offline and blocked resources', async () => {
    await run('browser_simulate', { network: 'offline' });
    const off = await run('browser_open', { url: `${base}/other.html` });
    assert.match(off, /PAGE FAILED TO LOAD[\s\S]*ERR_INTERNET_DISCONNECTED/);
    await run('browser_simulate', { network: 'none', block: ['*/api/users'] });
    const blocked = await run('browser_open', { url: `${base}/app.html`, wait_for: 'text=Could not load users' });
    assert.match(blocked, /✘ API call failed: GET .*\/api\/users → blocked by browser_simulate \[/);
    await run('browser_simulate', { clear: true });
  });

  it('navigates, goes back, uploads, scrolls and hovers', async () => {
    await run('browser_open', { url: `${base}/app.html`, wait_for: 'text=3 users' });
    const nav = await run('browser_act', { steps: [{ click: 'text=Other page' }, { wait_url: '/other.html' }, { back: true }, { wait_url: '/app.html' }, { scroll: 'bottom' }, { hover: 'text=Sign in' }] });
    assert.match(nav, /all 6 done/, nav);
    assert.match(nav, /Now at: .*\/app\.html/);
    await session!.evaluate(`document.body.insertAdjacentHTML('beforeend', '<input type=file id=f>')`);
    const up = await run('browser_act', { steps: [{ upload: '#f', files: ['upload.txt'] }] });
    assert.match(up, /attached 1 file\(s\) to #f/);
    assert.equal(await session!.evaluate(`document.getElementById('f').files[0].name`), 'upload.txt');
  });

  it('audits layout, accessibility and performance on a mobile screen, and takes screenshots', async () => {
    await run('browser_open', { url: `${base}/wide.html`, device: 'mobile' });
    const audit = await run('browser_audit');
    assert.match(audit, /screen 390x844/);
    assert.ok(!/bad\.html|api\/crash/.test(audit), 'only the problems of this page');
    assert.match(audit, /Performance: TTFB \d+ ms/);
    assert.match(audit, /⚠ 1 image\(s\) without alt text/);
    assert.match(audit, /⚠ 1 button\/link\(s\) without an accessible name/);
    assert.match(audit, /⚠ 1 form field\(s\) without a label/);
    assert.match(audit, /<html> has no lang attribute/);
    assert.match(audit, /no <meta name="viewport">/);
    assert.match(audit, /⚠ Horizontal overflow: the page is \d+px wide/);
    const shot = await run('browser_screenshot', { name: 'wide page', full_page: true });
    const rel = /Saved (test-reports\/screenshots\/[\w-]+-wide-page\.png)/.exec(shot)?.[1];
    assert.ok(rel, shot);
    const png = await fs.readFile(path.join(root, rel!));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const el = await run('browser_screenshot', { selector: 'text=too wide' });
    assert.match(el, /Saved/);
    await run('browser_open', { url: `${base}/app.html`, device: 'desktop' });
  });

  it('reads text, values, counts, attributes and the console', async () => {
    await run('browser_open', { url: `${base}/bad.html` });
    const consoleLog = await run('browser_read', { what: 'console' });
    assert.match(consoleLog, /\[exception\] TypeError/);
    assert.match(consoleLog, /\[error\] boom: config missing/);
    assert.match(consoleLog, /\[alert dialog\] Something failed/);
    await run('browser_open', { url: `${base}/app.html`, wait_for: 'text=3 users' });
    assert.match(await run('browser_read', { what: 'count', selector: '#users tbody tr' }), /^3 element\(s\)/);
    assert.match(await run('browser_read', { what: 'text', selector: '#status' }), /3 users/);
    assert.match(await run('browser_read', { what: 'attributes', selector: '#email' }), /"type": "email"/);
    assert.match(await run('browser_read', { what: 'elements' }), /text=Sign in/);
    await assert.rejects(run('browser_read', { what: 'text', selector: '#nope' }), /No element matches #nope/);
  });

  it('closes the browser and starts a clean one on demand', async () => {
    assert.match(await run('browser_close'), /The browser is closed/);
    assert.match(await run('browser_close'), /No browser was open/);
    await assert.rejects(run('browser_read', { what: 'text' }), /browser_open first/);
    const out = await run('browser_open', { url: `${base}/other.html`, fresh: true });
    assert.match(out, /Opened .*other\.html \(HTTP 200\)/);
  });
});

describe('browser launch modes', { skip: findBrowser() ? false : 'no Chrome/Edge/Chromium installed' }, () => {
  let server: http.Server;
  let base = '';
  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/x') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"busy"}'); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      // Tall and busy, so a full-page screenshot is a large (multi-frame) message.
      res.end(`<!doctype html><title>Big</title><h1>Big</h1>${Array.from({ length: 400 }, (_, i) => `<p style="color:hsl(${i},70%,40%)">row ${i} ${'lorem ipsum '.repeat(8)}</p>`).join('')}<script>fetch('/api/x'); console.error('bad thing')</script>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const modes: Array<'pipe' | 'port' | 'detached'> = ['pipe', 'port', ...(process.platform === 'win32' ? ['detached' as const] : [])];
  for (const mode of modes) {
    it(`${mode}: opens a page, reports problems, takes a large screenshot, and cleans up`, async () => {
      const b = await launchBrowser({ executable: findBrowser()!, headless: true, width: 1200, height: 800, mode });
      assert.equal(b.mode, mode);
      const s = await BrowserSession.start(b);
      try {
        const since = s.mark();
        const r = await s.open(`${base}/`);
        assert.equal(r.error, undefined);
        const problems = s.problems(since).join('\n');
        assert.match(problems, /API GET .*\/api\/x → HTTP 503/);
        assert.match(problems, /Console error: bad thing/);
        const png = await s.screenshot({ fullPage: true });
        assert.equal(png.subarray(1, 4).toString(), 'PNG');
        assert.ok(png.length > 70_000, `a large screenshot (${png.length} bytes) crosses the 64 KB frame size`);
      } finally {
        await s.close();
      }
      assert.ok(s.closed);
      await assert.rejects(fs.access(b.profileDir), 'the throw-away profile is deleted');
    });
  }
});
