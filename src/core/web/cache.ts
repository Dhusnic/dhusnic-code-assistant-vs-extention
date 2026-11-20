import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CacheEntry, FetchOptions, FetchResponse, HttpFetch, Snapshot, WebError } from './types';

/**
 * Disk cache and snapshot archive for fetched pages. Re-reading a page the agent saw minutes ago costs nothing,
 * ETags make stale pages cheap to confirm, and the per-URL history lets the agent (and the offline library) see
 * how a page changed. Bodies are content-addressed so identical bodies are stored once.
 */

export interface WebCacheOptions {
  /** Total blob bytes before least-recently-used entries are evicted. Default 200 MiB. */
  maxBytes?: number;
  /** Freshness when neither the caller nor Cache-Control says otherwise. Default 15 min. */
  defaultTtlMs?: number;
  /** History length per URL. Default 10. */
  maxSnapshotsPerUrl?: number;
}

/** What is stored per entry: the contract plus bookkeeping for LRU and server-given freshness. */
interface StoredEntry extends CacheEntry {
  accessedAt?: number;
  /** From Cache-Control max-age / no-cache; used when the caller gives no TTL. */
  maxAgeMs?: number;
}

interface IndexItem { entry: StoredEntry; history: Snapshot[] }

const SHA_RE = /^[0-9a-f]{64}$/;
const ACCESS_WRITE_INTERVAL_MS = 60_000;

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = '';
    return u.href;
  } catch {
    return url.trim();
  }
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch { return undefined; }
}

/** Atomic write: tmp file + rename, retried because Windows briefly locks files that scanners or readers hold. */
async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 6 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw e;
      }
      await new Promise((r) => setTimeout(r, 15 * 2 ** attempt));
    }
  }
}

function publicEntry(e: StoredEntry): CacheEntry {
  const { accessedAt: _a, maxAgeMs: _m, ...rest } = e;
  return rest;
}

