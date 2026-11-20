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
 * Every manifest field is covered by an ed25519 signature made with a key that only the build machine holds; the
 * extension carries the public keys. TLS to the gateway is often self-signed, so the signature, not the connection,
 * is what makes a release trustworthy. No credentials are ever sent to the update server.
 */
export const UPDATE_PATH = '/infraon-assistant/updates/latest.json';
export const MANIFEST_MAX_BYTES = 64 * 1024;
export const PACKAGE_MAX_BYTES = 64 * 1024 * 1024;
export const MANIFEST_TIMEOUT_MS = 10_000;
export const PACKAGE_TIMEOUT_MS = 5 * 60_000;
const EXTENSION_NAME = 'infraon-code-assistant';
const SIGNATURE_DOMAIN = 'infraon-code-assistant update v2';

export interface UpdateManifest {
  version: string;
  /** The package location exactly as published (usually a file name); this is what the signature covers. */
  source: string;
  /** `source` resolved against the manifest URL; always on the manifest's origin. */
  url: string;
  sha256: string;
  signature: string;
  minVscode?: string;
  mandatory: boolean;
  notes?: string;
}

export type UpdateCheck =
  | { kind: 'unpublished' }
  | { kind: 'current'; latest: string }
  | { kind: 'available'; manifest: UpdateManifest }
  | { kind: 'incompatible'; manifest: UpdateManifest };

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** SemVer 2 pre-release precedence: numeric identifiers numerically and below alphanumeric ones; a shorter prefix first. */
function comparePre(a: string, b: string): number {
  const pa = a.split('.'), pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) { return -1; }
    if (pb[i] === undefined) { return 1; }
    const na = /^\d+$/.test(pa[i]), nb = /^\d+$/.test(pb[i]);
    if (na && nb) { const d = Number(pa[i]) - Number(pb[i]); if (d) { return d; } continue; }
    if (na !== nb) { return na ? -1 : 1; }
    if (pa[i] !== pb[i]) { return pa[i] < pb[i] ? -1 : 1; }
  }
  return 0;
}

/** Negative when a < b, 0 when equal, positive when a > b (SemVer 2 precedence). Throws on a non-semver. */
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
  return comparePre(pa[4], pb[4]);
}

/** The manifest URL on the LLM gateway's host, or undefined when the base URL is unusable. */
export function defaultUpdateUrl(baseUrl: string): string | undefined {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') { return undefined; }
    return `${u.origin}${UPDATE_PATH}`;
  } catch { return undefined; }
}

export interface SignedFields { version: string; source: string; sha256: string; minVscode?: string; mandatory: boolean; notes?: string }

/**
 * The exact bytes the build machine signs: every field the client acts on, in a fixed order.
 * scripts/sign-update.js builds the same bytes; a test checks that the two agree.
 */
export function signedMessage(f: SignedFields): Buffer {
  const canonical = JSON.stringify([f.version, f.source, f.sha256.toLowerCase(), f.minVscode ?? null, f.mandatory, f.notes ?? null]);
  return Buffer.from(`${SIGNATURE_DOMAIN}\n${canonical}`, 'utf8');
}

/** True when any of the trusted keys signed these fields. Several keys allow a staged key rotation. */
export function verifySignature(m: SignedFields & { signature: string }, publicKeysPem: readonly string[]): boolean {
  const sig = Buffer.from(m.signature, 'base64');
  const msg = signedMessage(m);
  return publicKeysPem.some((pem) => { try { return verify(null, msg, createPublicKey(pem), sig); } catch { return false; } });
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
  const source = str('url');
  if (!source) { return { error: 'manifest url is missing' }; }
  let url: URL;
  try { url = new URL(source, manifestUrl); } catch { return { error: 'manifest url is invalid' }; }
  if (url.origin !== new URL(manifestUrl).origin) { return { error: 'package must be served from the same server as the manifest' }; }
  if (url.username || url.password) { return { error: 'package URL must not contain credentials' }; }
  const minVscode = str('minVscode');
  if (minVscode !== undefined && !SEMVER.test(minVscode)) { return { error: 'manifest minVscode is not x.y.z' }; }
  if (r.mandatory !== undefined && typeof r.mandatory !== 'boolean') { return { error: 'manifest mandatory must be true or false' }; }
  const notes = str('notes');
  if (notes !== undefined && notes.length > 2000) { return { error: 'manifest notes are longer than 2000 characters' }; }
  return {
    manifest: {
      version, source, url: url.toString(), sha256, signature, mandatory: r.mandatory === true,
      ...(minVscode ? { minVscode } : {}), ...(notes ? { notes } : {}),
    },
  };
}

export interface GetOptions { allowSelfSigned: boolean; maxBytes: number; timeoutMs: number; signal?: AbortSignal }
export type HttpGet = (url: string, opts: GetOptions) => Promise<{ status: number; body: Buffer }>;

