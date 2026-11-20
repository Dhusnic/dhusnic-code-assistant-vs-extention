/**
 * Web search across pluggable providers (SearXNG, Brave, Tavily, Bing, Google CSE, DuckDuckGo HTML).
 * Every request goes through the injected HttpFetch so the network layer (proxy, SSRF guard, limits)
 * applies uniformly and tests can run against canned responses. Keys travel in headers wherever the
 * API allows, so they never appear in logged URLs.
 */
import { HttpFetch, KeyLookup, SearchConfig, SearchProviderId, SearchQuery, SearchResult, WebError } from './types';
import { arr, clampInt, clean, decodeEntities, ensureOk, errMsg, httpError, isAbort, isoDate, mapLimit, obj, parseJson, stripTags } from './connectors/util';

export interface SearchContext { http: HttpFetch; key?: string; cfg: SearchConfig; signal?: AbortSignal }

export interface SearchProvider {
  id: SearchProviderId;
  label: string;
  needsKey: boolean;
  configured(cfg: SearchConfig, key?: string): boolean;
  search(q: SearchQuery, ctx: SearchContext): Promise<SearchResult[]>;
}

export interface SearchDeps { http: HttpFetch; keys: KeyLookup; signal?: AbortSignal }

export interface SearchOutcome { provider: SearchProviderId; results: SearchResult[]; notes: string[] }
export interface MultiSearchOutcome { provider: SearchProviderId; results: Array<SearchResult & { queries: number[] }>; notes: string[] }

export const DEFAULT_COUNT = 8;
export const MAX_COUNT = 20;
/** Provider preference for 'auto'; DuckDuckGo is always the last resort. */
export const AUTO_ORDER: SearchProviderId[] = ['searxng', 'brave', 'tavily', 'bing', 'google', 'duckduckgo'];

const countOf = (q: SearchQuery): number => clampInt(q.count, DEFAULT_COUNT, 1, MAX_COUNT);

/* ------------------------------------------------------------------ query helpers */

/** "https://www.Example.com/docs" → "example.com" (site: operators take bare hosts). */
function siteHost(s: string): string {
  return s.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/^www\./, '').replace(/^\*\./, '');
}

/** Folds sites / excludeSites / fileType into query operators for APIs without dedicated parameters. */
export function buildQueryString(q: SearchQuery, dialect: 'google' | 'bing' | 'plain'): string {
  const parts = [clean(q.query)];
  const sites = (q.sites ?? []).map(siteHost).filter(Boolean);
  if (sites.length === 1) { parts.push(`site:${sites[0]}`); }
  if (sites.length > 1) {
    const or = sites.map((s) => `site:${s}`).join(' OR ');
    parts.push(dialect === 'bing' ? `(${or})` : or);
  }
  for (const s of (q.excludeSites ?? []).map(siteHost).filter(Boolean)) { parts.push(`-site:${s}`); }
  const ft = clean(q.fileType).replace(/^\./, '').toLowerCase();
  if (ft) { parts.push(`filetype:${ft}`); }
  return parts.filter(Boolean).join(' ');
}

/** "en-US" → { lang: 'en', country: 'US' }. */
function splitRegion(region?: string): { lang?: string; country?: string } {
  const m = /^([a-z]{2,3})(?:[-_]([a-z]{2}))?$/i.exec(clean(region));
  return m ? { lang: m[1].toLowerCase(), country: m[2]?.toUpperCase() } : {};
}