export class WebCache {
  private readonly maxBytes: number;
  private readonly defaultTtlMs: number;
  private readonly maxSnapshots: number;
  private index?: Promise<Map<string, IndexItem>>;
  private lock: Promise<unknown> = Promise.resolve();
  /** In-flight network fetches by key, so concurrent callers for one URL share a single request. */
  readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string, opts: WebCacheOptions = {}) {
    this.maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;
    this.defaultTtlMs = opts.defaultTtlMs ?? 15 * 60_000;
    this.maxSnapshots = Math.max(1, opts.maxSnapshotsPerUrl ?? 10);
  }

  /** Stable file name for a URL (fragment dropped) and optional variant, e.g. a rendering mode. */
  static key(url: string, variant?: string): string {
    return sha256(variant ? `${normalizeUrl(url)}\n${variant}` : normalizeUrl(url));
  }

  private entryFile(key: string): string { return path.join(this.dir, 'entries', `${key}.json`); }
  private historyFile(key: string): string { return path.join(this.dir, 'history', `${key}.json`); }
  private blobFile(sha: string): string { return path.join(this.dir, 'blobs', sha); }

  /** Serialises mutations so eviction never deletes a blob another put just wrote. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private loadIndex(): Promise<Map<string, IndexItem>> {
    this.index ??= (async () => {
      const map = new Map<string, IndexItem>();
      let names: string[] = [];
      try { names = await fs.readdir(path.join(this.dir, 'entries')); } catch { return map; }
      for (const name of names) {
        if (!name.endsWith('.json')) { continue; }
        const key = name.slice(0, -5);
        const entry = await readJson<StoredEntry>(this.entryFile(key));
        if (!entry || typeof entry.sha256 !== 'string') { continue; }
        const history = await readJson<Snapshot[]>(this.historyFile(key));
        map.set(key, { entry, history: Array.isArray(history) ? history : [] });
      }
      return map;
    })();
    return this.index;
  }

  async get(url: string, variant?: string): Promise<{ entry: CacheEntry; body: Buffer } | undefined> {
    const key = WebCache.key(url, variant);
    const entry = await readJson<StoredEntry>(this.entryFile(key));
    if (!entry || typeof entry.sha256 !== 'string' || !SHA_RE.test(entry.sha256)) { return undefined; }
    let body: Buffer;
    try { body = await fs.readFile(this.blobFile(entry.sha256)); } catch { return undefined; }
    if (sha256(body) !== entry.sha256) { return undefined; }
    const t = Date.now();
    const index = await this.loadIndex();
    const item = index.get(key);
    if (item) { item.entry.accessedAt = t; } else { index.set(key, { entry: { ...entry, accessedAt: t }, history: [] }); }
    if (t - (entry.accessedAt ?? 0) > ACCESS_WRITE_INTERVAL_MS) {
      await this.exclusive(async () => {
        // Re-read under the lock: a concurrent put may have replaced the entry since we read it.
        const latest = await readJson<StoredEntry>(this.entryFile(key));
        if (latest?.sha256 === entry.sha256 && latest.fetchedAt === entry.fetchedAt) {
          await writeAtomic(this.entryFile(key), JSON.stringify({ ...latest, accessedAt: t }));
        }
      }).catch(() => undefined);
    }
    return { entry: { ...entry }, body };
  }

  async put(url: string, entry: CacheEntry, body: Buffer, variant?: string): Promise<void> {
    const key = WebCache.key(url, variant);
    const sha = sha256(body);
    const stored: StoredEntry = { ...entry, sha256: sha, size: body.length, accessedAt: Date.now() };
    await this.exclusive(async () => {
      await fs.mkdir(path.join(this.dir, 'blobs'), { recursive: true });
      await fs.mkdir(path.join(this.dir, 'entries'), { recursive: true });
      await fs.mkdir(path.join(this.dir, 'history'), { recursive: true });
      const blob = this.blobFile(sha);
      const exists = await fs.stat(blob).then((s) => s.size === body.length, () => false);
      if (!exists) { await writeAtomic(blob, body); }
      await writeAtomic(this.entryFile(key), JSON.stringify(stored));
      const history = (await readJson<Snapshot[]>(this.historyFile(key))) ?? [];
      const list = Array.isArray(history) ? history : [];
      if (list[0]?.sha256 !== sha) {
        list.unshift({ sha256: sha, fetchedAt: stored.fetchedAt, size: body.length });
        list.length = Math.min(list.length, this.maxSnapshots);
        await writeAtomic(this.historyFile(key), JSON.stringify(list));
      }
      const index = await this.loadIndex();
      index.set(key, { entry: stored, history: list });
      await this.evict(index, key);
    });
  }

  /** Fresh when younger than the caller's TTL, else the server's max-age, else the default TTL. */
  isFresh(entry: CacheEntry, ttlMs?: number): boolean {
    const ttl = ttlMs ?? (entry as StoredEntry).maxAgeMs ?? this.defaultTtlMs;
    return Date.now() - entry.fetchedAt < ttl;
  }

  /** Recorded versions of a URL, newest first. */
  async snapshots(url: string, variant?: string): Promise<Snapshot[]> {
    const list = await readJson<Snapshot[]>(this.historyFile(WebCache.key(url, variant)));
    return Array.isArray(list) ? list : [];
  }

  async readSnapshot(sha: string): Promise<Buffer | undefined> {
    if (!SHA_RE.test(sha)) { return undefined; }
    try { return await fs.readFile(this.blobFile(sha)); } catch { return undefined; }
  }

  /** Every cached entry on disk, including ones written by other windows (feeds the offline library). */
  async entries(): Promise<CacheEntry[]> {
    let names: string[] = [];
    try { names = await fs.readdir(path.join(this.dir, 'entries')); } catch { return []; }
    const out: CacheEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) { continue; }
      const e = await readJson<StoredEntry>(path.join(this.dir, 'entries', name));
      if (e && typeof e.url === 'string' && typeof e.sha256 === 'string') { out.push(publicEntry(e)); }
    }
    return out;
  }

  async clear(): Promise<void> {
    await this.exclusive(async () => {
      for (const sub of ['entries', 'history', 'blobs']) {
        await fs.rm(path.join(this.dir, sub), { recursive: true, force: true, maxRetries: 3 });
      }
      this.index = undefined;
    });
  }

  async stats(): Promise<{ entries: number; bytes: number }> {
    const index = await this.loadIndex();
    return { entries: index.size, bytes: WebCache.referencedBytes(index) };
  }

  private static referenced(index: Map<string, IndexItem>): Map<string, number> {
    const blobs = new Map<string, number>();
    for (const { entry, history } of index.values()) {
      blobs.set(entry.sha256, entry.size);
      for (const s of history) { blobs.set(s.sha256, s.size); }
    }
    return blobs;
  }

  private static referencedBytes(index: Map<string, IndexItem>): number {
    let total = 0;
    for (const size of WebCache.referenced(index).values()) { total += size; }
    return total;
  }

  /** Drops least-recently-used entries (and their history) until blobs fit, then deletes unreferenced blobs. */
  private async evict(index: Map<string, IndexItem>, keep: string): Promise<void> {
    if (WebCache.referencedBytes(index) <= this.maxBytes) { return; }
    const order = [...index.entries()]
      .filter(([k]) => k !== keep)
      .sort((a, b) => (a[1].entry.accessedAt ?? a[1].entry.fetchedAt) - (b[1].entry.accessedAt ?? b[1].entry.fetchedAt));
    const dropped: IndexItem[] = [];
    for (const [key, item] of order) {
      if (WebCache.referencedBytes(index) <= this.maxBytes) { break; }
      index.delete(key);
      dropped.push(item);
      await fs.rm(this.entryFile(key), { force: true });
      await fs.rm(this.historyFile(key), { force: true });
    }
    // The newest entry alone may exceed the budget: trim its own older snapshots before giving up.
    const own = index.get(keep);
    while (own && own.history.length > 1 && WebCache.referencedBytes(index) > this.maxBytes) {
      const old = own.history.pop();
      if (old) { dropped.push({ entry: { ...own.entry, sha256: old.sha256 }, history: [] }); }
      await writeAtomic(this.historyFile(keep), JSON.stringify(own.history));
    }
    const live = WebCache.referenced(index);
    for (const item of dropped) {
      for (const sha of [item.entry.sha256, ...item.history.map((s) => s.sha256)]) {
        if (!live.has(sha)) { await fs.rm(this.blobFile(sha), { force: true }); }
      }
    }
  }
}

