import { createHash, createPublicKey, randomBytes, verify } from 'crypto';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { URL } from 'url';
import { renameWithRetry } from './store';

/**
 * Self-update from the company server. The gateway host also serves
 *   {origin}/infraon-assistant/updates/latest.json   (the manifest below)
 *   {origin}/infraon-assistant/updates/<file>.vsix
 * The manifest is signed with an ed25519 key that only the build machine holds; the extension carries the public key.
 * TLS to the gateway is often self-signed, so the signature, not the connection, is what makes a package trustworthy.
 */
export const UPDATE_PATH = '/infraon-assistant/updates/latest.json';
export const MANIFEST_MAX_BYTES = 64 * 1024;
export const PACKAGE_MAX_BYTES = 64 * 1024 * 1024;
export const MANIFEST_TIMEOUT_MS = 10_000;
export const PACKAGE_TIMEOUT_MS = 5 * 60_000;
const EXTENSION_NAME = 'infraon-code-assistant';

export interface UpdateManifest {
  version: string;
  /** Absolute URL of the package, resolved against the manifest URL; always on the manifest's origin. */
  url: string;
  sha256: string;
  signature: string;
  minVscode?: string;
  mandatory: boolean;
  notes?: string;
}

export type UpdateCheck =
  | { kind: 'current'; latest: string }
  | { kind: 'available'; manifest: UpdateManifest }
  | { kind: 'incompatible'; manifest: UpdateManifest };

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Negative when a < b, 0 when equal, positive when a > b. A pre-release sorts before its release. Throws on a non-semver. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a.trim()), pb = SEMVER.exec(b.trim());
  if (!pa || !pb) { throw new Error(`not a version: ${!pa ? a : b}`); }
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) { return d; }
  }
  if (pa[4] === pb[4]) { return 0; }
  if (!pa[4]) { return 1; }
  if (!pb[4]) { return -1; }
  return pa[4] < pb[4] ? -1 : 1;
}

/** The manifest URL on the LLM gateway's host, or undefined when the base URL is unusable. */
export function defaultUpdateUrl(baseUrl: string): string | undefined {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') { return undefined; }
    return `${u.origin}${UPDATE_PATH}`;
  } catch { return undefined; }
}

/** The bytes the build machine signs: binds the version to the package hash. */
export const signedMessage = (version: string, sha256: string): Buffer => Buffer.from(`${EXTENSION_NAME}\n${version}\n${sha256.toLowerCase()}\n`, 'utf8');

export function verifySignature(m: Pick<UpdateManifest, 'version' | 'sha256' | 'signature'>, publicKeyPem: string): boolean {
  try {
    return verify(null, signedMessage(m.version, m.sha256), createPublicKey(publicKeyPem), Buffer.from(m.signature, 'base64'));
  } catch { return false; }
}

/** Validates a parsed manifest. Never throws. */
export function parseManifest(raw: unknown, manifestUrl: string): { manifest?: UpdateManifest; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return { error: 'manifest is not a JSON object' }; }
  const r = raw as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === 'string' && (r[k] as string).trim() ? (r[k] as string).trim() : undefined);
  const version = str('version');
  if (!version || !SEMVER.test(version)) { return { error: 'manifest version is missing or not x.y.z' }; }
  const sha256 = str('sha256')?.toLowerCase();
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) { return { error: 'manifest sha256 is missing or invalid' }; }
  const signature = str('signature');
  if (!signature) { return { error: 'manifest is not signed' }; }
  const rel = str('url');
  if (!rel) { return { error: 'manifest url is missing' }; }
  let url: URL;
  try { url = new URL(rel, manifestUrl); } catch { return { error: 'manifest url is invalid' }; }
  if (url.origin !== new URL(manifestUrl).origin) { return { error: 'package must be served from the same server as the manifest' }; }
  if (url.username || url.password) { return { error: 'package URL must not contain credentials' }; }
  const minVscode = str('minVscode');
  if (minVscode !== undefined && !SEMVER.test(minVscode)) { return { error: 'manifest minVscode is not x.y.z' }; }
  if (r.mandatory !== undefined && typeof r.mandatory !== 'boolean') { return { error: 'manifest mandatory must be true or false' }; }
  const notes = str('notes');
  return {
    manifest: {
      version, url: url.toString(), sha256, signature, mandatory: r.mandatory === true,
      ...(minVscode ? { minVscode } : {}), ...(notes ? { notes: notes.slice(0, 2000) } : {}),
    },
  };
}

export interface GetOptions { allowSelfSigned: boolean; apiKey?: string; maxBytes: number; timeoutMs: number; signal?: AbortSignal }
export type HttpGet = (url: string, opts: GetOptions) => Promise<{ status: number; body: Buffer }>;

