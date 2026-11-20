import { after, describe, it } from 'node:test';
import * as assert from 'assert/strict';
import * as dns from 'dns';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as path from 'path';
import * as zlib from 'zlib';
import { tmpDir } from './helpers';
import { checkUrl, hostMatches, isPrivateIp, normalizeIpv4Literal, assertPublicAddress } from '../core/web/ssrf';
import { createHttpClient } from '../core/web/net';
import { cachedFetch, WebCache } from '../core/web/cache';
import { WebError } from '../core/web/types';

/** Exercises the SSRF guard, the HTTP client and the disk cache against in-process servers on 127.0.0.1. */

// Self-signed EC certificate for 127.0.0.1 / localhost (valid until 2126); test use only.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgQfrPoVCt2Ah1VbIa
vnrCvWI+ihCRMUkuT/lXf07NKZ+hRANCAAQX9zqWeGh5f59JaG7F67+cA9vNfh/l
knmxaIWMpYnTAdBU3F0LjZEw4zaKsIqb06FPSc3I6g5fZffgHJrf4cgh
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBmTCCAT+gAwIBAgIUH42MgBny8MYiriDZEsax0icgscQwCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIaWNhLXRlc3QwIBcNMjYxMTIwMDc0ODI0WhgPMjEyNjEwMjcw
NzQ4MjRaMBMxETAPBgNVBAMMCGljYS10ZXN0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEF/c6lnhoeX+fSWhuxeu/nAPbzX4f5ZJ5sWiFjKWJ0wHQVNxdC42RMOM2
irCKm9OhT0nNyOoOX2X34Bya3+HIIaNvMG0wHQYDVR0OBBYEFPz6OmCa21poO+Pj
EMu7SivkSdPAMB8GA1UdIwQYMBaAFPz6OmCa21poO+PjEMu7SivkSdPAMBoGA1Ud
EQQTMBGHBH8AAAGCCWxvY2FsaG9zdDAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49
BAMCA0gAMEUCIHZPnEp9rKdTbMYqroCV0RlyfEK2e/I6ypCFHBEAPIvJAiEA0A9U
4mPx0g5CLANdoENZu8vwB6VbP8f6JXjW4AoTkvE=
-----END CERTIFICATE-----
`;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;
interface TestServer { url: string; port: number; hits: http.IncomingMessage[] }

const servers: Array<http.Server> = [];
const sockets = new Set<net.Socket>();
const temps: string[] = [];

function track(server: http.Server): void {
  servers.push(server);
  server.on('connection', (s: net.Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('secureConnection', (s: net.Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
}

async function listen(server: http.Server, scheme = 'http'): Promise<{ url: string; port: number }> {
  track(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `${scheme}://127.0.0.1:${port}`, port };
}

async function serve(handler: Handler, tlsServer = false): Promise<TestServer> {
  const hits: http.IncomingMessage[] = [];
  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    hits.push(req);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString()));
  };
  const server = tlsServer ? https.createServer({ key: TEST_KEY, cert: TEST_CERT }, onRequest) : http.createServer(onRequest);
  const { url, port } = await listen(server, tlsServer ? 'https' : 'http');
  return { url, port, hits };
}

function fakeLookup(map: Record<string, string | string[]>, calls: string[] = []): typeof dns.lookup {
  return ((host: string, opts: dns.LookupOptions, cb: (...a: unknown[]) => void) => {
    calls.push(host);
    const found = map[host];
    if (!found) {
      process.nextTick(cb, Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
      return;
    }
    const list = (Array.isArray(found) ? found : [found]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    process.nextTick(() => (opts && opts.all ? cb(null, list) : cb(null, list[0].address, list[0].family)));
  }) as unknown as typeof dns.lookup;
}

async function rejectsCode(p: Promise<unknown>, code: string, msg?: RegExp): Promise<WebError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof WebError, `expected WebError, got ${e}`);
    assert.equal(e.code, code, e.message);
    if (msg) { assert.match(e.message, msg); }
    return e;
  }
  assert.fail(`expected WebError ${code}`);
}

const client = createHttpClient({ userAgent: 'ica-test/1.0', perHostRps: 0 });
const local = { allowPrivateAll: true };

after(async () => {
  for (const s of sockets) { s.destroy(); }
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const d of temps) { await fs.rm(d, { recursive: true, force: true }); }
});

