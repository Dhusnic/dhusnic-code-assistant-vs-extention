import * as http from 'http';
import * as https from 'https';
import { checkRule, formatRules, getPath, RULE_HELP, sameValue, toRows, validateRows } from './data';

export interface HttpRequest {
  method?: string; url: string; headers?: Record<string, string>; body?: string | Buffer;
  timeoutMs?: number; insecure?: boolean; maxBytes?: number; followRedirects?: boolean; signal?: AbortSignal;
}
export interface HttpResponse {
  status: number; statusText: string; headers: Record<string, string>; body: Buffer; ms: number; url: string;
  redirects: string[]; truncated: boolean;
}

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token|x-csrf-token)$/i;
export const maskHeaders = (h: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k, SENSITIVE_HEADER.test(k) || /token|secret|password/i.test(k) ? `${String(v).slice(0, 4)}…(hidden)` : v]));

/** One HTTP(S) request with a hard timeout and size cap. Redirects are followed (up to 5) unless turned off. */
export async function httpRequest(r: HttpRequest): Promise<HttpResponse> {
  const t0 = Date.now();
  const redirects: string[] = [];
  let url = r.url, method = (r.method ?? 'GET').toUpperCase(), body = r.body;
  for (let hop = 0; ; hop++) {
    const res = await once(url, method, r.headers ?? {}, body, r);
    const loc = res.headers['location'];
    if (r.followRedirects !== false && loc && [301, 302, 303, 307, 308].includes(res.status) && hop < 5) {
      redirects.push(`${res.status} → ${loc}`);
      url = new URL(loc, url).toString();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
      continue;
    }
    return { ...res, ms: Date.now() - t0, url, redirects };
  }
}

function once(url: string, method: string, headers: Record<string, string>, body: string | Buffer | undefined, r: HttpRequest): Promise<Omit<HttpResponse, 'ms' | 'url' | 'redirects'>> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { reject(new Error(`Invalid URL: ${url}`)); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { reject(new Error(`Only http and https URLs are supported (got ${u.protocol}).`)); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const hdrs: Record<string, string> = { 'user-agent': 'InfraonAssistant-ApiTest/1.0', accept: '*/*', ...headers };
    if (body !== undefined) { hdrs['content-length'] = String(Buffer.byteLength(body)); }
    const max = r.maxBytes ?? 5 * 1024 * 1024;
    const req = lib.request(u, { method, headers: hdrs, timeout: r.timeoutMs ?? 30_000, ...(u.protocol === 'https:' && r.insecure ? { rejectUnauthorized: false } : {}), signal: r.signal }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0, truncated = false;
      res.on('data', (c: Buffer) => { if (size < max) { chunks.push(c); } else { truncated = true; } size += c.length; });
      res.on('end', () => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) { if (v !== undefined) { h[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v); } }
        resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', headers: h, body: Buffer.concat(chunks).subarray(0, max), truncated });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${Math.round((r.timeoutMs ?? 30_000) / 1000)} s with no response`)));
    req.on('error', (e: any) => reject(new Error(describeNetError(e, u))));
    if (body !== undefined) { req.write(body); }
    req.end();
  });
}

export function describeNetError(e: any, u: URL): string {
  const host = `${u.hostname}${u.port ? `:${u.port}` : ''}`;
  switch (e?.code) {
    case 'ECONNREFUSED': return `Connection refused by ${host}: nothing is listening there (is the server running?)`;
    case 'ENOTFOUND': case 'EAI_AGAIN': return `The host name ${u.hostname} could not be resolved (DNS)`;
    case 'ECONNRESET': return `${host} closed the connection unexpectedly`;
    case 'ETIMEDOUT': return `Connecting to ${host} timed out`;
    case 'CERT_HAS_EXPIRED': return `The TLS certificate of ${host} has expired`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT': case 'SELF_SIGNED_CERT_IN_CHAIN': case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `The TLS certificate of ${host} is not trusted (${e.code}). For an internal test server, retry with insecure: true`;
    case 'ERR_TLS_CERT_ALTNAME_INVALID': return `The TLS certificate does not match ${u.hostname}`;
    case 'ABORT_ERR': return 'The request was cancelled';
  }
  return e?.message ?? String(e);
}

/* ------------------------------------------------------------------ expectations */

export interface ApiExpect {
  status?: number | string | Array<number | string>;
  max_ms?: number;
  headers?: Record<string, string>;
  body_contains?: string | string[];
  body_not_contains?: string | string[];
  /** JSON path → rule string or exact value. */
  json?: Record<string, unknown>;
  /** Rules applied to every row of the list at `path` (default: the obvious list in the body). */
  rows?: { path?: string; rules: Record<string, unknown>; min?: number; max?: number };
}

export interface Check { ok: boolean; text: string }

export function statusMatches(status: number, want: number | string | Array<number | string>): boolean {
  const list = Array.isArray(want) ? want : [want];
  return list.some((w) => {
    const s = String(w).trim().toLowerCase();
    if (/^\dxx$/.test(s)) { return Math.floor(status / 100) === Number(s[0]); }
    return Number(s) === status;
  });
}

export function parseJsonBody(res: Pick<HttpResponse, 'body' | 'headers'>): { json?: unknown; error?: string } {
  const text = res.body.toString('utf8').replace(/^﻿/, '').trim();
  if (!text) { return { error: 'the body is empty' }; }
  try { return { json: JSON.parse(text) }; } catch (e: any) {
    const ct = res.headers['content-type'] ?? '';
    return { error: `the body is not valid JSON (${e.message})${/json/i.test(ct) ? ' although Content-Type says JSON' : ct ? `; Content-Type is ${ct}` : ''}` };
  }
}

