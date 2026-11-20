import * as net from 'net';
import { WebError } from './types';

/**
 * SSRF defence: the agent fetches URLs chosen by a model that may be steered by page content, so every URL and
 * every resolved address is vetted before a socket is opened. Private, loopback, link-local (cloud metadata),
 * multicast and reserved ranges are refused unless the user explicitly allowed the host.
 */

export interface PrivateAccessOptions {
  /** Host names (exact, or `*.suffix`) allowed although they are or resolve to private addresses. */
  allowPrivateHosts?: string[];
  /** Disables every private-address check (tests only). */
  allowPrivateAll?: boolean;
}

/** IPv4 ranges as [network, prefix length]. */
const PRIVATE_V4: Array<[number, number]> = [
  [v4('0.0.0.0'), 8], [v4('10.0.0.0'), 8], [v4('100.64.0.0'), 10], [v4('127.0.0.0'), 8],
  [v4('169.254.0.0'), 16], [v4('172.16.0.0'), 12], [v4('192.0.0.0'), 24], [v4('192.168.0.0'), 16],
  [v4('198.18.0.0'), 15], [v4('224.0.0.0'), 4], [v4('240.0.0.0'), 4],
];

function v4(dotted: string): number {
  return dotted.split('.').reduce((acc, p) => acc * 256 + Number(p), 0);
}

function isPrivateV4Number(n: number): boolean {
  if (n === 0xffffffff) { return true; }
  return PRIVATE_V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
}

function parseV4Part(part: string): number | undefined {
  if (/^0x[0-9a-f]*$/i.test(part)) { return part.length === 2 ? 0 : parseInt(part.slice(2), 16); }
  if (/^0[0-7]*$/.test(part)) { return parseInt(part, 8); }
  if (/^[1-9][0-9]*$/.test(part)) { return parseInt(part, 10); }
  return undefined;
}

/**
 * Resolvers (inet_aton) accept IPv4 in decimal, octal, hex and short forms ("2130706433", "0177.0.0.1",
 * "0x7f.1", "127.1"). Normalising them to dotted quads stops such spellings slipping past range checks.
 * Returns undefined when `host` is not an IPv4 literal in any of these forms.
 */