describe('ssrf', () => {
  it('classifies private and public addresses', () => {
    const priv = [
      '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.0.9', '169.254.169.254', '172.16.0.1',
      '172.31.255.255', '192.0.0.8', '192.168.1.1', '198.18.0.1', '198.19.255.255', '224.0.0.1', '239.1.1.1', '240.0.0.1',
      '255.255.255.255', '::', '::1', '[::1]', 'fc00::1', 'fdff::1', 'fe80::1%eth0', 'febf::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:0:192.168.0.1', '64:ff9b::7f00:1', '64:ff9b::10.0.0.1',
      '2002:7f00:1::1', '2002:c0a8:101::', '::127.0.0.1',
      '2130706433', '0177.0.0.1', '0x7f.0.0.1', '0x7f000001', '127.1', '0', '012.0.0.1',
    ];
    const pub = [
      '8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '192.0.1.1', '198.17.0.1',
      '198.20.0.0', '223.255.255.255', '93.184.216.34', '2606:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8',
      '64:ff9b::808:808', '2002:808:808::1', 'example.com', 'not-an-ip', '1.2.3.4.5', '256.1.1.1',
    ];
    for (const ip of priv) { assert.equal(isPrivateIp(ip), true, ip); }
    for (const ip of pub) { assert.equal(isPrivateIp(ip), false, ip); }
  });

  it('normalises odd IPv4 spellings', () => {
    assert.equal(normalizeIpv4Literal('2130706433'), '127.0.0.1');
    assert.equal(normalizeIpv4Literal('0177.0.0.1'), '127.0.0.1');
    assert.equal(normalizeIpv4Literal('0x7f.0.0.1'), '127.0.0.1');
    assert.equal(normalizeIpv4Literal('127.1'), '127.0.0.1');
    assert.equal(normalizeIpv4Literal('10.1.258'), '10.1.1.2');
    assert.equal(normalizeIpv4Literal('8.8.8.8.'), '8.8.8.8');
    assert.equal(normalizeIpv4Literal('example.com'), undefined);
    assert.equal(normalizeIpv4Literal('1.2.3.256'), undefined);
    assert.equal(normalizeIpv4Literal('09.1.1.1'), undefined);
  });

  it('checkUrl rejects bad and private URLs and honours allowances', () => {
    const invalid = ['', 'not a url', 'ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)'];
    for (const u of invalid) { assert.throws(() => checkUrl(u), (e: WebError) => e.code === 'invalid_url', u); }
    const blocked = [
      'http://user:pw@example.com/', 'http://localhost/', 'http://LOCALHOST.:8080/', 'http://app.localhost/', 'http://printer.local/',
      'http://metadata.google.internal/computeMetadata/v1/', 'http://metadata/', 'http://db.internal/', 'http://127.0.0.1/',
      'http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f.1/', 'http://127.1:81/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
      'http://169.254.169.254/latest/meta-data/', 'https://10.0.0.5:8443/', 'http://[fe80::1]/', 'http://[64:ff9b::a00:1]/',
    ];
    for (const u of blocked) { assert.throws(() => checkUrl(u), (e: WebError) => e.code === 'blocked', u); }
    assert.equal(checkUrl('  https://example.com:8443/a?b=1#c ').port, '8443');
    assert.equal(checkUrl('http://8.8.8.8/').hostname, '8.8.8.8');
    assert.equal(checkUrl('http://127.0.0.1:9/', { allowPrivateAll: true }).hostname, '127.0.0.1');
    assert.equal(checkUrl('http://wiki.corp.local/', { allowPrivateHosts: ['*.corp.local'] }).hostname, 'wiki.corp.local');
    assert.equal(checkUrl('http://10.0.0.5/', { allowPrivateHosts: ['10.0.0.5'] }).hostname, '10.0.0.5');
    assert.throws(() => checkUrl('http://other.local/', { allowPrivateHosts: ['*.corp.local'] }), (e: WebError) => e.code === 'blocked');
    assert.throws(() => checkUrl('http://u:p@127.0.0.1/', { allowPrivateAll: true }), (e: WebError) => e.code === 'blocked');
  });

  it('hostMatches and assertPublicAddress', () => {
    assert.ok(hostMatches('Docs.Example.com', ['docs.example.com']));
    assert.ok(hostMatches('example.com', ['*.example.com']));
    assert.ok(hostMatches('a.b.example.com', ['*.example.com']));
    assert.ok(!hostMatches('badexample.com', ['*.example.com']));
    assert.ok(!hostMatches('example.com', []));
    assert.throws(() => assertPublicAddress('x.example.com', '10.0.0.1'), (e: WebError) => e.code === 'blocked');
    assert.doesNotThrow(() => assertPublicAddress('x.example.com', '10.0.0.1', { allowPrivateHosts: ['*.example.com'] }));
    assert.doesNotThrow(() => assertPublicAddress('x.example.com', '93.184.216.34'));
  });
});

