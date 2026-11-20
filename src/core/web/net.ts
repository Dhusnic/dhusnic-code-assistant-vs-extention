import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import * as zlib from 'zlib';
import { Transform } from 'stream';
import {
  DEFAULT_MAX_BYTES, DEFAULT_MAX_REDIRECTS, DEFAULT_TIMEOUT_MS, FetchOptions, FetchResponse, HttpFetch, NetConfig, WebError,
} from './types';
import { assertPublicAddress, bareHost, checkUrl, hostMatches, PrivateAccessOptions } from './ssrf';

/**
 * The one HTTP client of the web subsystem. Everything the agent downloads goes through it so the safety rules
 * (SSRF checks on every hop with DNS pinning, size and time caps, rate limits) cannot be bypassed by a caller.
 */

export interface HttpClientDeps {
  /** DNS resolver; injectable so tests can simulate rebinding. */
  lookup?: typeof dns.lookup;
  now?: () => number;
}

/** Extra information on responses from this client beyond the shared contract. */
export interface NetFetchResponse extends FetchResponse {
  /** A redirect went from https to http. */
  downgraded?: boolean;
}

const DEFAULT_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,application/json;q=0.9,*/*;q=0.8';
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_RETRY_AFTER_MS = 10_000;
const CERT_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED', 'CERT_REJECTED', 'CERT_SIGNATURE_FAILURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'HOSTNAME_MISMATCH',
]);

interface Hop {
  url: URL;
  method: string;
  headers: Map<string, [string, string]>;
  body?: Buffer;
}

interface ProxyInfo { host: string; port: number; auth?: string }

/** Everything opened during one fetch, destroyed together on abort and at the end. */
class Resources {
  private items = new Set<{ destroy(err?: Error): unknown }>();
  add<T extends { destroy(err?: Error): unknown }>(x: T): T { this.items.add(x); return x; }
  destroyAll(err?: Error): void {
    for (const x of this.items) { try { x.destroy(err); } catch { /* already gone */ } }
    this.items.clear();
  }
}