function hit(title: unknown, url: unknown, snippet: unknown, published?: unknown): SearchResult | undefined {
  const u = clean(url);
  if (!/^https?:\/\//i.test(u)) { return undefined; }
  const r: SearchResult = { title: stripTags(title) || u, url: u, snippet: stripTags(snippet) };
  const p = isoDate(published);
  if (p) { r.published = p; }
  return r;
}

const hits = (rows: Array<SearchResult | undefined>): SearchResult[] => rows.filter((r): r is SearchResult => !!r);

/* ------------------------------------------------------------------ providers */

const SEARXNG_JSON_HINT = 'SearXNG: the instance does not serve JSON results. Ask its admin to enable them in settings.yml (search: formats: [html, json]).';

const searxng: SearchProvider = {
  id: 'searxng', label: 'SearXNG', needsKey: false,
  configured: (cfg) => !!clean(cfg.searxngUrl),
  async search(q, { http, cfg, signal }) {
    const base = clean(cfg.searxngUrl).replace(/\/+$/, '');
    if (!base) { throw new WebError('SearXNG: no instance URL configured', 'not_configured'); }
    const p = new URLSearchParams({ q: buildQueryString(q, 'plain'), format: 'json', categories: 'general', pageno: '1' });
    if (q.region) { p.set('language', q.region); }
    if (q.freshness) { p.set('time_range', q.freshness); }
    const res = await http(`${base}/search?${p}`, { headers: { Accept: 'application/json' }, signal });
    if (res.status === 403) { throw new WebError(SEARXNG_JSON_HINT, 'not_configured', 403); }
    ensureOk('SearXNG', res);
    if (!res.contentType.includes('json') && !/^\s*[{[]/.test(res.body.subarray(0, 64).toString('utf8'))) {
      throw new WebError(SEARXNG_JSON_HINT, 'not_configured', res.status);
    }
    const j = obj(parseJson('SearXNG', res));
    if (!Array.isArray(j.results)) { throw new WebError('SearXNG: unexpected response shape (no results array)', 'parse'); }
    return hits(j.results.map((r: any) => hit(r?.title, r?.url, r?.content, r?.publishedDate)));
  },
};

const brave: SearchProvider = {
  id: 'brave', label: 'Brave Search', needsKey: true,
  configured: (_cfg, key) => !!key,
  async search(q, { http, key, signal }) {
    if (!key) { throw new WebError('Brave Search: no API key stored', 'not_configured'); }
    const p = new URLSearchParams({ q: buildQueryString(q, 'plain'), count: String(countOf(q)) });
    const fresh = { day: 'pd', week: 'pw', month: 'pm', year: 'py' } as const;
    if (q.freshness) { p.set('freshness', fresh[q.freshness]); }
    const { lang, country } = splitRegion(q.region);
    if (country) { p.set('country', country); }
    if (lang) { p.set('search_lang', lang); }
    const res = await http(`https://api.search.brave.com/res/v1/web/search?${p}`, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key }, signal,
    });
    const j = obj(parseJson('Brave Search', ensureOk('Brave Search', res)));
    const rows = obj(j.web).results;
    if (rows !== undefined && !Array.isArray(rows)) { throw new WebError('Brave Search: unexpected response shape (web.results)', 'parse'); }
    return hits(arr(rows).map((r: any) => hit(r?.title, r?.url, r?.description, r?.page_age ?? r?.age)));
  },
};

const tavily: SearchProvider = {
  id: 'tavily', label: 'Tavily', needsKey: true,
  configured: (_cfg, key) => !!key,
  async search(q, { http, key, signal }) {
    if (!key) { throw new WebError('Tavily: no API key stored', 'not_configured'); }
    const body: Record<string, unknown> = {
      query: buildQueryString({ ...q, sites: undefined, excludeSites: undefined }, 'plain'),
      max_results: countOf(q), search_depth: 'basic',
    };
    const inc = (q.sites ?? []).map(siteHost).filter(Boolean);
    const exc = (q.excludeSites ?? []).map(siteHost).filter(Boolean);
    if (inc.length) { body.include_domains = inc; }
    if (exc.length) { body.exclude_domains = exc; }
    if (q.freshness) { body.time_range = q.freshness; }
    const res = await http('https://api.tavily.com/search', {
      method: 'POST', body: JSON.stringify(body), signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    });
    const j = obj(parseJson('Tavily', ensureOk('Tavily', res)));
    if (!Array.isArray(j.results)) { throw new WebError('Tavily: unexpected response shape (no results array)', 'parse'); }
    return hits(j.results.map((r: any) => hit(r?.title, r?.url, r?.content, r?.published_date)));
  },
};

const bing: SearchProvider = {
  id: 'bing', label: 'Bing', needsKey: true,
  configured: (_cfg, key) => !!key,
  async search(q, { http, key, signal }) {
    if (!key) { throw new WebError('Bing: no API key stored', 'not_configured'); }
    const p = new URLSearchParams({ q: buildQueryString(q, 'bing'), count: String(countOf(q)), responseFilter: 'Webpages', textDecorations: 'false' });
    if (q.region) { p.set('mkt', q.region); }
    if (q.freshness === 'year') {
      const now = new Date(), from = new Date(now.getTime() - 365 * 86_400_000);
      p.set('freshness', `${from.toISOString().slice(0, 10)}..${now.toISOString().slice(0, 10)}`);
    } else if (q.freshness) { p.set('freshness', q.freshness[0].toUpperCase() + q.freshness.slice(1)); }
    const res = await http(`https://api.bing.microsoft.com/v7.0/search?${p}`, {
      headers: { Accept: 'application/json', 'Ocp-Apim-Subscription-Key': key }, signal,
    });
    const j = obj(parseJson('Bing', ensureOk('Bing', res)));
    const rows = obj(j.webPages).value;
    if (rows !== undefined && !Array.isArray(rows)) { throw new WebError('Bing: unexpected response shape (webPages.value)', 'parse'); }
    return hits(arr(rows).map((r: any) => hit(r?.name, r?.url, r?.snippet, r?.datePublished ?? r?.dateLastCrawled)));
  },
};

const google: SearchProvider = {
  id: 'google', label: 'Google Programmable Search', needsKey: true,
  configured: (cfg, key) => !!key && !!clean(cfg.googleCx),
  async search(q, { http, key, cfg, signal }) {
    const cx = clean(cfg.googleCx);
    if (!key || !cx) { throw new WebError('Google Programmable Search: needs both an API key and an engine id (cx)', 'not_configured'); }
    const count = countOf(q);
    const { lang, country } = splitRegion(q.region);
    const page = async (start: number, num: number): Promise<SearchResult[]> => {
      // The Custom Search JSON API only accepts the key as a query parameter.
      const p = new URLSearchParams({ key, cx, q: buildQueryString({ ...q, fileType: undefined }, 'google'), num: String(num) });
      if (start > 1) { p.set('start', String(start)); }
      if (q.freshness) { p.set('dateRestrict', `${q.freshness[0]}1`); }
      if (lang) { p.set('lr', `lang_${lang}`); }
      if (country) { p.set('gl', country.toLowerCase()); }
      if (q.fileType) { p.set('fileType', clean(q.fileType).replace(/^\./, '').toLowerCase()); }
      const res = await http(`https://www.googleapis.com/customsearch/v1?${p}`, { headers: { Accept: 'application/json' }, signal });
      const j = obj(parseJson('Google Programmable Search', ensureOk('Google Programmable Search', res)));
      if (j.items !== undefined && !Array.isArray(j.items)) { throw new WebError('Google Programmable Search: unexpected response shape (items)', 'parse'); }
      return hits(arr(j.items).map((r: any) => hit(r?.title, r?.link, r?.snippet, obj(arr(obj(r?.pagemap).metatags)[0])['article:published_time'])));
    };
    const first = await page(1, Math.min(10, count));
    return count > 10 && first.length >= 10 ? [...first, ...await page(11, count - 10)] : first;
  },
};

/** Pulls `name="value"` out of an attribute string. */
function attr(attrs: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : '';
}

/** Resolves DuckDuckGo's redirect links ("//duckduckgo.com/l/?uddg=<encoded>") to the real target. */
export function decodeDuckDuckGoHref(href: string): string {
  const h = href.trim();
  if (!h) { return ''; }
  let u: URL;
  try { u = new URL(h.startsWith('//') ? `https:${h}` : h, 'https://duckduckgo.com/'); } catch { return ''; }
  if (/(^|\.)duckduckgo\.com$/i.test(u.hostname)) {
    const target = u.searchParams.get('uddg');
    return target && /^https?:\/\//i.test(target) ? target : '';
  }
  return /^https?:$/.test(u.protocol) ? u.href : '';
}

/** Parses the DuckDuckGo HTML endpoint; throws 'rate_limited' on the anomaly/captcha page. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  if (/anomaly-modal|Please complete the following challenge|challenge-form/i.test(html)) {
    throw new WebError('DuckDuckGo: blocked by its bot challenge (too many automated searches). Configure a search provider (SearXNG, Brave, Tavily, Bing or Google) for reliable results.', 'rate_limited');
  }
  const anchor = /<a\b([^>]*\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["'][^>]*)>([\s\S]*?)<\/a\s*>/gi;
  const found: Array<{ start: number; end: number; attrs: string; inner: string }> = [];
  for (let m: RegExpExecArray | null; (m = anchor.exec(html));) { found.push({ start: m.index, end: anchor.lastIndex, attrs: m[1], inner: m[2] }); }
  const out: SearchResult[] = [];
  found.forEach((a, i) => {
    const preamble = html.slice(i ? found[i - 1].end : 0, a.start);
    const wrappers = preamble.match(/class\s*=\s*["'][^"']*\bresult\b[^"']*["']/gi);
    const isAdBlock = !!wrappers && /result--ad\b/i.test(wrappers[wrappers.length - 1]);
    const href = attr(a.attrs, 'href');
    if (isAdBlock || /\/y\.js|[?&](ad_provider|ad_domain)=/i.test(href)) { return; }
    const url = decodeDuckDuckGoHref(href);
    const body = html.slice(a.end, i + 1 < found.length ? found[i + 1].start : html.length);
    const sn = /<(a|div|td|span)\b[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/\1\s*>/i.exec(body);
    const r = hit(a.inner, url, sn?.[2] ?? '');
    if (r) { out.push(r); }
  });
  return out;
}

const duckduckgo: SearchProvider = {
  id: 'duckduckgo', label: 'DuckDuckGo', needsKey: false,
  configured: () => true,
  async search(q, { http, signal }) {
    const p = new URLSearchParams({ q: buildQueryString(q, 'plain') });
    const { lang, country } = splitRegion(q.region);
    p.set('kl', lang && country ? `${country.toLowerCase()}-${lang}` : 'wt-wt');
    if (q.freshness) { p.set('df', q.freshness[0]); }
    const res = await http('https://html.duckduckgo.com/html/', {
      method: 'POST', body: p.toString(), signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
    });
    const html = res.body.toString('utf8');
    const blocked = httpError('DuckDuckGo', res, { auth: 'blocked the request (automated traffic). Configure a search provider for reliable results' });
    if (blocked) { if (res.status === 403 || res.status === 429) { parseDuckDuckGo(html); } throw blocked; }
    return parseDuckDuckGo(html).slice(0, countOf(q));
  },
};

export const PROVIDERS: Record<SearchProviderId, SearchProvider> = { searxng, brave, tavily, bing, google, duckduckgo };

/* ------------------------------------------------------------------ URL normalisation */

const TRACKING = /^(utm_.*|mc_.*|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|igshid|ref|ref_src|_ga|_gl)$/i;

/** Canonical form used to merge duplicates: lower-case host without www., no default port, fragment, trailing slash or tracking params; remaining params sorted. */
export function normalizeUrl(url: string): string {
  const raw = url.trim();
  let u: URL;
  try { u = new URL(raw); } catch { return raw; }
  if (!u.host) { return raw; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const params = [...u.searchParams].filter(([k]) => !TRACKING.test(k))
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const search = params.length ? `?${new URLSearchParams(params)}` : '';
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}${u.pathname.replace(/\/+$/, '')}${search}`;
}

/** Merges two hits for the same page: keeps the first title, the longer snippet and any date. */
function mergeInto(a: SearchResult, b: SearchResult): void {
  if (b.snippet.length > a.snippet.length) { a.snippet = b.snippet; }
  if (!a.published && b.published) { a.published = b.published; }
  if ((!a.title || a.title === a.url) && b.title) { a.title = b.title; }
}

export function dedupeResults(results: SearchResult[]): SearchResult[] {
  const byKey = new Map<string, SearchResult>();
  for (const r of results) {
    const k = normalizeUrl(r.url);
    const prev = byKey.get(k);
    if (prev) { mergeInto(prev, r); } else { byKey.set(k, { ...r }); }
  }
  return [...byKey.values()];
}

/* ------------------------------------------------------------------ orchestration */

function siteMatches(url: string, domains: string[]): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return false; }
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

async function lookupKey(keys: KeyLookup, id: SearchProviderId): Promise<string | undefined> {
  try { return clean(await keys(id)) || undefined; } catch { return undefined; }
}

function notConfigured(p: SearchProvider): WebError {
  const how = p.id === 'searxng' ? 'set the SearXNG instance URL'
    : p.id === 'google' ? 'store a Google API key and set the Programmable Search engine id (cx)'
      : `store a ${p.label} API key`;
  return new WebError(`${p.label} is not configured: ${how}, or choose provider "auto".`, 'not_configured');
}

/** The providers to try, in order, each with its key. */
async function providerChain(cfg: SearchConfig, keys: KeyLookup): Promise<Array<{ id: SearchProviderId; key?: string }>> {
  if (cfg.provider !== 'auto') {
    const p = PROVIDERS[cfg.provider];
    if (!p) { throw new WebError(`Unknown search provider "${String(cfg.provider)}"`, 'not_configured'); }
    const key = p.needsKey ? await lookupKey(keys, p.id) : undefined;
    if (!p.configured(cfg, key)) { throw notConfigured(p); }
    return [{ id: p.id, key }];
  }
  const chain: Array<{ id: SearchProviderId; key?: string }> = [];
  for (const id of AUTO_ORDER) {
    const p = PROVIDERS[id];
    const key = p.needsKey ? await lookupKey(keys, id) : undefined;
    if (p.configured(cfg, key)) { chain.push({ id, key }); }
  }
  return chain;
}

/** Client-side safety net for providers that ignore site operators, plus dedupe and count cap. */
function finish(raw: SearchResult[], q: SearchQuery, provider: SearchProviderId): SearchResult[] {
  const inc = (q.sites ?? []).map(siteHost).filter(Boolean);
  const exc = (q.excludeSites ?? []).map(siteHost).filter(Boolean);
  const kept = raw.filter((r) => (!inc.length || siteMatches(r.url, inc)) && !(exc.length && siteMatches(r.url, exc)));
  return dedupeResults(kept).slice(0, countOf(q)).map((r) => ({ ...r, provider }));
}

/**
 * Runs one search. With provider 'auto' a failing provider (missing key, 401/403, 429, outage) hands
 * over to the next configured one and finally DuckDuckGo, recording why in `notes`.
 */
export async function runSearch(cfg: SearchConfig, q: SearchQuery, deps: SearchDeps): Promise<SearchOutcome> {
  const query: SearchQuery = { ...q, query: clean(q.query), count: countOf(q) };
  if (!query.query) { throw new WebError('Search query is empty', 'unsupported'); }
  const notes: string[] = [];
  const chain = await providerChain(cfg, deps.keys);
  if (cfg.provider === 'auto' && chain[0]?.id === 'duckduckgo') {
    notes.push('No search provider is configured, so DuckDuckGo (best effort, may be rate limited) was used. Configure SearXNG, Brave, Tavily, Bing or Google for reliable results.');
  }
  for (let i = 0; i < chain.length; i++) {
    const { id, key } = chain[i];
    try {
      const raw = await PROVIDERS[id].search(query, { http: deps.http, key, cfg, signal: deps.signal });
      return { provider: id, results: finish(raw, query, id), notes };
    } catch (e) {
      const last = i === chain.length - 1;
      if (cfg.provider !== 'auto' || last || isAbort(e, deps.signal)) {
        if (!notes.length || !(e instanceof WebError)) { throw e; }
        throw new WebError(`${e.message} (earlier: ${notes.join(' ')})`, e.code, e.status);
      }
      notes.push(`${PROVIDERS[id].label} failed (${errMsg(e)}); fell back to ${PROVIDERS[chain[i + 1].id].label}.`);
    }
  }
  throw new WebError('No search provider available', 'not_configured');
}

/** RRF constant: dampens the advantage of top ranks so agreement across queries dominates. */
const RRF_K = 60;

/**
 * Runs several queries (≤ 5 in flight), merges hits by normalised URL and ranks them with
 * reciprocal-rank fusion, so pages found by many phrasings rise to the top.
 */
export async function multiSearch(cfg: SearchConfig, queries: SearchQuery[], deps: SearchDeps): Promise<MultiSearchOutcome> {
  if (!queries.length) { throw new WebError('No search queries given', 'unsupported'); }
  const outcomes = await mapLimit(queries, 5, (q) => runSearch(cfg, q, deps)
    .then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e })));
  const notes: string[] = [];
  const providers = new Map<SearchProviderId, number>();
  const merged = new Map<string, SearchResult & { queries: number[]; score: number; order: number }>();
  let order = 0, firstError: unknown;
  outcomes.forEach((o, qi) => {
    if (!o.ok) {
      if (isAbort(o.e, deps.signal)) { throw o.e; }
      firstError ??= o.e;
      notes.push(`Query ${qi + 1} ("${clean(queries[qi].query)}") failed: ${errMsg(o.e)}`);
      return;
    }
    providers.set(o.r.provider, (providers.get(o.r.provider) ?? 0) + 1);
    for (const n of o.r.notes) { if (!notes.includes(n)) { notes.push(n); } }
    o.r.results.forEach((r, rank) => {
      const k = normalizeUrl(r.url);
      const s = 1 / (RRF_K + rank + 1);
      const prev = merged.get(k);
      if (prev) {
        mergeInto(prev, r);
        prev.score += s;
        if (!prev.queries.includes(qi)) { prev.queries.push(qi); }
      } else { merged.set(k, { ...r, queries: [qi], score: s, order: order++ }); }
    });
  });
  if (!providers.size) { throw firstError; }
  const provider = [...providers.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const results = [...merged.values()].sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ score: _s, order: _o, ...r }) => r);
  return { provider, results, notes };
}