export function checkResponse(res: HttpResponse, expect: ApiExpect | undefined): { checks: Check[]; json?: unknown; rulesText?: string } {
  const checks: Check[] = [];
  const e = expect ?? {};
  const want = e.status ?? '2xx';
  checks.push({ ok: statusMatches(res.status, want), text: `status ${res.status} ${statusMatches(res.status, want) ? 'is' : 'is not'} ${Array.isArray(want) ? want.join(' or ') : want}${expect?.status === undefined ? ' (default expectation)' : ''}` });
  if (e.max_ms !== undefined) { checks.push({ ok: res.ms <= e.max_ms, text: `response time ${res.ms} ms ${res.ms <= e.max_ms ? '≤' : '>'} ${e.max_ms} ms` }); }
  for (const [name, rule] of Object.entries(e.headers ?? {})) {
    const v = res.headers[name.toLowerCase()];
    const fails = /^(required|not_empty|=|!=|\/|contains:|one_of:)/.test(rule) ? checkRule(v, rule) : v?.toLowerCase().includes(String(rule).toLowerCase()) ? [] : [`is ${v === undefined ? 'missing' : JSON.stringify(v)}`];
    checks.push({ ok: !fails.length, text: `header ${name}${fails.length ? ` ${fails.join('; ')}` : ` ok (${rule})`}` });
  }
  const text = res.body.toString('utf8');
  for (const s of ([] as string[]).concat(e.body_contains ?? [])) { checks.push({ ok: text.includes(s), text: `body ${text.includes(s) ? 'contains' : 'does not contain'} ${JSON.stringify(s)}` }); }
  for (const s of ([] as string[]).concat(e.body_not_contains ?? [])) { checks.push({ ok: !text.includes(s), text: `body ${text.includes(s) ? 'contains (should not)' : 'does not contain'} ${JSON.stringify(s)}` }); }
  let json: unknown;
  const needJson = !!(e.json || e.rows);
  const parsed = parseJsonBody(res);
  if (parsed.json !== undefined) { json = parsed.json; } else if (needJson) { checks.push({ ok: false, text: `JSON checks skipped: ${parsed.error}` }); }
  let rulesText: string | undefined;
  if (json !== undefined) {
    for (const [p, rule] of Object.entries(e.json ?? {})) {
      const v = getPath(json, p);
      const fails = typeof rule === 'string' ? checkRule(v, rule) : exactFails(rule, v);
      checks.push({ ok: !fails.length, text: `${p}: ${fails.length ? fails.join('; ') : `ok (${typeof rule === 'string' ? rule : JSON.stringify(rule)})`}` });
    }
    if (e.rows) {
      const rows = toRows(e.rows.path ? getPath(json, e.rows.path) : json);
      if (e.rows.min !== undefined) { checks.push({ ok: rows.length >= e.rows.min, text: `${rows.length} row(s), at least ${e.rows.min} expected` }); }
      if (e.rows.max !== undefined) { checks.push({ ok: rows.length <= e.rows.max, text: `${rows.length} row(s), at most ${e.rows.max} expected` }); }
      const reports = validateRows(rows, e.rows.rules ?? {}, ['id', '_id', 'uuid'].find((k) => rows[0] && k in rows[0]));
      for (const r of reports) { checks.push({ ok: !r.failed, text: `rows.${r.field} (${r.rule}): ${r.failed ? `${r.failed} of ${r.total} fail` : `all ${r.total} ok`}` }); }
      rulesText = formatRules(reports);
    }
  }
  return { checks, json, rulesText };
}

const LEAK_PATTERNS: Array<[RegExp, string]> = [
  [/^\s*at \S+ \(.+:\d+:\d+\)|^\s*at .+:\d+:\d+$/m, 'a JavaScript stack trace'],
  [/Traceback \(most recent call last\)|File ".+", line \d+/, 'a Python traceback'],
  [/^\s*at [\w$.]+\([\w$]+\.java:\d+\)/m, 'a Java stack trace'],
  [/^\s*at [\w.<>`]+\(.*\) in .+:line \d+/m, 'a .NET stack trace'],
  [/SQLSTATE\[|syntax error at or near|You have an error in your SQL syntax|ORA-\d{5}|Unclosed quotation mark|PG::\w+Error|SequelizeDatabaseError|QueryFailedError/i, 'a database error'],
  [/\b(?:[A-Z]\w+\.)+\w*(?:Exception|Error)\b: |\bUnhandled(?:Promise)?Rejection|NullPointerException/, 'an exception message'],
];

/** What an error response gives away about the server's internals (stack traces, SQL, exceptions), if anything. */
export function leakedInternals(body: string): string | undefined {
  const text = body.slice(0, 50_000);
  return LEAK_PATTERNS.find(([re]) => re.test(text))?.[1];
}

/** An exact expected value in an API check: the JSON type matters too (10 is not "10"). */
function exactFails(want: unknown, got: unknown): string[] {
  const type = (x: unknown) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);
  if (type(want) !== type(got)) { return [`expected ${JSON.stringify(want)} (${type(want)}), got ${JSON.stringify(got)} (${type(got)})`]; }
  return sameValue(want, got, { ignoreCase: false }) ? [] : [`expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`];
}

export { RULE_HELP };