describe('http client', () => {
  it('returns status, lower-cased joined headers, content type and charset; sends default headers', async () => {
    const s = await serve((req, res) => {
      res.setHeader('Content-Type', 'Text/HTML; Charset="ISO-8859-1"');
      res.setHeader('X-Multi', ['a', 'b']);
      res.setHeader('Set-Cookie', 'sid=1');
      res.statusCode = 404;
      res.end(JSON.stringify(req.headers));
    });
    const r = await client(`${s.url}/missing`, { ...local, headers: { 'accept-language': 'de-DE' } });
    assert.equal(r.status, 404);
    assert.equal(r.contentType, 'text/html');
    assert.equal(r.charset, 'iso-8859-1');
    assert.equal(r.headers['x-multi'], 'a, b');
    assert.equal(r.headers['set-cookie'], undefined);
    const sent = JSON.parse(r.body.toString());
    assert.equal(sent['user-agent'], 'ica-test/1.0');
    assert.equal(sent['accept-encoding'], 'gzip, deflate, br');
    assert.equal(sent['accept-language'], 'de-DE');
    assert.match(sent.accept, /text\/html/);
    assert.deepEqual(r.redirects, []);
    assert.ok(r.ms >= 0);
  });

  it('follows redirects, drops credentials across origins and turns 303 into GET', async () => {
    const other = await serve((req, res) => res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null })));
    const s = await serve((req, res, body) => {
      if (req.url === '/a') { res.writeHead(302, { Location: '/b' }); res.end(); return; }
      if (req.url === '/b') { res.writeHead(301, { Location: `${other.url}/c` }); res.end(); return; }
      if (req.url === '/post') { res.writeHead(303, { Location: '/echo' }); res.end(); return; }
      if (req.url === '/post307') { res.writeHead(307, { Location: '/echo' }); res.end(); return; }
      res.end(JSON.stringify({ method: req.method, body, auth: req.headers.authorization ?? null }));
    });
    const r = await client(`${s.url}/a`, { ...local, headers: { Authorization: 'Bearer t', Cookie: 'k=v' } });
    assert.deepEqual(r.redirects, [`${s.url}/a`, `${s.url}/b`]);
    assert.equal(r.url, `${other.url}/c`);
    assert.deepEqual(JSON.parse(r.body.toString()), { method: 'GET', auth: null, cookie: null });
    assert.equal(s.hits[1].headers.authorization, 'Bearer t', 'same-origin hop keeps Authorization');

    const p = await client(`${s.url}/post`, { ...local, method: 'POST', body: 'x=1', headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' } });
    assert.deepEqual(JSON.parse(p.body.toString()), { method: 'GET', body: '', auth: 'Bearer t' });
    const p7 = await client(`${s.url}/post307`, { ...local, method: 'POST', body: 'x=1' });
    assert.deepEqual(JSON.parse(p7.body.toString()), { method: 'POST', body: 'x=1', auth: null });
  });

  it('fails after too many redirects', async () => {
    const s = await serve((_req, res) => { res.writeHead(302, { Location: '/loop' }); res.end(); });
    await rejectsCode(client(`${s.url}/loop`, { ...local, maxRedirects: 2 }), 'http', /too many redirects/);
    assert.equal(s.hits.length, 3);
  });

  it('decodes gzip, br, zlib deflate and raw deflate', async () => {
    const text = 'hello compressed world '.repeat(200);
    const s = await serve((req, res) => {
      const enc = req.url!.slice(1);
      const data = enc === 'gzip' ? zlib.gzipSync(text) : enc === 'br' ? zlib.brotliCompressSync(text)
        : enc === 'deflate' ? zlib.deflateSync(text) : zlib.deflateRawSync(text);
      res.writeHead(200, { 'Content-Encoding': enc === 'raw' ? 'deflate' : enc, 'Content-Type': 'text/plain' });
      res.end(data);
    });
    for (const enc of ['gzip', 'br', 'deflate', 'raw']) {
      const r = await client(`${s.url}/${enc}`, local);
      assert.equal(r.body.toString(), text, enc);
      assert.equal(r.truncated, false);
    }
  });

  it('caps the decompressed size of a gzip bomb without failing', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024));
    const s = await serve((_req, res) => { res.writeHead(200, { 'Content-Encoding': 'gzip' }); res.end(bomb); });
    const r = await client(s.url, { ...local, maxBytes: 100_000 });
    assert.equal(r.truncated, true);
    assert.equal(r.body.length, 100_000);
    const plain = await serve((_req, res) => res.end('x'.repeat(5000)));
    const p = await client(plain.url, { ...local, maxBytes: 5000 });
    assert.equal(p.truncated, false);
    assert.equal(p.body.length, 5000);
  });

  it('times out across the whole request and honours abort', async () => {
    const s = await serve(() => { /* never answers */ });
    const t0 = Date.now();
    await rejectsCode(client(s.url, { ...local, timeoutMs: 150 }), 'timeout');
    assert.ok(Date.now() - t0 < 2000);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    await rejectsCode(client(s.url, { ...local, signal: ctl.signal }), 'aborted');
    const pre = new AbortController();
    pre.abort();
    await rejectsCode(client(s.url, { ...local, signal: pre.signal }), 'aborted');
    const slow = await serve((_req, res) => { res.writeHead(200); res.write('partial'); });
    await rejectsCode(client(slow.url, { ...local, timeoutMs: 150 }), 'timeout');
  });

  it('reports refused connections clearly', async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    await rejectsCode(client(`http://127.0.0.1:${port}/`, local), 'network', /refused/);
    const named = createHttpClient({ userAgent: 't', perHostRps: 0 }, { lookup: fakeLookup({}) });
    await rejectsCode(named('http://nowhere.example.com/'), 'network', /could not resolve host nowhere\.example\.com/);
  });

  it('blocks private targets: literal, via redirect, and via DNS answers', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/to-localhost') { res.writeHead(302, { Location: `http://localhost:${s.port}/` }); res.end(); return; }
      if (req.url === '/to-decimal') { res.writeHead(302, { Location: `http://2130706434:${s.port}/` }); res.end(); return; }
      if (req.url === '/to-hex') { res.writeHead(302, { Location: `http://0x7f.0.0.3:${s.port}/` }); res.end(); return; }
      res.end('secret');
    });
    await rejectsCode(client(s.url), 'blocked');
    assert.equal(s.hits.length, 0);
    const allowed = { allowPrivateHosts: ['127.0.0.1'] };
    assert.equal((await client(`${s.url}/`, allowed)).body.toString(), 'secret');
    await rejectsCode(client(`${s.url}/to-localhost`, allowed), 'blocked');
    await rejectsCode(client(`${s.url}/to-decimal`, allowed), 'blocked');
    await rejectsCode(client(`${s.url}/to-hex`, allowed), 'blocked');
    assert.equal(s.hits.length, 4);

    const calls: string[] = [];
    const rebind = createHttpClient({ userAgent: 't', perHostRps: 0 }, {
      lookup: fakeLookup({ 'rebind.example.com': '127.0.0.1', 'mixed.example.com': ['93.184.216.34', '127.0.0.1'], 'v6.example.com': '::ffff:127.0.0.1' }, calls),
    });
    await rejectsCode(rebind(`http://rebind.example.com:${s.port}/`), 'blocked', /resolves to private address 127\.0\.0\.1/);
    await rejectsCode(rebind(`http://mixed.example.com:${s.port}/`), 'blocked');
    await rejectsCode(rebind(`http://v6.example.com:${s.port}/`), 'blocked');
    assert.equal(s.hits.length, 4, 'no request reached the server');
    assert.deepEqual(calls, ['rebind.example.com', 'mixed.example.com', 'v6.example.com']);
    const ok = await rebind(`http://rebind.example.com:${s.port}/`, { allowPrivateHosts: ['*.example.com'] });
    assert.equal(ok.body.toString(), 'secret');
  });

  it('pins the connection to the vetted address (resolver asked once per hop)', async () => {
    const s = await serve((_req, res) => res.end('pinned'));
    const calls: string[] = [];
    let n = 0;
    // Rebinding resolver: a public (unroutable TEST-NET) address for the vetting lookup, loopback afterwards.
    const flipping = ((host: string, opts: dns.LookupOptions, cb: (...a: unknown[]) => void) => {
      calls.push(host);
      const address = n++ === 0 ? '192.0.2.1' : '127.0.0.1';
      process.nextTick(() => (opts && opts.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4)));
    }) as unknown as typeof dns.lookup;
    const c = createHttpClient({ userAgent: 't', perHostRps: 0 }, { lookup: flipping });
    await assert.rejects(c(`http://pin.example.com:${s.port}/`, { timeoutMs: 300 }), (e: WebError) => e.code === 'timeout' || e.code === 'network');
    assert.deepEqual(calls, ['pin.example.com']);
    assert.equal(s.hits.length, 0, 'the socket never reached loopback');
  });

  it('retries once after a short Retry-After on 429', async () => {
    let first = true;
    const s = await serve((_req, res) => {
      if (first) { first = false; res.writeHead(429, { 'Retry-After': '0' }); res.end('slow down'); return; }
      res.end('ok');
    });
    const r = await client(s.url, local);
    assert.equal(r.status, 200);
    assert.equal(s.hits.length, 2);
    const always = await serve((_req, res) => { res.writeHead(503, { 'Retry-After': '120' }); res.end(); });
    assert.equal((await client(always.url, local)).status, 503);
    assert.equal(always.hits.length, 1);
  });

  it('spaces requests to one host by perHostRps', async () => {
    const s = await serve((_req, res) => res.end('x'));
    const limited = createHttpClient({ userAgent: 't', perHostRps: 20 });
    const t0 = Date.now();
    await Promise.all([1, 2, 3, 4].map(() => limited(s.url, local)));
    assert.ok(Date.now() - t0 >= 140, `elapsed ${Date.now() - t0}`);
  });

  it('sends absolute-URI requests to an explicit http proxy with credentials', async () => {
    const target = await serve((req, res) => res.end(`target saw ${req.url}`));
    const seen: Array<{ url?: string; auth?: string; host?: string }> = [];
    const proxy = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers['proxy-authorization'], host: req.headers.host });
      const u = new URL(req.url!);
      const up = http.request({ host: '127.0.0.1', port: target.port, path: `${u.pathname}${u.search}`, method: req.method, headers: req.headers }, (ur) => {
        res.writeHead(ur.statusCode!, ur.headers);
        ur.pipe(res);
      });
      req.pipe(up);
    });
    const { port } = await listen(proxy);
    const c = createHttpClient({ userAgent: 't', perHostRps: 0, proxy: `http://bob:s%40cret@127.0.0.1:${port}` }, { lookup: fakeLookup({}) });
    const r = await c(`http://origin.example.com:${target.port}/page?q=1`);
    assert.equal(r.body.toString(), 'target saw /page?q=1');
    assert.equal(seen[0].url, `http://origin.example.com:${target.port}/page?q=1`);
    assert.equal(seen[0].auth, `Basic ${Buffer.from('bob:s@cret').toString('base64')}`);
    assert.equal(seen[0].host, `origin.example.com:${target.port}`);
    // Locally resolvable private target is still refused even through the proxy.
    const c2 = createHttpClient({ userAgent: 't', perHostRps: 0, proxy: `http://127.0.0.1:${port}` }, { lookup: fakeLookup({ 'intra.example.com': '10.0.0.7' }) });
    await rejectsCode(c2('http://intra.example.com/'), 'blocked');
    await rejectsCode(c2('http://127.0.0.1/'), 'blocked');
    // noProxy hosts go direct (the proxy setting points at a dead port here).
    const direct = createHttpClient({ userAgent: 't', perHostRps: 0, proxy: 'http://127.0.0.1:1', noProxy: ['127.0.0.1'] });
    assert.equal((await direct(`${target.url}/d`, local)).body.toString(), 'target saw /d');
  });

  it('tunnels https through CONNECT and applies the TLS settings', async () => {
    const target = await serve((req, res) => res.end(`secure ${req.url}`), true);
    const connects: string[] = [];
    const proxy = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
    proxy.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
      connects.push(String(req.url));
      sockets.add(client);
      const up = net.connect(target.port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        up.write(head);
        up.pipe(client);
        client.pipe(up);
      });
      sockets.add(up);
      up.on('error', () => client.destroy());
      client.on('error', () => up.destroy());
    });
    const { port } = await listen(proxy);
    const proxyUrl = `http://127.0.0.1:${port}`;
    const selfSigned = createHttpClient({ userAgent: 't', perHostRps: 0, proxy: proxyUrl, allowSelfSigned: true }, { lookup: fakeLookup({}) });
    const r = await selfSigned(`https://secure.example.com:${target.port}/x`);
    assert.equal(r.body.toString(), 'secure /x');
    assert.equal(connects[0], `secure.example.com:${target.port}`);

    const strict = createHttpClient({ userAgent: 't', perHostRps: 0, proxy: proxyUrl }, { lookup: fakeLookup({}) });
    await rejectsCode(strict(`https://secure.example.com:${target.port}/`), 'network', /extraCaPem/);

    const withCa = createHttpClient({ userAgent: 't', perHostRps: 0, proxy: proxyUrl, extraCaPem: TEST_CERT });
    assert.equal((await withCa(`https://localhost:${target.port}/ca`, local)).body.toString(), 'secure /ca');
    const directCa = createHttpClient({ userAgent: 't', perHostRps: 0, extraCaPem: TEST_CERT });
    assert.equal((await directCa(`${target.url}/direct`, local)).body.toString(), 'secure /direct');
  });
});