export interface CachedFetchOptions extends FetchOptions {
  /** Freshness for this call; overrides Cache-Control max-age and the cache default. */
  ttlMs?: number;
  /** Skip the freshness check (still revalidates with ETag / Last-Modified). */
  refresh?: boolean;
  /** Serve only from cache, stale allowed; never touches the network. */
  offline?: boolean;
}

export type CachedFetchResponse = FetchResponse & { fromCache: boolean; revalidated?: boolean; sha256: string; fetchedAt: number };

function cacheControl(headers: Record<string, string>): { noStore: boolean; maxAgeMs?: number } {
  const cc = (headers['cache-control'] ?? '').toLowerCase();
  const noStore = /(^|[,\s])no-store([,\s]|$)/.test(cc);
  if (/(^|[,\s])no-cache([,\s]|$)/.test(cc)) { return { noStore, maxAgeMs: 0 }; }
  const m = /(?:^|[,\s])max-age\s*=\s*"?(\d+)/.exec(cc);
  return { noStore, maxAgeMs: m ? Number(m[1]) * 1000 : undefined };
}

function fromEntry(entry: CacheEntry, body: Buffer, started: number, extra: { revalidated?: boolean }): CachedFetchResponse {
  const headers: Record<string, string> = {};
  if (entry.contentType) { headers['content-type'] = entry.charset ? `${entry.contentType}; charset=${entry.charset}` : entry.contentType; }
  if (entry.etag) { headers.etag = entry.etag; }
  if (entry.lastModified) { headers['last-modified'] = entry.lastModified; }
  headers['content-length'] = String(body.length);
  return {
    url: entry.finalUrl, status: entry.status, headers, body, contentType: entry.contentType, charset: entry.charset,
    truncated: !!entry.truncated, redirects: [], ms: Date.now() - started,
    fromCache: true, ...extra, sha256: entry.sha256, fetchedAt: entry.fetchedAt,
  };
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  return !!headers && Object.keys(headers).some((k) => k.toLowerCase() === name);
}