function parseProxy(raw: string | undefined): ProxyInfo | undefined {
  const s = (raw ?? '').trim();
  if (!s) { return undefined; }
  let u: URL;
  try { u = new URL(s.includes('://') ? s : `http://${s}`); } catch { throw new WebError(`invalid proxy setting: ${s}`, 'invalid_url'); }
  if (u.protocol !== 'http:') { throw new WebError(`only http:// proxies are supported (got ${u.protocol})`, 'invalid_url'); }
  const auth = u.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`
    : undefined;
  return { host: u.hostname.replace(/^\[(.*)\]$/, '$1'), port: Number(u.port) || 80, auth };
}

function setHeader(h: Map<string, [string, string]>, name: string, value: string): void {
  h.set(name.toLowerCase(), [name, value]);
}

function headerObject(h: Map<string, [string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of h.values()) { out[name] = value; }
  return out;
}

function responseHeaders(res: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = res.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    if (name === 'set-cookie') { continue; }
    out[name] = name in out ? `${out[name]}, ${raw[i + 1]}` : raw[i + 1];
  }
  return out;
}

/** Splits a Content-Type header into the bare MIME type and its charset. */
export function parseContentType(value: string | undefined): { contentType: string; charset?: string } {
  if (!value) { return { contentType: '' }; }
  const contentType = value.split(';')[0].trim().toLowerCase();
  const m = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(value);
  return m ? { contentType, charset: m[1].toLowerCase() } : { contentType };
}

/** Retry-After as milliseconds (seconds or HTTP date); undefined when absent or unparseable. */
function retryAfterMs(value: string | undefined, now: number): number | undefined {
  if (!value) { return undefined; }
  const v = value.trim();
  if (/^\d+$/.test(v)) { return Number(v) * 1000; }
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

function describeNetError(err: NodeJS.ErrnoException, url: URL, viaProxy?: ProxyInfo): WebError {
  if (err instanceof WebError) { return err; }
  const host = bareHost(url);
  const code = err.code ?? '';
  const where = viaProxy ? ` (via proxy ${viaProxy.host}:${viaProxy.port})` : '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA' || code === 'EAI_NONAME') {
    return new WebError(`could not resolve host ${host}${where}`, 'network');
  }
  if (code === 'ECONNREFUSED') { return new WebError(`connection refused by ${viaProxy ? `proxy ${viaProxy.host}:${viaProxy.port}` : url.host}`, 'network'); }
  if (code === 'ECONNRESET' || err.message === 'socket hang up') { return new WebError(`connection reset by ${url.host}${where}`, 'network'); }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') { return new WebError(`connection to ${url.host} timed out${where}`, 'network'); }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') { return new WebError(`network unreachable for ${url.host}${where}`, 'network'); }
  if (CERT_CODES.has(code) || /certificate/i.test(err.message)) {
    return new WebError(
      `TLS certificate of ${host} was rejected (${code || err.message}). If your network inspects TLS traffic (corporate proxy), `
      + 'add its CA certificate to the extraCaPem web setting, or enable allowSelfSigned (less safe).',
      'network',
    );
  }
  return new WebError(`request to ${url.host} failed${where}: ${err.message}`, 'network');
}

function lookupAll(lookup: typeof dns.lookup, host: string): Promise<dns.LookupAddress[]> {
  return new Promise((resolve, reject) => {
    (lookup as (h: string, o: dns.LookupAllOptions, cb: (e: NodeJS.ErrnoException | null, a: dns.LookupAddress[]) => void) => void)(
      host, { all: true }, (err, addresses) => {
        if (err) { reject(err); return; }
        resolve(Array.isArray(addresses) ? addresses : []);
      },
    );
  });
}

/** A `lookup` that always answers with the address already vetted, defeating DNS rebinding between check and connect. */
function pinnedLookup(address: string, family: number): net.LookupFunction {
  return ((_host: string, options: dns.LookupOptions, cb: (...args: unknown[]) => void) => {
    if (options && options.all) { cb(null, [{ address, family }]); } else { cb(null, address, family); }
  }) as unknown as net.LookupFunction;
}

/** Rejects with `signal.reason` when aborted; the promise settles exactly once and leaves no listener behind. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) { return signal.aborted ? Promise.reject(signal.reason) : Promise.resolve(); }
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Drops a response we will not read (retry, redirect) without risking an unhandled stream error. */
function discard(res: http.IncomingMessage): void {
  res.on('error', () => { /* discarded */ });
  res.destroy();
}

/** Picks the decoder for a Content-Encoding; `deflate` is sniffed because servers send both zlib-wrapped and raw. */
function decoderFor(encoding: string, first: Buffer): Transform | undefined {
  const flush = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
  if (encoding === 'gzip' || encoding === 'x-gzip') { return zlib.createGunzip(flush); }
  if (encoding === 'br') { return zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }); }
  if (encoding === 'deflate') {
    const zlibHeader = first.length >= 2 && (first[0] & 0x0f) === 8 && ((first[0] << 8) | first[1]) % 31 === 0;
    return zlibHeader ? zlib.createInflate(flush) : zlib.createInflateRaw(flush);
  }
  return undefined;
}

/**
 * Reads the body, decoding as it goes, and stops at `maxBytes` of DECODED output so a small compressed bomb
 * cannot exhaust memory. Truncation is reported, not thrown.
 */
function readBody(res: http.IncomingMessage, maxBytes: number, signal: AbortSignal, resources: Resources): Promise<{ body: Buffer; truncated: boolean }> {
  const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    let decoder: Transform | undefined;
    let decided = false;

    const finish = (err?: unknown, truncated = false) => {
      if (done) { return; }
      done = true;
      signal.removeEventListener('abort', onAbort);
      if (err !== undefined) {
        res.destroy();
        decoder?.destroy();
        reject(err);
        return;
      }
      if (truncated) { res.destroy(); decoder?.destroy(); }
      resolve({ body: Buffer.concat(chunks, total), truncated });
    };
    const onAbort = () => finish(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });

    const take = (chunk: Buffer) => {
      if (done) { return; }
      if (total + chunk.length > maxBytes) {
        const room = maxBytes - total;
        if (room > 0) { chunks.push(chunk.subarray(0, room)); total += room; }
        finish(undefined, true);
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    };

    const end = () => finish();
    res.on('data', (chunk: Buffer) => {
      if (done) { return; }
      if (!decided) {
        decided = true;
        decoder = decoderFor(encoding, chunk);
        if (decoder) {
          resources.add(decoder);
          decoder.on('data', take);
          decoder.on('end', end);
          decoder.on('error', (e: Error) => finish(new WebError(`could not decode ${encoding} response body: ${e.message}`, 'parse')));
        }
      }
      if (decoder) { decoder.write(chunk); } else { take(chunk); }
    });
    res.on('end', () => {
      if (done) { return; }
      if (decoder) { decoder.end(); } else { end(); }
    });
    res.on('error', (e) => finish(e));
    res.on('close', () => {
      if (!done && !res.complete) { finish(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })); }
    });
  });
}

/**
 * Builds the HTTP client used by every web tool. Each call validates the URL and every redirect hop, resolves DNS
 * itself and pins the socket to the vetted address, caps time and decoded size, and spaces requests per host.
 */
export function createHttpClient(cfg: NetConfig, deps: HttpClientDeps = {}): HttpFetch {
  const lookup = deps.lookup ?? dns.lookup;
  const now = deps.now ?? Date.now;
  const proxy = parseProxy(cfg.proxy);
  const ca = cfg.extraCaPem?.trim() ? [...tls.rootCertificates, cfg.extraCaPem] : undefined;
  const rejectUnauthorized = !cfg.allowSelfSigned;
  const rps = cfg.perHostRps ?? 4;
  const interval = rps > 0 ? 1000 / rps : 0;
  const nextSlot = new Map<string, number>();

  /** Waits for this host's next slot instead of failing: the agent may burst several fetches to one site. */
  async function throttle(host: string, signal: AbortSignal): Promise<void> {
    if (!interval) { return; }
    const t = now();
    if (nextSlot.size > 1000) { for (const [h, s] of nextSlot) { if (s < t) { nextSlot.delete(h); } } }
    const slot = Math.max(t, nextSlot.get(host) ?? 0);
    nextSlot.set(host, slot + interval);
    await sleep(slot - t, signal);
  }

  function tlsOptions(url: URL): tls.ConnectionOptions {
    const host = bareHost(url);
    return { rejectUnauthorized, ca, servername: net.isIP(host) ? undefined : host };
  }

  /** Opens an HTTP CONNECT tunnel through the proxy and starts TLS to the target inside it. */
  function tunnel(url: URL, p: ProxyInfo, res: Resources): Promise<tls.TLSSocket> {
    const host = bareHost(url);
    const port = Number(url.port) || 443;
    const target = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { Host: target };
      if (p.auth) { headers['Proxy-Authorization'] = p.auth; }
      const req = res.add(http.request({ host: p.host, port: p.port, method: 'CONNECT', path: target, headers, agent: false }));
      req.once('connect', (pres, socket) => {
        res.add(socket);
        socket.on('error', () => { /* surfaced through the TLS socket */ });
        if (pres.statusCode !== 200) {
          socket.destroy();
          reject(new WebError(`proxy ${p.host}:${p.port} refused the tunnel to ${target} (HTTP ${pres.statusCode})`, 'network', pres.statusCode));
          return;
        }
        const sock = res.add(tls.connect({ ...tlsOptions(url), socket }));
        sock.once('secureConnect', () => { sock.removeListener('error', reject); resolve(sock); });
        sock.once('error', reject);
      });
      req.once('error', reject);
      req.end();
    });
  }

  async function send(hop: Hop, opts: FetchOptions, signal: AbortSignal, res: Resources): Promise<http.IncomingMessage> {
    const { url } = hop;
    const host = bareHost(url);
    const access: PrivateAccessOptions = { allowPrivateAll: opts.allowPrivateAll, allowPrivateHosts: opts.allowPrivateHosts };
    const checked = !opts.allowPrivateAll && !hostMatches(host, opts.allowPrivateHosts ?? []);
    const viaProxy = proxy && !hostMatches(host, cfg.noProxy ?? []) ? proxy : undefined;
    const isHttps = url.protocol === 'https:';
    const port = Number(url.port) || (isHttps ? 443 : 80);
    const headers = headerObject(hop.headers);
    let pin: net.LookupFunction | undefined;

    if (checked && !net.isIP(host)) {
      let addrs: dns.LookupAddress[] | undefined;
      try {
        addrs = await abortable(lookupAll(lookup, host), signal);
      } catch (e) {
        if (signal.aborted) { throw e; }
        // Behind a proxy the local resolver often knows nothing; the proxy resolves, so only name checks apply.
        if (!viaProxy) { throw describeNetError(e as NodeJS.ErrnoException, url); }
      }
      if (addrs) {
        if (!addrs.length) { throw new WebError(`could not resolve host ${host}`, 'network'); }
        for (const a of addrs) { assertPublicAddress(host, a.address, access); }
        pin = pinnedLookup(addrs[0].address, addrs[0].family);
      }
    } else if (!checked && deps.lookup) {
      pin = deps.lookup as unknown as net.LookupFunction;
    }

    return new Promise<http.IncomingMessage>((resolve, reject) => {
      const onError = (e: Error) => reject(signal.aborted ? signal.reason : describeNetError(e, url, viaProxy));
      const start = (req: http.ClientRequest) => {
        res.add(req);
        req.once('response', resolve);
        req.on('error', onError);
        req.end(hop.body);
      };
      const path = `${url.pathname}${url.search}`;
      if (viaProxy && !isHttps) {
        const h: Record<string, string> = { ...headers, Host: url.host };
        if (viaProxy.auth) { h['Proxy-Authorization'] = viaProxy.auth; }
        start(http.request({ host: viaProxy.host, port: viaProxy.port, method: hop.method, path: url.href, headers: h, agent: false }));
      } else if (viaProxy) {
        tunnel(url, viaProxy, res).then(
          (sock) => {
            // `agent: false` would make Node build a fresh default Agent that ignores `createConnection`.
            const agent = res.add(new http.Agent());
            agent.createConnection = () => sock;
            start(http.request({ host, port, method: hop.method, path, headers: { ...headers, Host: url.host }, agent }));
          },
          onError,
        );
      } else if (isHttps) {
        start(https.request({ host, port, method: hop.method, path, headers, agent: false, lookup: pin, ...tlsOptions(url) }));
      } else {
        start(http.request({ host, port, method: hop.method, path, headers, agent: false, lookup: pin }));
      }
    });
  }

  return async function fetch(rawUrl: string, opts: FetchOptions = {}): Promise<NetFetchResponse> {
    const startedAt = now();
    const access: PrivateAccessOptions = { allowPrivateAll: opts.allowPrivateAll, allowPrivateHosts: opts.allowPrivateHosts };
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    let current = checkUrl(rawUrl, access);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new WebError(`request to ${current.host} timed out after ${timeoutMs} ms`, 'timeout')), timeoutMs);
    const onCallerAbort = () => ctl.abort(new WebError('request aborted', 'aborted'));
    if (opts.signal?.aborted) { onCallerAbort(); } else { opts.signal?.addEventListener('abort', onCallerAbort, { once: true }); }
    const resources = new Resources();
    const onAbort = () => resources.destroyAll();
    ctl.signal.addEventListener('abort', onAbort, { once: true });

    const headers = new Map<string, [string, string]>();
    setHeader(headers, 'User-Agent', cfg.userAgent);
    setHeader(headers, 'Accept', DEFAULT_ACCEPT);
    setHeader(headers, 'Accept-Language', 'en-US,en;q=0.8');
    setHeader(headers, 'Accept-Encoding', 'gzip, deflate, br');
    for (const [k, v] of Object.entries(opts.headers ?? {})) { setHeader(headers, k, String(v)); }
    const body = opts.body === undefined ? undefined : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body);
    if (body && !headers.has('content-length')) { setHeader(headers, 'Content-Length', String(body.length)); }
    const hop: Hop = { url: current, method: opts.method ?? 'GET', headers, body };
    const redirects: string[] = [];
    let downgraded = false;
    let retried = false;

    try {
      for (;;) {
        if (ctl.signal.aborted) { throw ctl.signal.reason; }
        await throttle(bareHost(current), ctl.signal);
        const res = await send(hop, opts, ctl.signal, resources);
        const status = res.statusCode ?? 0;

        if ((status === 429 || status === 503) && !retried) {
          const wait = retryAfterMs(String(res.headers['retry-after'] ?? ''), now());
          if (wait !== undefined && wait <= MAX_RETRY_AFTER_MS && now() + wait < startedAt + timeoutMs) {
            retried = true;
            discard(res);
            await sleep(wait, ctl.signal);
            continue;
          }
        }

        const location = res.headers.location;
        if (REDIRECT_CODES.has(status) && location) {
          discard(res);
          if (redirects.length >= maxRedirects) {
            throw new WebError(`too many redirects (more than ${maxRedirects}) starting at ${rawUrl}`, 'http', status);
          }
          let next: URL;
          try { next = new URL(location, current); } catch { throw new WebError(`invalid redirect target: ${location}`, 'invalid_url'); }
          next = checkUrl(next.href, access);
          if (status === 303 ? hop.method !== 'HEAD' : (status === 301 || status === 302) && hop.method === 'POST') {
            hop.method = 'GET';
            hop.body = undefined;
            for (const h of ['content-length', 'content-type', 'content-encoding']) { hop.headers.delete(h); }
          }
          if (next.origin !== current.origin) {
            hop.headers.delete('authorization');
            hop.headers.delete('cookie');
          }
          if (current.protocol === 'https:' && next.protocol === 'http:') { downgraded = true; }
          redirects.push(current.href);
          current = next;
          hop.url = next;
          continue;
        }

        const { body: data, truncated } = hop.method === 'HEAD'
          ? (res.resume(), { body: Buffer.alloc(0), truncated: false })
          : await readBody(res, maxBytes, ctl.signal, resources);
        const rh = responseHeaders(res);
        const out: NetFetchResponse = {
          url: current.href, status, headers: rh, body: data, ...parseContentType(rh['content-type']),
          truncated, redirects, ms: now() - startedAt,
        };
        if (downgraded) { out.downgraded = true; }
        return out;
      }
    } catch (e) {
      if (ctl.signal.aborted) { throw ctl.signal.reason; }
      throw e instanceof WebError ? e : describeNetError(e as NodeJS.ErrnoException, current, proxy);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onCallerAbort);
      ctl.signal.removeEventListener('abort', onAbort);
      resources.destroyAll();
    }
  };
}