describe('web cache', () => {
  async function newCache(opts?: ConstructorParameters<typeof WebCache>[1]): Promise<WebCache> {
    const dir = await tmpDir('ica-webcache-');
    temps.push(dir);
    return new WebCache(path.join(dir, 'cache'), opts);
  }

  it('serves fresh hits from cache and dedupes concurrent fetches', async () => {
    const s = await serve((_req, res) => { setTimeout(() => res.end('page'), 30); });
    const cache = await newCache();
    const [a, b] = await Promise.all([cachedFetch(client, cache, s.url, local), cachedFetch(client, cache, s.url, local)]);
    assert.equal(a.body.toString(), 'page');
    assert.equal(b.body.toString(), 'page');
    assert.equal(s.hits.length, 1);
    const c = await cachedFetch(client, cache, `${s.url}/#frag`, local);
    assert.equal(c.fromCache, true);
    assert.equal(c.body.toString(), 'page');
    assert.equal(s.hits.length, 1);
    assert.equal(c.sha256, a.sha256);
    assert.deepEqual(await cache.stats(), { entries: 1, bytes: 4 });
    assert.equal((await cache.entries())[0].url, s.url);
  });

  it('revalidates stale entries with ETag and serves 304 from cache', async () => {
    const s = await serve((req, res) => {
      if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304, { ETag: '"v1"' }); res.end(); return; }
      res.writeHead(200, { ETag: '"v1"', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('body v1');
    });
    const cache = await newCache();
    const first = await cachedFetch(client, cache, s.url, local);
    assert.equal(first.fromCache, false);
    const second = await cachedFetch(client, cache, s.url, { ...local, ttlMs: 0 });
    assert.equal(s.hits.length, 2);
    assert.equal(s.hits[1].headers['if-none-match'], '"v1"');
    assert.equal(second.revalidated, true);
    assert.equal(second.fromCache, true);
    assert.equal(second.status, 200);
    assert.equal(second.body.toString(), 'body v1');
    assert.equal(second.charset, 'utf-8');
    assert.ok(second.fetchedAt >= first.fetchedAt);
  });

  it('never stores no-store responses or non-200 statuses', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/gone') { res.writeHead(404); res.end('nope'); return; }
      res.writeHead(200, { 'Cache-Control': 'private, no-store' });
      res.end('secret');
    });
    const cache = await newCache();
    await cachedFetch(client, cache, s.url, local);
    await cachedFetch(client, cache, s.url, local);
    await cachedFetch(client, cache, `${s.url}/gone`, local);
    await cachedFetch(client, cache, `${s.url}/gone`, local);
    assert.equal(s.hits.length, 4);
    assert.equal((await cache.stats()).entries, 0);
  });

  it('respects max-age and records a snapshot when the content changes', async () => {
    let version = 1;
    const s = await serve((req, res) => {
      res.writeHead(200, req.url === '/aged' ? { 'Cache-Control': 'max-age=0' } : {});
      res.end(`version ${version}`);
    });
    const cache = await newCache();
    await cachedFetch(client, cache, `${s.url}/aged`, local);
    await cachedFetch(client, cache, `${s.url}/aged`, local);
    assert.equal(s.hits.length, 2, 'max-age=0 makes the entry stale at once');

    await cachedFetch(client, cache, s.url, local);
    version = 2;
    const same = await cachedFetch(client, cache, s.url, local);
    assert.equal(same.body.toString(), 'version 1', 'fresh under default TTL');
    const changed = await cachedFetch(client, cache, s.url, { ...local, refresh: true });
    assert.equal(changed.body.toString(), 'version 2');
    await cachedFetch(client, cache, s.url, { ...local, refresh: true });
    const snaps = await cache.snapshots(s.url);
    assert.equal(snaps.length, 2);
    assert.equal((await cache.readSnapshot(snaps[0].sha256))?.toString(), 'version 2');
    assert.equal((await cache.readSnapshot(snaps[1].sha256))?.toString(), 'version 1');
    assert.equal(await cache.readSnapshot('../../etc/passwd'), undefined);
  });

  it('offline mode serves stale entries and fails on a miss', async () => {
    const s = await serve((_req, res) => res.end('kept'));
    const cache = await newCache({ defaultTtlMs: 0 });
    await cachedFetch(client, cache, s.url, local);
    const off = await cachedFetch(client, cache, s.url, { ...local, offline: true });
    assert.equal(off.fromCache, true);
    assert.equal(off.body.toString(), 'kept');
    await rejectsCode(cachedFetch(client, cache, `${s.url}/other`, { ...local, offline: true }), 'network', /offline mode: not in cache/);
    assert.equal(s.hits.length, 1);
  });

  it('evicts least-recently-used entries and their blobs over the byte budget; corrupt entries are misses', async () => {
    const cache = await newCache({ maxBytes: 250 });
    const entry = (url: string, body: Buffer) => ({ url, finalUrl: url, status: 200, contentType: 'text/plain', fetchedAt: Date.now(), sha256: '', size: body.length });
    const bodies = ['a', 'b', 'c'].map((ch) => Buffer.alloc(100, ch));
    await cache.put('https://e.example/1', entry('https://e.example/1', bodies[0]), bodies[0]);
    await new Promise((r) => setTimeout(r, 5));
    await cache.put('https://e.example/2', entry('https://e.example/2', bodies[1]), bodies[1]);
    await new Promise((r) => setTimeout(r, 5));
    await cache.put('https://e.example/3', entry('https://e.example/3', bodies[2]), bodies[2]);
    assert.equal(await cache.get('https://e.example/1'), undefined);
    assert.ok(await cache.get('https://e.example/2'));
    assert.ok(await cache.get('https://e.example/3'));
    assert.deepEqual(await cache.stats(), { entries: 2, bytes: 200 });
    const shaA = (await import('crypto')).createHash('sha256').update(bodies[0]).digest('hex');
    assert.equal(await cache.readSnapshot(shaA), undefined, 'evicted blob deleted');

    const file = path.join((cache as unknown as { dir: string }).dir, 'entries', `${WebCache.key('https://e.example/2')}.json`);
    await fs.writeFile(file, '{ not json');
    assert.equal(await cache.get('https://e.example/2'), undefined);
    await cache.clear();
    assert.deepEqual(await cache.entries(), []);
  });

  it('variants are separate entries and keys ignore fragments', async () => {
    assert.equal(WebCache.key('https://a.example/x#y'), WebCache.key('https://a.example/x'));
    assert.notEqual(WebCache.key('https://a.example/x', 'md'), WebCache.key('https://a.example/x'));
    const cache = await newCache();
    const body = Buffer.from('v');
    await cache.put('https://a.example/x', { url: 'https://a.example/x', finalUrl: 'https://a.example/x', status: 200, contentType: '', fetchedAt: Date.now(), sha256: '', size: 1 }, body, 'md');
    assert.equal(await cache.get('https://a.example/x'), undefined);
    assert.equal((await cache.get('https://a.example/x', 'md'))?.body.toString(), 'v');
  });
});