/**
 * Fetch through the cache: fresh hits skip the network, stale hits are revalidated with conditional headers,
 * and 200 responses (unless `no-store`) are stored with a new snapshot when the content changed.
 * Only plain GETs are cached; everything else passes straight through.
 */
export async function cachedFetch(http: HttpFetch, cache: WebCache | undefined, url: string, opts: CachedFetchOptions = {}): Promise<CachedFetchResponse> {
  const { ttlMs, refresh, offline, ...fetchOpts } = opts;
  const method = fetchOpts.method ?? 'GET';
  if (!cache || method !== 'GET' || fetchOpts.body !== undefined) {
    if (offline) { throw new WebError('offline mode: not in cache', 'network'); }
    const res = await http(url, fetchOpts);
    return { ...res, fromCache: false, sha256: sha256(res.body), fetchedAt: Date.now() };
  }
  const flightKey = `${WebCache.key(url)}:${offline ? 'o' : ''}${refresh ? 'r' : ''}:${ttlMs ?? ''}`;
  const pending = cache.inflight.get(flightKey) as Promise<CachedFetchResponse> | undefined;
  if (pending) { return pending.then((r) => ({ ...r, body: Buffer.from(r.body) })); }
  const run = (async (): Promise<CachedFetchResponse> => {
    const started = Date.now();
    const hit = await cache.get(url);
    if (offline) {
      if (!hit) { throw new WebError(`offline mode: not in cache: ${url}`, 'network'); }
      return fromEntry(hit.entry, hit.body, started, {});
    }
    if (hit && !refresh && cache.isFresh(hit.entry, ttlMs)) { return fromEntry(hit.entry, hit.body, started, {}); }

    const headers = { ...(fetchOpts.headers ?? {}) };
    if (hit?.entry.etag && !hasHeader(headers, 'if-none-match')) { headers['If-None-Match'] = hit.entry.etag; }
    if (hit?.entry.lastModified && !hasHeader(headers, 'if-modified-since')) { headers['If-Modified-Since'] = hit.entry.lastModified; }
    const res = await http(url, { ...fetchOpts, headers });
    const cc = cacheControl(res.headers);
    const fetchedAt = Date.now();

    if (res.status === 304 && hit) {
      const refreshed: CacheEntry & { maxAgeMs?: number } = {
        ...hit.entry, fetchedAt, etag: res.headers.etag ?? hit.entry.etag,
        lastModified: res.headers['last-modified'] ?? hit.entry.lastModified,
      };
      if (cc.maxAgeMs !== undefined) { refreshed.maxAgeMs = cc.maxAgeMs; }
      if (!cc.noStore) { await cache.put(url, refreshed, hit.body); }
      return fromEntry(refreshed, hit.body, started, { revalidated: true });
    }

    const sha = sha256(res.body);
    if (res.status === 200 && !cc.noStore) {
      const entry: CacheEntry & { maxAgeMs?: number } = {
        url, finalUrl: res.url, status: res.status, contentType: res.contentType, fetchedAt, sha256: sha, size: res.body.length,
      };
      if (res.charset) { entry.charset = res.charset; }
      if (res.headers.etag) { entry.etag = res.headers.etag; }
      if (res.headers['last-modified']) { entry.lastModified = res.headers['last-modified']; }
      if (res.truncated) { entry.truncated = true; }
      if (cc.maxAgeMs !== undefined) { entry.maxAgeMs = cc.maxAgeMs; }
      await cache.put(url, entry, res.body);
    }
    return { ...res, fromCache: false, sha256: sha, fetchedAt };
  })();
  cache.inflight.set(flightKey, run);
  try { return await run; } finally { cache.inflight.delete(flightKey); }
}