export function normalizeIpv4Literal(host: string): string | undefined {
  const h = host.trim().replace(/\.$/, '');
  if (!h) { return undefined; }
  const parts = h.split('.');
  if (parts.length > 4) { return undefined; }
  const nums: number[] = [];
  for (const p of parts) {
    const n = parseV4Part(p);
    if (n === undefined || !Number.isFinite(n)) { return undefined; }
    nums.push(n);
  }
  const last = nums[nums.length - 1];
  const lead = nums.slice(0, -1);
  if (lead.some((n) => n > 255)) { return undefined; }
  if (last >= 2 ** (8 * (5 - nums.length))) { return undefined; }
  let value = 0;
  for (const n of lead) { value = value * 256 + n; }
  value = value * 2 ** (8 * (5 - nums.length)) + last;
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

/** Expands an IPv6 address (zone ids and an embedded dotted IPv4 tail allowed) to eight 16-bit groups. */
function expandV6(ip: string): number[] | undefined {
  let s = ip.replace(/%.*$/, '').toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    if (!net.isIPv4(tail[1])) { return undefined; }
    const n = v4(tail[1]);
    s = `${s.slice(0, -tail[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) { return undefined; }
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) { return undefined; }
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) { return undefined; }
    out.push(parseInt(g, 16));
  }
  return out;
}

function embeddedV4(hi: number, lo: number): number {
  return hi * 65536 + lo;
}

function isPrivateV6(g: number[]): boolean {
  const [a, b, c, d, e, f, gg, h] = g;
  const firstFiveZero = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
  // ::, ::1 and deprecated IPv4-compatible ::a.b.c.d (all land in private v4 ranges or are checked as v4).
  if (firstFiveZero && f === 0) { return isPrivateV4Number(embeddedV4(gg, h)); }
  // IPv4-mapped ::ffff:a.b.c.d
  if (firstFiveZero && f === 0xffff) { return isPrivateV4Number(embeddedV4(gg, h)); }
  // IPv4-translated ::ffff:0:a.b.c.d
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0xffff && f === 0) { return isPrivateV4Number(embeddedV4(gg, h)); }
  // NAT64 well-known prefix 64:ff9b::/96
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) { return isPrivateV4Number(embeddedV4(gg, h)); }
  // NAT64 local-use prefix 64:ff9b:1::/48 maps into site-local networks.
  if (a === 0x64 && b === 0xff9b && c === 1) { return true; }
  // 6to4 2002:V4ADDR::/48
  if (a === 0x2002) { return isPrivateV4Number(embeddedV4(b, c)); }
  if ((a & 0xfe00) === 0xfc00) { return true; } // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) { return true; } // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) { return true; } // fec0::/10 deprecated site-local
  if ((a & 0xff00) === 0xff00) { return true; } // ff00::/8 multicast
  return false;
}

/**
 * True when `ip` (IPv4 in any resolver-accepted spelling, or IPv6 with or without brackets) is loopback, private,
 * link-local, CGNAT, multicast, reserved, or an IPv6 form that embeds such an IPv4 address (mapped, NAT64, 6to4).
 * Non-IP strings return false.
 */
export function isPrivateIp(ip: string): boolean {
  const s = ip.trim().replace(/^\[(.*)\]$/, '$1');
  if (s.includes(':')) {
    const g = expandV6(s);
    return g ? isPrivateV6(g) : false;
  }
  const dotted = net.isIPv4(s) ? s : normalizeIpv4Literal(s);
  return dotted ? isPrivateV4Number(v4(dotted)) : false;
}

/** Exact (case-insensitive) or `*.suffix` match; `*.suffix` also matches the bare suffix. */
export function hostMatches(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (!h) { return false; }
  for (const raw of patterns) {
    const p = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!p) { continue; }
    if (p.startsWith('*.')) {
      const suffix = p.slice(2);
      if (h === suffix || h.endsWith(`.${suffix}`)) { return true; }
    } else if (h === p) {
      return true;
    }
  }
  return false;
}

const FORBIDDEN_HOSTS = ['localhost', '*.localhost', 'localhost.localdomain', '*.local', '*.internal', 'metadata'];

function privateAllowed(host: string, opts?: PrivateAccessOptions): boolean {
  return !!opts?.allowPrivateAll || hostMatches(host, opts?.allowPrivateHosts ?? []);
}

/** Host name without IPv6 brackets or trailing dot, lower-cased. */
export function bareHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
}

/**
 * Parses and vets a URL before anything is fetched. Only http(s) without embedded credentials; local names
 * (localhost, *.local, *.internal, metadata) and literal private addresses are refused unless allowed.
 * Throws WebError 'invalid_url' for bad syntax or scheme and 'blocked' for forbidden targets.
 */
export function checkUrl(raw: string, opts?: PrivateAccessOptions): URL {
  const text = String(raw ?? '').trim();
  let url: URL;
  try { url = new URL(text); } catch { throw new WebError(`invalid URL: ${text.slice(0, 200)}`, 'invalid_url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`only http and https URLs are supported (got ${url.protocol})`, 'invalid_url');
  }
  if (url.username || url.password) { throw new WebError('URLs with embedded credentials are not allowed', 'blocked'); }
  const host = bareHost(url);
  if (!host) { throw new WebError('URL has no host', 'invalid_url'); }
  if (privateAllowed(host, opts)) { return url; }
  if (hostMatches(host, FORBIDDEN_HOSTS)) { throw new WebError(`blocked: ${host} is a local or internal host name`, 'blocked'); }
  if (isPrivateIp(host)) { throw new WebError(`blocked: ${host} is a private or reserved address`, 'blocked'); }
  return url;
}

/**
 * Throws WebError 'blocked' when DNS resolved `host` to a private address. Run on the resolved address that the
 * socket is then pinned to, so a rebinding DNS server cannot pass the check and connect somewhere else.
 */
export function assertPublicAddress(host: string, address: string, opts?: PrivateAccessOptions): void {
  if (privateAllowed(host, opts)) { return; }
  if (isPrivateIp(address)) {
    throw new WebError(`blocked: ${host} resolves to private address ${address}`, 'blocked');
  }
}