/** GET with a size cap and an overall timeout. Redirects are not followed: they could leave the approved server. */
export const httpGet: HttpGet = (url, opts) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, opts.timeoutMs);
  let settled = false;
  const finish = (err: Error | undefined, value?: { status: number; body: Buffer }) => {
    if (settled) { return; }
    settled = true;
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    if (err) { reject(err); } else { resolve(value!); }
  };
  const tooLarge = () => new Error(`larger than ${opts.maxBytes} bytes`);
  const req = (isHttps ? https : http).get(u, {
    signal: ctl.signal,
    headers: { Accept: '*/*', ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) },
    ...(isHttps ? { rejectUnauthorized: !opts.allowSelfSigned } : {}),
  }, (res) => {
    const stop = (e: Error) => { finish(e); res.destroy(); req.destroy(); };
    res.on('error', (e) => finish(e));
    if (Number(res.headers['content-length']) > opts.maxBytes) { stop(tooLarge()); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (d: Buffer) => {
      size += d.length;
      if (size > opts.maxBytes) { stop(tooLarge()); return; }
      chunks.push(d);
    });
    res.on('end', () => finish(undefined, { status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
  });
  req.on('error', (e) => finish(timedOut ? new Error('timed out') : e));
});

export interface CheckOptions {
  manifestUrl: string; currentVersion: string; vscodeVersion: string; publicKeyPem: string;
  allowSelfSigned: boolean; apiKey?: string; get?: HttpGet; signal?: AbortSignal;
}

/** Reads and verifies the manifest. Throws with a readable message on any failure. */
export async function checkForUpdate(o: CheckOptions): Promise<UpdateCheck> {
  const get = o.get ?? httpGet;
  const res = await get(o.manifestUrl, { allowSelfSigned: o.allowSelfSigned, apiKey: o.apiKey, maxBytes: MANIFEST_MAX_BYTES, timeoutMs: MANIFEST_TIMEOUT_MS, signal: o.signal });
  if (res.status === 404) { throw new Error('no update manifest is published on the server'); }
  if (res.status !== 200) { throw new Error(`update server answered HTTP ${res.status}`); }
  let raw: unknown;
  try { raw = JSON.parse(res.body.toString('utf8').replace(/^﻿/, '')); } catch { throw new Error('update manifest is not valid JSON'); }
  const { manifest, error } = parseManifest(raw, o.manifestUrl);
  if (!manifest) { throw new Error(error); }
  if (!verifySignature(manifest, o.publicKeyPem)) { throw new Error('update manifest signature is invalid; the update was ignored'); }
  if (compareVersions(manifest.version, o.currentVersion) <= 0) { return { kind: 'current', latest: manifest.version }; }
  const vscode = o.vscodeVersion.replace(/-.*$/, '');
  if (manifest.minVscode && SEMVER.test(vscode) && compareVersions(vscode, manifest.minVscode) < 0) { return { kind: 'incompatible', manifest }; }
  return { kind: 'available', manifest };
}

export interface DownloadOptions { dir: string; allowSelfSigned: boolean; apiKey?: string; get?: HttpGet; signal?: AbortSignal }

/** Downloads the package, checks it against the signed hash, and returns the local file. Older downloads are removed. */
export async function downloadUpdate(m: UpdateManifest, o: DownloadOptions): Promise<string> {
  const get = o.get ?? httpGet;
  const res = await get(m.url, { allowSelfSigned: o.allowSelfSigned, apiKey: o.apiKey, maxBytes: PACKAGE_MAX_BYTES, timeoutMs: PACKAGE_TIMEOUT_MS, signal: o.signal });
  if (res.status !== 200) { throw new Error(`package download answered HTTP ${res.status}`); }
  const actual = createHash('sha256').update(res.body).digest('hex');
  if (actual !== m.sha256) { throw new Error('downloaded package does not match the signed hash; it was discarded'); }
  await fs.mkdir(o.dir, { recursive: true });
  const name = `${EXTENSION_NAME}-${m.version}.vsix`;
  for (const old of await fs.readdir(o.dir).catch(() => [] as string[])) {
    if (old !== name && (old.endsWith('.vsix') || old.endsWith('.tmp'))) { await fs.rm(path.join(o.dir, old), { force: true }).catch(() => undefined); }
  }
  const file = path.join(o.dir, name);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, res.body);
  try { await renameWithRetry(tmp, file); } catch (e) { await fs.rm(tmp, { force: true }); throw e; }
  return file;
}

/** True when the API key may be sent to the update server: only to the gateway the key belongs to. */
export function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}