/**
 * GET with a size cap and an overall timeout. Sends no credentials. Redirects are not followed: they could leave the
 * approved server.
 */
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
    headers: { Accept: '*/*' },
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
  manifestUrl: string; currentVersion: string; vscodeVersion: string; publicKeysPem: readonly string[];
  allowSelfSigned: boolean; get?: HttpGet; signal?: AbortSignal;
}

/** Reads and verifies the manifest. A missing manifest is 'unpublished'; any other failure throws a readable message. */
export async function checkForUpdate(o: CheckOptions): Promise<UpdateCheck> {
  const get = o.get ?? httpGet;
  const res = await get(o.manifestUrl, { allowSelfSigned: o.allowSelfSigned, maxBytes: MANIFEST_MAX_BYTES, timeoutMs: MANIFEST_TIMEOUT_MS, signal: o.signal });
  if (res.status === 404) { return { kind: 'unpublished' }; }
  if (res.status !== 200) { throw new Error(`update server answered HTTP ${res.status}`); }
  let raw: unknown;
  try { raw = JSON.parse(res.body.toString('utf8').replace(/^﻿/, '')); } catch { throw new Error('update manifest is not valid JSON'); }
  const { manifest, error } = parseManifest(raw, o.manifestUrl);
  if (!manifest) { throw new Error(error); }
  if (!verifySignature(manifest, o.publicKeysPem)) { throw new Error('update manifest signature is invalid; the update was ignored'); }
  if (compareVersions(manifest.version, o.currentVersion) <= 0) { return { kind: 'current', latest: manifest.version }; }
  const vscode = o.vscodeVersion.replace(/-.*$/, '');
  if (manifest.minVscode && SEMVER.test(vscode) && compareVersions(vscode, manifest.minVscode) < 0) { return { kind: 'incompatible', manifest }; }
  return { kind: 'available', manifest };
}

export interface DownloadOptions { dir: string; allowSelfSigned: boolean; get?: HttpGet; signal?: AbortSignal }

/**
 * Downloads the package, checks it against the signed hash, and returns the local file. Call it while holding the
 * install lock (see withInstallLock): it removes older packages and abandoned partial downloads from `dir`.
 */
export async function downloadUpdate(m: UpdateManifest, o: DownloadOptions): Promise<string> {
  const get = o.get ?? httpGet;
  const res = await get(m.url, { allowSelfSigned: o.allowSelfSigned, maxBytes: PACKAGE_MAX_BYTES, timeoutMs: PACKAGE_TIMEOUT_MS, signal: o.signal });
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

/* ------------------------------------------------------------------ coordination between VS Code windows */

/** A lock older than this is treated as abandoned (its window crashed or was closed mid-install). */
export const LOCK_STALE_MS = 15 * 60_000;
/** How long an install record suppresses re-installing the same or an older release. */
export const RECORD_TTL_MS = 24 * 60 * 60_000;

/**
 * Runs `fn` while holding a lock file in `dir` that every window of the same profile shares, or returns undefined
 * when another window holds it. A lock left behind by a crashed window expires after LOCK_STALE_MS.
 */
export async function withInstallLock<T>(dir: string, fn: () => Promise<T>, now = Date.now): Promise<T | undefined> {
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, 'install.lock');
  const take = async () => { const h = await fs.open(lock, 'wx'); await h.writeFile(`${process.pid} ${now()}`); await h.close(); };
  try { await take(); } catch (e: any) {
    if (e.code !== 'EEXIST') { throw e; }
    const age = now() - (await fs.stat(lock).then((s) => s.mtimeMs, () => now()));
    if (age < LOCK_STALE_MS) { return undefined; }
    await fs.rm(lock, { force: true });
    try { await take(); } catch (e2: any) { if (e2.code === 'EEXIST') { return undefined; } throw e2; }
  }
  try { return await fn(); } finally { await fs.rm(lock, { force: true }).catch(() => undefined); }
}

export interface InstallRecord { version: string; at: number }

/** The release a window of this profile installed recently (pending a reload), if any. */
export async function readInstallRecord(dir: string, now = Date.now): Promise<InstallRecord | undefined> {
  try {
    const r = JSON.parse(await fs.readFile(path.join(dir, 'installed.json'), 'utf8')) as InstallRecord;
    return typeof r.version === 'string' && SEMVER.test(r.version) && typeof r.at === 'number' && now() - r.at < RECORD_TTL_MS ? r : undefined;
  } catch { return undefined; }
}

export async function writeInstallRecord(dir: string, version: string, now = Date.now): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'installed.json'), JSON.stringify({ version, at: now() }));
}

/** Rejects with `message` when `p` does not settle within `ms`. */
export function withTimeout<T>(p: Thenable<T> | Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    Promise.resolve(p),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
