import { describe, it } from 'node:test';
import * as assert from 'assert/strict';
import { FetchOptions, FetchResponse, HttpFetch, KeyLookup, SearchConfig, WebError } from '../core/web/types';
import { buildQueryString, decodeDuckDuckGoHref, dedupeResults, multiSearch, normalizeUrl, parseDuckDuckGo, PROVIDERS, runSearch } from '../core/web/search';
import {
  classifyUrlKind, compareVersions, cvss3BaseScore, githubLookup, goModuleEscape, isAffected, isPrerelease, minimalSafeVersion,
  normalizePaperId, packageInfo, paperDetails, paperSearch, parseArxivAtom, parseRepo, rebuildInvertedAbstract, techSearch, vulnLookup,
} from '../core/web/connectors';

/* ------------------------------------------------------------------ fake network */

interface Reply { status?: number; body?: unknown; headers?: Record<string, string>; contentType?: string }
type Handler = Reply | ((url: string, opts: FetchOptions) => Reply);
interface Call { url: string; opts: FetchOptions }

/** Routes by URL prefix (first match wins); unrouted URLs fail loudly so a wrong endpoint shows up as a test failure. */
function fakeHttp(routes: Array<[string, Handler]>): { http: HttpFetch; calls: Call[] } {
  const calls: Call[] = [];
  const http: HttpFetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const route = routes.find(([p]) => url.startsWith(p));
    if (!route) { throw new Error(`unrouted request: ${url}`); }
    const r = typeof route[1] === 'function' ? route[1](url, opts) : route[1];
    const isText = typeof r.body === 'string' || Buffer.isBuffer(r.body);
    const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(isText ? r.body as string : JSON.stringify(r.body ?? {}), 'utf8');
    const res: FetchResponse = {
      url, status: r.status ?? 200, headers: r.headers ?? {}, body, truncated: false, redirects: [], ms: 1,
      contentType: r.contentType ?? (isText ? 'text/html' : 'application/json'),
    };
    return res;
  };
  return { http, calls };
}

const keysOf = (m: Record<string, string>): KeyLookup => async (p) => m[p];
const noKeys: KeyLookup = async () => undefined;
const cfg = (o: Partial<SearchConfig> = {}): SearchConfig => ({ provider: 'auto', ...o });
const qs = (url: string): URLSearchParams => new URL(url).searchParams;

async function rejects(p: Promise<unknown>, code: string, re?: RegExp): Promise<WebError> {
  try { await p; } catch (e) {
    assert.ok(e instanceof WebError, `expected WebError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (re) { assert.match(e.message, re); }
    return e;
  }
  assert.fail('expected a rejection');
}

/* ------------------------------------------------------------------ fixtures */

const SEARX = {
  query: 'rust async', number_of_results: 0,
  results: [
    { url: 'https://tokio.rs/tokio/tutorial', title: 'Tutorial | <b>Tokio</b>', content: 'Tokio is an  asynchronous runtime &amp; more', engine: 'google', publishedDate: '2024-03-01T00:00:00' },
    { url: 'https://rust-lang.github.io/async-book/', title: 'Asynchronous Programming in Rust', content: 'The async book', publishedDate: null },
    { url: 'javascript:alert(1)', title: 'bad', content: '' },
  ],
};

const BRAVE = {
  type: 'search', query: { original: 'node streams' },
  web: { type: 'search', results: [
    { title: 'Stream | Node.js v22 Documentation', url: 'https://nodejs.org/api/stream.html', description: 'A <strong>stream</strong> is an abstract interface', page_age: '2024-05-02T10:00:00', age: 'May 2, 2024' },
    { title: 'Node.js Streams', url: 'https://www.freecodecamp.org/news/node-js-streams/', description: 'Guide', age: '3 days ago' },
  ] },
};

const TAVILY = {
  query: 'postgres vacuum', response_time: 1.2, images: [],
  results: [{ title: 'Routine Vacuuming', url: 'https://www.postgresql.org/docs/current/routine-vacuuming.html', content: 'PostgreSQL databases require periodic maintenance', score: 0.98, published_date: 'Tue, 05 Mar 2024 10:00:00 GMT' }],
};

const BING = {
  _type: 'SearchResponse', queryContext: { originalQuery: 'kubernetes ingress' },
  webPages: { totalEstimatedMatches: 1000, value: [
    { id: 'x', name: 'Ingress | Kubernetes', url: 'https://kubernetes.io/docs/concepts/services-networking/ingress/', snippet: 'Ingress exposes HTTP routes', dateLastCrawled: '2024-06-01T12:00:00.0000000Z' },
  ] },
};

const GOOGLE = {
  kind: 'customsearch#search', searchInformation: { totalResults: '2' },
  items: [
    { kind: 'customsearch#result', title: 'RFC 9110: HTTP Semantics', link: 'https://www.rfc-editor.org/rfc/rfc9110.pdf', snippet: 'This document describes\nthe overall architecture of HTTP', pagemap: { metatags: [{ 'article:published_time': '2022-06-01' }] } },
    { kind: 'customsearch#result', title: 'HTTP Semantics PDF', link: 'https://datatracker.ietf.org/doc/rfc9110.pdf', snippet: 'pdf' },
  ],
};

const DDG_HTML = `<!DOCTYPE html><html><body><div class="serp__results"><div id="links" class="results">
<div class="result results_links results_links_deep result--ad ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.example&amp;ad_provider=bingv7aa&amp;u3=abc">Buy Node.js hosting</a></h2>
    <a class="result__snippet" href="https://duckduckgo.com/y.js?x=1">Sponsored snippet</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fdocs%2F%3Fa%3D1%26b%3D2&amp;rut=4b1a">Node.js <b>Docs</b></a></h2>
    <div class="result__extras"><span class="result__url">nodejs.org/en/docs</span></div>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fdocs%2F">Learn about the <b>Node.js</b> runtime &amp; its APIs</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://developer.mozilla.org/en-US/docs/Web/JavaScript">JavaScript | MDN</a></h2>
    <a class="result__snippet" href="https://developer.mozilla.org/">JavaScript (JS) is a lightweight language</a>
  </div>
</div>
</div></div></body></html>`;

const DDG_CAPTCHA = `<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
<div>Please complete the following challenge to confirm this search was made by a human.</div></body></html>`;

/* ------------------------------------------------------------------ search providers */

describe('search providers: request shape and parsing', () => {
  it('searxng: GET /search with format=json, language, time_range; parses and drops non-http URLs', async () => {
    const { http, calls } = fakeHttp([['https://searx.example/search', { body: SEARX }]]);
    const out = await runSearch(cfg({ provider: 'searxng', searxngUrl: 'https://searx.example/' }), { query: 'rust  async', region: 'en-US', freshness: 'week' }, { http, keys: noKeys });
    const p = qs(calls[0].url);
    assert.equal(p.get('q'), 'rust async');
    assert.equal(p.get('format'), 'json');
    assert.equal(p.get('language'), 'en-US');
    assert.equal(p.get('time_range'), 'week');
    assert.equal(p.get('categories'), 'general');
    assert.equal(out.provider, 'searxng');
    assert.equal(out.results.length, 2);
    assert.deepEqual(out.results[0], { title: 'Tutorial | Tokio', url: 'https://tokio.rs/tokio/tutorial', snippet: 'Tokio is an asynchronous runtime & more', published: '2024-03-01', provider: 'searxng' });
  });

  it('searxng: JSON disabled (403 or HTML) → not_configured with the settings.yml hint', async () => {
    const forbidden = fakeHttp([['https://searx.example/', { status: 403, body: '<html>Forbidden</html>' }]]);
    await rejects(runSearch(cfg({ provider: 'searxng', searxngUrl: 'https://searx.example' }), { query: 'x' }, { http: forbidden.http, keys: noKeys }), 'not_configured', /formats: \[html, json\]/);
    const html = fakeHttp([['https://searx.example/', { body: '<!doctype html><html></html>' }]]);
    await rejects(runSearch(cfg({ provider: 'searxng', searxngUrl: 'https://searx.example' }), { query: 'x' }, { http: html.http, keys: noKeys }), 'not_configured', /json/);
  });

  it('brave: key in X-Subscription-Token header (not URL), freshness/country/lang params', async () => {
    const { http, calls } = fakeHttp([['https://api.search.brave.com/res/v1/web/search', { body: BRAVE }]]);
    const out = await runSearch(cfg({ provider: 'brave' }), { query: 'node streams', count: 5, freshness: 'week', region: 'de-DE' }, { http, keys: keysOf({ brave: 'BRAVE-KEY' }) });
    const p = qs(calls[0].url);
    assert.equal(p.get('q'), 'node streams');
    assert.equal(p.get('count'), '5');
    assert.equal(p.get('freshness'), 'pw');
    assert.equal(p.get('country'), 'DE');
    assert.equal(p.get('search_lang'), 'de');
    assert.equal(calls[0].opts.headers?.['X-Subscription-Token'], 'BRAVE-KEY');
    assert.ok(!calls[0].url.includes('BRAVE-KEY'));
    assert.equal(out.results[0].snippet, 'A stream is an abstract interface');
    assert.equal(out.results[0].published, '2024-05-02');
    assert.equal(out.results[1].published, undefined, '"3 days ago" is not a date');
  });

  it('tavily: POST JSON with include/exclude domains, time_range and Bearer key', async () => {
    const { http, calls } = fakeHttp([['https://api.tavily.com/search', { body: TAVILY }]]);
    const out = await runSearch(cfg({ provider: 'tavily' }), { query: 'postgres vacuum', sites: ['https://www.postgresql.org/docs'], excludeSites: ['reddit.com'], freshness: 'month', count: 3 }, { http, keys: keysOf({ tavily: 'tv-1' }) });
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers?.Authorization, 'Bearer tv-1');
    const body = JSON.parse(String(calls[0].opts.body));
    assert.deepEqual(body, { query: 'postgres vacuum', max_results: 3, search_depth: 'basic', include_domains: ['postgresql.org'], exclude_domains: ['reddit.com'], time_range: 'month' });
    assert.equal(out.results[0].url, 'https://www.postgresql.org/docs/current/routine-vacuuming.html');
    assert.equal(out.results[0].published, '2024-03-05');
  });

  it('bing: Ocp-Apim-Subscription-Key header, mkt, freshness, site operators folded into q', async () => {
    const { http, calls } = fakeHttp([['https://api.bing.microsoft.com/v7.0/search', { body: BING }]]);
    const out = await runSearch(cfg({ provider: 'bing' }), { query: 'kubernetes ingress', sites: ['kubernetes.io', 'github.com'], freshness: 'week', region: 'en-GB' }, { http, keys: keysOf({ bing: 'bk' }) });
    const p = qs(calls[0].url);
    assert.equal(p.get('q'), 'kubernetes ingress (site:kubernetes.io OR site:github.com)');
    assert.equal(p.get('mkt'), 'en-GB');
    assert.equal(p.get('freshness'), 'Week');
    assert.equal(calls[0].opts.headers?.['Ocp-Apim-Subscription-Key'], 'bk');
    assert.equal(out.results[0].title, 'Ingress | Kubernetes');
    assert.equal(out.results[0].published, '2024-06-01');
  });

  it('google: key+cx in query, num ≤ 10, dateRestrict, lr, fileType param; parses items', async () => {
    const { http, calls } = fakeHttp([['https://www.googleapis.com/customsearch/v1', { body: GOOGLE }]]);
    const out = await runSearch(cfg({ provider: 'google', googleCx: 'cx123' }), { query: 'http semantics', fileType: '.PDF', freshness: 'year', region: 'en-US', count: 8 }, { http, keys: keysOf({ google: 'gk' }) });
    const p = qs(calls[0].url);
    assert.equal(p.get('key'), 'gk');
    assert.equal(p.get('cx'), 'cx123');
    assert.equal(p.get('num'), '8');
    assert.equal(p.get('dateRestrict'), 'y1');
    assert.equal(p.get('lr'), 'lang_en');
    assert.equal(p.get('fileType'), 'pdf');
    assert.equal(p.get('q'), 'http semantics');
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].snippet, 'This document describes the overall architecture of HTTP');
    assert.equal(out.results[0].published, '2022-06-01');
  });

  it('google: not configured without cx', async () => {
    await rejects(runSearch(cfg({ provider: 'google' }), { query: 'x' }, { http: fakeHttp([]).http, keys: keysOf({ google: 'gk' }) }), 'not_configured', /cx/);
  });
});

describe('duckduckgo', () => {
  it('POSTs a form body with kl/df and decodes uddg links, skipping ads', async () => {
    const { http, calls } = fakeHttp([['https://html.duckduckgo.com/html/', { body: DDG_HTML }]]);
    const out = await runSearch(cfg({ provider: 'duckduckgo' }), { query: 'node docs', region: 'en-US', freshness: 'day' }, { http, keys: noKeys });
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers?.['Content-Type'], 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(String(calls[0].opts.body));
    assert.equal(form.get('q'), 'node docs');
    assert.equal(form.get('kl'), 'us-en');
    assert.equal(form.get('df'), 'd');
    assert.equal(out.results.length, 2);
    assert.deepEqual(out.results.map((r) => r.url), ['https://nodejs.org/en/docs/?a=1&b=2', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript']);
    assert.equal(out.results[0].title, 'Node.js Docs');
    assert.equal(out.results[0].snippet, 'Learn about the Node.js runtime & its APIs');
    assert.ok(!out.results.some((r) => /Sponsored|hosting/.test(r.title + r.snippet)));
  });

  it('decodeDuckDuckGoHref handles protocol-relative, absolute and junk hrefs', () => {
    assert.equal(decodeDuckDuckGoHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x'), 'https://example.com/a');
    assert.equal(decodeDuckDuckGoHref('https://example.org/x'), 'https://example.org/x');
    assert.equal(decodeDuckDuckGoHref('//duckduckgo.com/l/?uddg=javascript%3Aalert(1)'), '');
    assert.equal(decodeDuckDuckGoHref(''), '');
  });

  it('captcha / anomaly page → rate_limited advising to configure a provider', async () => {
    assert.throws(() => parseDuckDuckGo(DDG_CAPTCHA), (e: unknown) => e instanceof WebError && e.code === 'rate_limited' && /Configure a search provider/.test(e.message));
    const { http } = fakeHttp([['https://html.duckduckgo.com/', { status: 202, body: DDG_CAPTCHA }]]);
    await rejects(runSearch(cfg(), { query: 'x' }, { http, keys: noKeys }), 'rate_limited');
    const blocked = fakeHttp([['https://html.duckduckgo.com/', { status: 403, body: DDG_CAPTCHA }]]);
    await rejects(runSearch(cfg(), { query: 'x' }, { http: blocked.http, keys: noKeys }), 'rate_limited');
  });
});

describe('runSearch orchestration', () => {
  it('auto picks searxng first when its URL is set', async () => {
    const { http, calls } = fakeHttp([['https://searx.example/search', { body: SEARX }]]);
    const out = await runSearch(cfg({ searxngUrl: 'https://searx.example' }), { query: 'q' }, { http, keys: keysOf({ brave: 'b' }) });
    assert.equal(out.provider, 'searxng');
    assert.equal(calls.length, 1);
    assert.deepEqual(out.notes, []);
  });

  it('auto falls back brave (429) → tavily (401) → duckduckgo, with notes', async () => {
    const { http, calls } = fakeHttp([
      ['https://api.search.brave.com/', { status: 429, headers: { 'retry-after': '30' }, body: { type: 'ErrorResponse', error: { code: 'RATE_LIMITED', detail: 'Request rate limit exceeded' } } }],
      ['https://api.tavily.com/', { status: 401, body: { detail: { error: 'Unauthorized: missing or invalid API key.' } } }],
      ['https://html.duckduckgo.com/', { body: DDG_HTML }],
    ]);
    const out = await runSearch(cfg(), { query: 'node docs' }, { http, keys: keysOf({ brave: 'b', tavily: 't' }) });
    assert.equal(out.provider, 'duckduckgo');
    assert.deepEqual(calls.map((c) => new URL(c.url).host), ['api.search.brave.com', 'api.tavily.com', 'html.duckduckgo.com']);
    assert.equal(out.notes.length, 2);
    assert.match(out.notes[0], /Brave Search failed .*429.*retry after 30 s.*fell back to Tavily/);
    assert.match(out.notes[1], /Tavily failed .*401.*fell back to DuckDuckGo/);
    assert.ok(out.results.every((r) => r.provider === 'duckduckgo'));
  });

  it('auto with nothing configured uses DuckDuckGo and says so', async () => {
    const { http } = fakeHttp([['https://html.duckduckgo.com/', { body: DDG_HTML }]]);
    const out = await runSearch(cfg(), { query: 'node docs' }, { http, keys: noKeys });
    assert.equal(out.provider, 'duckduckgo');
    assert.match(out.notes[0], /No search provider is configured/);
  });

  it('an explicit provider does not fall back, and an unconfigured one is not_configured', async () => {
    const { http, calls } = fakeHttp([['https://api.search.brave.com/', { status: 500, body: 'upstream exploded' }]]);
    await rejects(runSearch(cfg({ provider: 'brave' }), { query: 'x' }, { http, keys: keysOf({ brave: 'b' }) }), 'http', /server error \(HTTP 500\)/);
    assert.equal(calls.length, 1);
    await rejects(runSearch(cfg({ provider: 'tavily' }), { query: 'x' }, { http, keys: noKeys }), 'not_configured', /Tavily/);
    await rejects(runSearch(cfg(), { query: '   ' }, { http, keys: noKeys }), 'unsupported');
  });

  it('filters results client-side by sites / excludeSites and caps the count', async () => {
    const { http } = fakeHttp([['https://searx.example/', { body: SEARX }]]);
    const out = await runSearch(cfg({ searxngUrl: 'https://searx.example' }), { query: 'q', sites: ['tokio.rs'] }, { http, keys: noKeys });
    assert.deepEqual(out.results.map((r) => r.url), ['https://tokio.rs/tokio/tutorial']);
    const ex = await runSearch(cfg({ searxngUrl: 'https://searx.example' }), { query: 'q', excludeSites: ['github.io'], count: 1 }, { http, keys: noKeys });
    assert.deepEqual(ex.results.map((r) => r.url), ['https://tokio.rs/tokio/tutorial']);
    const many = { results: Array.from({ length: 30 }, (_, i) => ({ url: `https://e.com/${i}`, title: `t${i}`, content: '' })) };
    const big = fakeHttp([['https://searx.example/', { body: many }]]);
    assert.equal((await runSearch(cfg({ searxngUrl: 'https://searx.example' }), { query: 'q', count: 50 }, { http: big.http, keys: noKeys })).results.length, 20);
    assert.equal((await runSearch(cfg({ searxngUrl: 'https://searx.example' }), { query: 'q' }, { http: big.http, keys: noKeys })).results.length, 8);
  });

  it('error mapping: 401, 429 with Retry-After, 500, bad JSON, wrong shape', async () => {
    const run = (r: Reply): Promise<unknown> => runSearch(cfg({ provider: 'brave' }), { query: 'x' }, { http: fakeHttp([['https://', r]]).http, keys: keysOf({ brave: 'k' }) });
    const e401 = await rejects(run({ status: 401, body: { error: { detail: 'bad token' } } }), 'http', /key is invalid or missing.*— bad token/);
    assert.equal(e401.status, 401);
    await rejects(run({ status: 429, headers: { 'retry-after': '12' } }), 'rate_limited', /retry after 12 s/);
    await rejects(run({ status: 503, body: '<html>down</html>' }), 'http', /server error \(HTTP 503\)/);
    await rejects(run({ body: '{"web": [1,', contentType: 'application/json' }), 'parse', /Brave Search: response was not valid JSON/);
    await rejects(run({ body: { web: { results: 'nope' } } }), 'parse', /Brave Search/);
    assert.deepEqual(await run({ body: { type: 'search' } }).then((r: any) => r.results), []);
  });

  it('PROVIDERS exposes all six with sensible configured() checks', () => {
    assert.deepEqual(Object.keys(PROVIDERS).sort(), ['bing', 'brave', 'duckduckgo', 'google', 'searxng', 'tavily']);
    assert.equal(PROVIDERS.google.configured({ provider: 'auto' }, 'k'), false);
    assert.equal(PROVIDERS.google.configured({ provider: 'auto', googleCx: 'c' }, 'k'), true);
    assert.equal(PROVIDERS.searxng.configured({ provider: 'auto', searxngUrl: ' ' }), false);
    assert.equal(PROVIDERS.duckduckgo.configured({ provider: 'auto' }), true);
  });
});

describe('query string, URL normalisation, dedupe and RRF', () => {
  it('buildQueryString folds sites / excludes / filetype per dialect', () => {
    const q = { query: ' tls  1.3 ', sites: ['https://www.ietf.org/rfc', 'rfc-editor.org'], excludeSites: ['medium.com'], fileType: 'PDF' };
    assert.equal(buildQueryString(q, 'google'), 'tls 1.3 site:ietf.org OR site:rfc-editor.org -site:medium.com filetype:pdf');
    assert.equal(buildQueryString(q, 'bing'), 'tls 1.3 (site:ietf.org OR site:rfc-editor.org) -site:medium.com filetype:pdf');
    assert.equal(buildQueryString({ query: 'x', sites: ['a.com'] }, 'plain'), 'x site:a.com');
    assert.equal(buildQueryString({ query: 'x' }, 'plain'), 'x');
  });

  it('normalizeUrl', () => {
    assert.equal(normalizeUrl('HTTPS://WWW.Example.COM:443/a/b/?utm_source=x&b=2&a=1&fbclid=z#frag'), 'https://example.com/a/b?a=1&b=2');
    assert.equal(normalizeUrl('http://example.com:80/'), 'http://example.com');
    assert.equal(normalizeUrl('https://example.com:8443/x?gclid=1&ref=hn&mc_cid=3'), 'https://example.com:8443/x');
    assert.equal(normalizeUrl('https://example.com/Path?q=a%20b'), 'https://example.com/Path?q=a+b');
    assert.equal(normalizeUrl('not a url'), 'not a url');
  });

  it('dedupeResults keeps first position, merges the longer snippet and a date', () => {
    const out = dedupeResults([
      { title: 'A', url: 'https://www.a.com/x/', snippet: 'short' },
      { title: 'B', url: 'https://b.com', snippet: 'b' },
      { title: 'A2', url: 'https://a.com/x?utm_medium=y', snippet: 'a much longer snippet', published: '2024-01-01' },
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { title: 'A', url: 'https://www.a.com/x/', snippet: 'a much longer snippet', published: '2024-01-01' });
  });

  it('multiSearch merges by normalised URL and ranks by reciprocal-rank fusion', async () => {
    const byQuery: Record<string, unknown[]> = {
      one: [{ url: 'https://a.com/', title: 'A', content: 'a' }, { url: 'https://b.com/', title: 'B', content: 'b' }, { url: 'https://c.com/', title: 'C', content: 'c' }],
      two: [{ url: 'https://c.com', title: 'C', content: 'c longer snippet' }, { url: 'https://www.b.com/?utm_source=t', title: 'B', content: 'b' }],
      three: [{ url: 'https://d.com/', title: 'D', content: 'd' }],
    };
    const { http, calls } = fakeHttp([['https://searx.example/search', (url) => ({ body: { results: byQuery[qs(url).get('q') ?? ''] ?? [] } })]]);
    const out = await multiSearch(cfg({ searxngUrl: 'https://searx.example' }), [{ query: 'one' }, { query: 'two' }, { query: 'three' }], { http, keys: noKeys });
    assert.equal(calls.length, 3);
    assert.equal(out.provider, 'searxng');
    // c: 1/63 + 1/61 > b: 1/62 + 1/62 > a: 1/61 = d: 1/61 (a before d by first appearance)
    assert.deepEqual(out.results.map((r) => r.title), ['C', 'B', 'A', 'D']);
    assert.deepEqual(out.results[1].queries, [0, 1]);
    assert.equal(out.results[0].snippet, 'c longer snippet');
    assert.equal(out.results[1].url, 'https://b.com/', 'keeps the first-seen URL');
  });

  it('multiSearch keeps going when one query fails, and throws only when all fail', async () => {
    const { http } = fakeHttp([['https://searx.example/search', (url) => (qs(url).get('q') === 'bad' ? { status: 500 } : { body: SEARX })]]);
    const out = await multiSearch(cfg({ provider: 'searxng', searxngUrl: 'https://searx.example' }), [{ query: 'bad' }, { query: 'good' }], { http, keys: noKeys });
    assert.equal(out.results.length, 2);
    assert.match(out.notes[0], /Query 1 \("bad"\) failed/);
    await rejects(multiSearch(cfg({ provider: 'searxng', searxngUrl: 'https://searx.example' }), [{ query: 'bad' }], { http, keys: noKeys }), 'http');
  });
});

/* ------------------------------------------------------------------ papers */

const ARXIV_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title type="html">ArXiv Query: search_query=all:attention</title>
  <id>http://arxiv.org/api/abc</id>
  <opensearch:totalResults>2</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-08-02T00:41:18Z</updated>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All
      You Need</title>
    <summary>  The dominant sequence transduction models are based on complex recurrent &amp; convolutional neural networks.
    </summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <author><name>Niki Parmar</name></author>
    <author><name>Jakob Uszkoreit</name></author>
    <author><name>Llion Jones</name></author>
    <author><name>Aidan N. Gomez</name></author>
    <arxiv:comment>15 pages</arxiv:comment>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
    <arxiv:primary_category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/hep-th/9901001v1</id>
    <published>1999-01-01T00:00:00Z</published>
    <title>Old style id</title>
    <summary>Abstract.</summary>
    <author><name>A. Physicist</name></author>
    <arxiv:doi>10.1000/xyz</arxiv:doi>
    <arxiv:journal_ref>Phys. Rev. D 60 (1999)</arxiv:journal_ref>
    <arxiv:primary_category term="hep-th"/>
  </entry>
</feed>`;

const S2_SEARCH = {
  total: 2, offset: 0, next: 2,
  data: [
    {
      paperId: '204e3073870fae3d05bcbc2f6a8e263d9b72e776', url: 'https://www.semanticscholar.org/paper/204e3073870fae3d05bcbc2f6a8e263d9b72e776',
      title: 'Attention is All you Need', year: 2017, venue: 'Neural Information Processing Systems', citationCount: 120345,
      publicationDate: '2017-06-12', externalIds: { DBLP: 'conf/nips/VaswaniSPUJGKP17', ArXiv: '1706.03762', CorpusId: 13756489 },
      openAccessPdf: null, abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. '.repeat(6),
      authors: ['Ashish Vaswani', 'Noam M. Shazeer', 'Niki Parmar', 'Jakob Uszkoreit', 'Llion Jones', 'Aidan N. Gomez'].map((name, i) => ({ authorId: String(i), name })),
    },
    {
      paperId: 'abc', url: 'https://www.semanticscholar.org/paper/abc', title: 'BERT', year: 2019, venue: 'NAACL', citationCount: 90000,
      externalIds: { DOI: '10.18653/v1/N19-1423' }, openAccessPdf: { url: 'https://aclanthology.org/N19-1423.pdf', status: 'GREEN' }, abstract: null,
      authors: [{ authorId: '1', name: 'Jacob Devlin' }],
    },
  ],
};

const OPENALEX = {
  meta: { count: 1, page: 1, per_page: 5 },
  results: [{
    id: 'https://openalex.org/W2963403868', doi: 'https://doi.org/10.48550/arxiv.1706.03762', display_name: 'Attention Is All You Need',
    publication_year: 2017, publication_date: '2017-06-12', cited_by_count: 80000,
    authorships: [{ author: { display_name: 'Ashish Vaswani' } }, { author: { display_name: 'Noam Shazeer' } }],
    primary_location: { source: { display_name: 'arXiv (Cornell University)' } },
    locations: [{ landing_page_url: 'https://arxiv.org/abs/1706.03762v5' }],
    best_oa_location: { pdf_url: 'https://arxiv.org/pdf/1706.03762' },
    abstract_inverted_index: { The: [0], dominant: [1], sequence: [2], models: [3, 6], use: [4], big: [5] },
  }],
};

describe('papers', () => {
  it('parseArxivAtom reads entries, authors, ids, pdf links and categories', () => {
    const ps = parseArxivAtom(ARXIV_ATOM);
    assert.equal(ps.length, 2);
    assert.equal(ps[0].title, 'Attention Is All You Need');
    assert.equal(ps[0].arxivId, '1706.03762');
    assert.equal(ps[0].url, 'https://arxiv.org/abs/1706.03762');
    assert.equal(ps[0].pdf, 'https://arxiv.org/pdf/1706.03762v7');
    assert.equal(ps[0].year, 2017);
    assert.equal(ps[0].published, '2017-06-12');
    assert.equal(ps[0].venue, 'arXiv cs.CL');
    assert.equal(ps[0].authors.length, 6);
    assert.match(ps[0].abstract ?? '', /^The dominant .* recurrent & convolutional/);
    assert.equal(ps[1].arxivId, 'hep-th/9901001');
    assert.equal(ps[1].doi, '10.1000/xyz');
    assert.equal(ps[1].venue, 'Phys. Rev. D 60 (1999)');
  });

  it('parseArxivAtom turns the API error entry into a WebError', () => {
    const err = '<feed><entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_1234</id><title>Error</title><summary>incorrect id format for 1234</summary></entry></feed>';
    assert.throws(() => parseArxivAtom(err), /arXiv: query rejected — incorrect id format/);
  });

  it('paperSearch via Semantic Scholar: request shape, x-api-key, rendering', async () => {
    const { http, calls } = fakeHttp([['https://api.semanticscholar.org/graph/v1/paper/search', { body: S2_SEARCH }]]);
    const r = await paperSearch(http, { query: 'attention', limit: 5, yearFrom: 2015, yearTo: 2024 }, { keys: keysOf({ semanticscholar: 's2key' }) });
    const p = qs(calls[0].url);
    assert.equal(p.get('query'), 'attention');
    assert.equal(p.get('limit'), '5');
    assert.equal(p.get('year'), '2015-2024');
    assert.match(p.get('fields') ?? '', /title,authors,year,venue,citationCount,externalIds,openAccessPdf,abstract,url/);
    assert.equal(calls[0].opts.headers?.['x-api-key'], 's2key');
    assert.equal(r.title, 'Semantic Scholar · 2 papers for “attention”');
    assert.match(r.markdown, /^Semantic Scholar · 2 papers for “attention”/);
    assert.match(r.markdown, /1\. \*\*Attention is All you Need\*\* \(2017\) — Ashish Vaswani, Noam M\. Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones et al\. · Neural Information Processing Systems · 120,345 citations/);
    assert.match(r.markdown, /arXiv: 1706\.03762/);
    assert.match(r.markdown, /DOI: 10\.18653\/v1\/N19-1423 · PDF: https:\/\/aclanthology\.org\/N19-1423\.pdf/);
    const abstractLine = r.markdown.split('\n').find((l) => l.startsWith('   The dominant')) ?? '';
    assert.ok(abstractLine.length <= 3 + 350, `abstract too long: ${abstractLine.length}`);
    assert.equal(r.sources[0].kind, 'academic');
    assert.equal(r.sources[0].published, '2017-06-12');
  });

  it('paperSearch auto falls back to arXiv when Semantic Scholar answers 429', async () => {
    const { http, calls } = fakeHttp([
      ['https://api.semanticscholar.org/', { status: 429, body: { message: 'Too Many Requests. Please wait and try again or apply for a key for higher rate limits.' } }],
      ['http://export.arxiv.org/api/query', { body: ARXIV_ATOM, contentType: 'application/atom+xml' }],
    ]);
    const r = await paperSearch(http, { query: 'attention is all', limit: 3, sort: 'date' });
    const p = qs(calls[1].url);
    assert.equal(p.get('search_query'), 'all:attention AND all:is AND all:all');
    assert.equal(p.get('sortBy'), 'submittedDate');
    assert.equal(p.get('max_results'), '3');
    assert.match(r.title, /^arXiv · 2 papers/);
    assert.match(r.markdown, /_Semantic Scholar failed \(.*429.*\); used arXiv instead\._/);
    assert.match(r.markdown, /PDF: https:\/\/arxiv\.org\/pdf\/1706\.03762v7/);
  });

  it('paperSearch via OpenAlex rebuilds the inverted-index abstract', async () => {
    const { http, calls } = fakeHttp([['https://api.openalex.org/works', { body: OPENALEX }]]);
    const r = await paperSearch(http, { query: 'attention', source: 'openalex', limit: 5, yearFrom: 2017 });
    const p = qs(calls[0].url);
    assert.equal(p.get('search'), 'attention');
    assert.equal(p.get('per-page'), '5');
    assert.equal(p.get('filter'), 'from_publication_date:2017-01-01');
    assert.match(r.markdown, /The dominant sequence models use big models/);
    assert.match(r.markdown, /DOI: 10\.48550\/arxiv\.1706\.03762 · arXiv: 1706\.03762 · PDF: https:\/\/arxiv\.org\/pdf\/1706\.03762/);
    assert.equal(rebuildInvertedAbstract({ b: [1], a: [0], c: [2, 'x'] }), 'a b c');
    assert.equal(rebuildInvertedAbstract(null), '');
  });

  it('paperSearch keeps markdown within 12 000 characters', async () => {
    const many = { data: Array.from({ length: 50 }, (_, i) => ({ ...S2_SEARCH.data[0], paperId: `p${i}`, url: `https://www.semanticscholar.org/paper/p${i}`, title: `Paper ${i} ${'long title words '.repeat(10)}` })) };
    const { http } = fakeHttp([['https://api.semanticscholar.org/', { body: many }]]);
    const r = await paperSearch(http, { query: 'x', limit: 50 });
    assert.ok(r.markdown.length <= 12_100, `markdown ${r.markdown.length}`);
    assert.match(r.markdown, /more characters\]$/);
  });

  it('normalizePaperId and paperDetails with citations', async () => {
    assert.equal(normalizePaperId('https://doi.org/10.1145/3292500.3330701'), 'DOI:10.1145/3292500.3330701');
    assert.equal(normalizePaperId('10.1145/3292500'), 'DOI:10.1145/3292500');
    assert.equal(normalizePaperId('https://arxiv.org/abs/2101.00001v2'), 'ARXIV:2101.00001');
    assert.equal(normalizePaperId('https://arxiv.org/pdf/2101.00001v2.pdf'), 'ARXIV:2101.00001');
    assert.equal(normalizePaperId('arXiv:2101.00001v3'), 'ARXIV:2101.00001');
    assert.equal(normalizePaperId('2101.00001'), 'ARXIV:2101.00001');
    assert.equal(normalizePaperId('https://www.semanticscholar.org/paper/Attention/204e3073870fae3d05bcbc2f6a8e263d9b72e776'), '204e3073870fae3d05bcbc2f6a8e263d9b72e776');
    const { http, calls } = fakeHttp([
      ['https://api.semanticscholar.org/graph/v1/paper/ARXIV:1706.03762?', { body: { ...S2_SEARCH.data[0], tldr: { model: 'tldr@v2', text: 'A new architecture based solely on attention.' }, referenceCount: 40, influentialCitationCount: 9000 } }],
      ['https://api.semanticscholar.org/graph/v1/paper/204e3073870fae3d05bcbc2f6a8e263d9b72e776/citations', { body: { offset: 0, data: [{ citingPaper: { paperId: 'c1', title: 'BERT', year: 2019, authors: [{ name: 'Jacob Devlin' }], citationCount: 5, url: 'https://www.semanticscholar.org/paper/c1' } }] } }],
    ]);
    const r = await paperDetails(http, { id: 'arXiv:1706.03762', include: ['citations'], limit: 3 });
    assert.match(calls[0].url, /fields=.*tldr/);
    assert.match(calls[1].url, /limit=3/);
    assert.match(r.markdown, /\*\*TL;DR:\*\* A new architecture/);
    assert.match(r.markdown, /### Cited by \(1 shown of 120,345\)/);
    assert.match(r.markdown, /1\. \*\*BERT\*\* \(2019\) — Jacob Devlin/);
    assert.equal(r.sources.length, 2);
  });
});

/* ------------------------------------------------------------------ packages */

const NPM_DOC = {
  _id: '@types/node', name: '@types/node', description: 'TypeScript definitions for node',
  'dist-tags': { latest: '22.5.0', next: '23.0.0-beta.1' },
  versions: {
    '20.0.0': { name: '@types/node', version: '20.0.0', license: 'MIT', dependencies: {} },
    '22.4.0': { name: '@types/node', version: '22.4.0', license: 'MIT', deprecated: 'use 22.5.0' },
    '22.5.0': { name: '@types/node', version: '22.5.0', license: 'MIT', dependencies: { 'undici-types': '~6.19.2' }, repository: { type: 'git', url: 'https://github.com/DefinitelyTyped/DefinitelyTyped.git', directory: 'types/node' }, homepage: 'https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node' },
    '23.0.0-beta.1': { name: '@types/node', version: '23.0.0-beta.1', license: 'MIT' },
  },
  time: { created: '2016-05-17T18:00:00.000Z', modified: '2024-08-20T00:00:00.000Z', '20.0.0': '2023-04-20T00:00:00.000Z', '22.4.0': '2024-08-10T00:00:00.000Z', '22.5.0': '2024-08-19T00:00:00.000Z', '23.0.0-beta.1': '2024-08-01T00:00:00.000Z' },
  maintainers: [{ name: 'types', email: 'ts-npm-types@microsoft.com' }],
  license: 'MIT',
};

describe('packageInfo', () => {
  it('npm: scoped name encodes "/" as %2F, downloads, deps, deprecation of recent versions', async () => {
    const { http, calls } = fakeHttp([
      ['https://registry.npmjs.org/@types%2Fnode', { body: NPM_DOC }],
      ['https://api.npmjs.org/downloads/point/last-week/@types/node', { body: { downloads: 51234567, start: '2024-08-12', end: '2024-08-18', package: '@types/node' } }],
    ]);
    const r = await packageInfo(http, { ecosystem: 'npm', name: '@types/node' });
    assert.equal(calls[0].url, 'https://registry.npmjs.org/@types%2Fnode');
    assert.equal(r.title, 'npm · @types/node 22.5.0');
    assert.match(r.markdown, /Latest: 22\.5\.0 \(2024-08-19\) · License: MIT · Dependencies: 1 · Maintainers: 1/);
    assert.match(r.markdown, /Downloads: 51,234,567 last week/);
    assert.match(r.markdown, /- 22\.4\.0 — 2024-08-10 \(deprecated\)/);
    assert.match(r.markdown, /Repository: https:\/\/github\.com\/DefinitelyTyped\/DefinitelyTyped/);
    assert.equal(r.sources[0].kind, 'package-registry');
    const v = await packageInfo(http, { ecosystem: 'npm', name: '@types/node', version: '22.4.0' });
    assert.match(v.markdown, /DEPRECATED: use 22\.5\.0/);
    assert.match(v.markdown, /Shown: 22\.4\.0 \(2024-08-10\)/);
  });

  it('npm: 404 maps to a helpful not-found error', async () => {
    const { http } = fakeHttp([['https://registry.npmjs.org/', { status: 404, body: { error: 'Not found' } }], ['https://api.npmjs.org/', { status: 404, body: {} }]]);
    await rejects(packageInfo(http, { ecosystem: 'npm', name: 'no-such-pkg-xyz' }), 'http', /package "no-such-pkg-xyz" not found on npm/);
  });

  it('pypi: license, yanked flag, requires_dist without extras, no download note', async () => {
    const file = (t: string, yanked = false): object => ({ filename: 'x.whl', upload_time: t.replace('Z', ''), upload_time_iso_8601: t, yanked, yanked_reason: yanked ? 'broken wheel' : null });
    const doc = {
      info: {
        name: 'requests', version: '2.32.3', summary: 'Python HTTP for Humans.', license: 'Apache-2.0', home_page: 'https://requests.readthedocs.io',
        project_urls: { Documentation: 'https://requests.readthedocs.io', Source: 'https://github.com/psf/requests' },
        requires_dist: ['charset-normalizer<4,>=2', 'idna<4,>=2.5', 'urllib3<3,>=1.21.1', 'certifi>=2017.4.17', 'PySocks!=1.5.7,>=1.5.6; extra == "socks"'],
        classifiers: ['License :: OSI Approved :: Apache Software License'],
      },
      releases: { '2.31.0': [file('2023-05-22T15:12:44Z')], '2.32.0': [file('2024-05-20T15:00:00Z', true)], '2.32.3': [file('2024-05-29T15:37:47Z')], '0.0.1': [] },
    };
    const { http } = fakeHttp([['https://pypi.org/pypi/requests/json', { body: doc }]]);
    const r = await packageInfo(http, { ecosystem: 'pypi', name: 'requests' });
    assert.match(r.markdown, /Latest: 2\.32\.3 \(2024-05-29\) · License: Apache-2\.0 · Dependencies: 4/);
    assert.match(r.markdown, /Repository: https:\/\/github\.com\/psf\/requests/);
    assert.match(r.markdown, /- 2\.32\.0 — 2024-05-20 \(yanked\)/);
    assert.match(r.markdown, /no official download counts/);
    assert.ok(!/0\.0\.1/.test(r.markdown));
  });

  it('crates: downloads, deps (non-dev), owners, yanked', async () => {
    const { http, calls } = fakeHttp([
      ['https://crates.io/api/v1/crates/serde/1.0.210/dependencies', { body: { dependencies: [{ crate_id: 'serde_derive', kind: 'normal' }, { crate_id: 'serde_derive', kind: 'dev' }] } }],
      ['https://crates.io/api/v1/crates/serde/owners', { body: { users: [{ login: 'dtolnay' }, { login: 'github:serde-rs:publish' }] } }],
      ['https://crates.io/api/v1/crates/serde', { body: {
        crate: { id: 'serde', name: 'serde', description: 'A generic serialization/deserialization framework', homepage: 'https://serde.rs', repository: 'https://github.com/serde-rs/serde', downloads: 400000000, recent_downloads: 60000000, max_version: '1.0.210', max_stable_version: '1.0.210', newest_version: '1.0.210' },
        versions: [
          { num: '1.0.210', created_at: '2024-09-06T00:00:00Z', license: 'MIT OR Apache-2.0', yanked: false },
          { num: '1.0.209', created_at: '2024-08-24T00:00:00Z', license: 'MIT OR Apache-2.0', yanked: true },
        ],
      } }],
    ]);
    const r = await packageInfo(http, { ecosystem: 'crates', name: 'serde' });
    assert.equal(calls[0].url, 'https://crates.io/api/v1/crates/serde');
    assert.match(r.markdown, /Latest: 1\.0\.210 \(2024-09-06\) · License: MIT OR Apache-2\.0 · Dependencies: 1 · Maintainers: 2/);
    assert.match(r.markdown, /Downloads: 60,000,000 last 90 days, 400,000,000 total/);
    assert.match(r.markdown, /1\.0\.209 — 2024-08-24 \(yanked\)/);
  });

  it('go: module path case-encoding for /@v/list, /@latest, .info and .mod', async () => {
    assert.equal(goModuleEscape('github.com/BurntSushi/toml'), 'github.com/!burnt!sushi/toml');
    const base = 'https://proxy.golang.org/github.com/!burnt!sushi/toml/@';
    const { http, calls } = fakeHttp([
      [`${base}v/list`, { body: 'v1.3.2\nv1.4.0\nv1.2.1\n', contentType: 'text/plain' }],
      [`${base}latest`, { body: { Version: 'v1.4.0', Time: '2024-06-06T00:00:00Z' } }],
      [`${base}v/v1.4.0.mod`, { body: 'module github.com/BurntSushi/toml\n\ngo 1.18\n\nrequire (\n\tgolang.org/x/text v0.3.0\n\tgithub.com/x/y v1.0.0 // indirect\n)\n', contentType: 'text/plain' }],
      [`${base}v/`, (url) => ({ body: { Version: /v([\d.]+)\.info$/.exec(url)?.[0].slice(0, -5), Time: url.includes('v1.3.2') ? '2023-06-01T00:00:00Z' : url.includes('v1.2.1') ? '2022-10-01T00:00:00Z' : '2024-06-06T00:00:00Z' } })],
    ]);
    const r = await packageInfo(http, { ecosystem: 'go', name: 'github.com/BurntSushi/toml' });
    assert.ok(calls.every((c) => c.url.startsWith(base)), calls.map((c) => c.url).join('\n'));
    assert.equal(r.title, 'Go module proxy · github.com/BurntSushi/toml v1.4.0');
    assert.match(r.markdown, /Latest: v1\.4\.0 \(2024-06-06\) · Dependencies: 1/);
    assert.match(r.markdown, /Recent versions:\n- v1\.4\.0 — 2024-06-06\n- v1\.3\.2 — 2023-06-01\n- v1\.2\.1 — 2022-10-01/);
    assert.match(r.markdown, /Repository: https:\/\/github\.com\/BurntSushi\/toml/);
  });

  it('rejects an unknown ecosystem', async () => {
    await rejects(packageInfo(fakeHttp([]).http, { ecosystem: 'cpan' as never, name: 'x' }), 'unsupported');
  });
});

/* ------------------------------------------------------------------ vulnerabilities */

const lodashVulns = {
  vulns: [
    {
      id: 'GHSA-35jh-r3h4-6jhm', summary: 'Command Injection in lodash', aliases: ['CVE-2021-23337'], published: '2021-05-06T16:05:51Z',
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H' }],
      affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
      database_specific: { severity: 'HIGH', cwe_ids: ['CWE-77'] },
    },
    {
      id: 'GHSA-p6mc-m468-83gw', summary: 'Prototype Pollution in lodash', aliases: ['CVE-2020-8203'], published: '2020-07-15T19:15:48Z',
      affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '3.7.0' }, { fixed: '4.17.19' }] }] }],
      database_specific: { severity: 'HIGH' },
    },
    {
      id: 'GHSA-29mw-wpgm-hmr9', summary: 'Regular Expression Denial of Service (ReDoS) in lodash', aliases: ['CVE-2020-28500'], published: '2022-01-06T20:30:46Z',
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L' }],
      affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '4.0.0' }, { fixed: '4.17.21' }] }] }],
      database_specific: { severity: 'MODERATE' },
    },
    {
      id: 'GHSA-fake-crit', summary: 'Critical in a pre-release line', published: '2024-01-01T00:00:00Z',
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H' }],
      affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '4.17.0' }, { fixed: '4.17.21-rc.1' }] }] }],
    },
  ],
};

describe('vulnLookup', () => {
  it('semver-ish comparator: numeric parts, pre-releases sort lower, Maven qualifiers', () => {
    assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
    assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
    assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0);
    assert.ok(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10') < 0);
    assert.ok(compareVersions('1.0.0-beta', '1.0.0-alpha.beta') > 0);
    assert.ok(compareVersions('2.0rc1', '2.0') < 0);
    assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
    assert.equal(compareVersions('1.2', '1.2.0'), 0);
    assert.equal(compareVersions('5.3.0.Final', '5.3.0'), 0);
    assert.ok(compareVersions('1.0.post1', '1.0') > 0);
    assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0);
    assert.equal(isPrerelease('3.0.0-SNAPSHOT'), true);
    assert.equal(isPrerelease('3.0.0'), false);
  });

  it('isAffected walks OSV events; minimalSafeVersion picks the smallest fix that clears all', () => {
    const multi = { package: { name: 'p', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '2.0.0' }, { fixed: '2.3.0' }, { introduced: '1.0.0' }, { fixed: '1.5.0' }] }] };
    assert.equal(isAffected('1.2.0', multi), true);
    assert.equal(isAffected('1.7.0', multi), false);
    assert.equal(isAffected('2.2.9', multi), true);
    assert.equal(isAffected('2.3.0', multi), false);
    assert.equal(isAffected('0.9.0', multi), false);
    assert.equal(isAffected('1.0.1', { versions: ['1.0.1'] }), true);
    assert.equal(isAffected('1.1.0', { ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { last_affected: '1.0.5' }] }] }), false);
    assert.equal(isAffected('1.0.5', { ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { last_affected: '1.0.5' }] }] }), true);
    // 4.17.21-rc.1 < 4.17.21, so the rc fixes only the critical one; 4.17.21 clears all.
    assert.equal(minimalSafeVersion(lodashVulns.vulns, 'lodash', 'npm', '4.17.15'), '4.17.21');
    assert.equal(minimalSafeVersion([lodashVulns.vulns[3]], 'lodash', 'npm', '4.17.15'), '4.17.21-rc.1');
    assert.equal(minimalSafeVersion([{ affected: [{ package: { name: 'x', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }] }] }], 'x', 'npm'), undefined);
  });

  it('cvss3BaseScore matches the spec for common vectors', () => {
    assert.equal(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8);
    assert.equal(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H'), 10);
    assert.equal(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H'), 7.2);
    assert.equal(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L'), 5.3);
    assert.equal(cvss3BaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'), undefined);
  });

  it('by package: OSV POST body, severity order, fixed versions and verdict', async () => {
    const { http, calls } = fakeHttp([['https://api.osv.dev/v1/query', { body: lodashVulns }]]);
    const r = await vulnLookup(http, { ecosystem: 'npm', package: 'lodash', version: '4.17.15' });
    assert.equal(calls[0].opts.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].opts.body)), { package: { name: 'lodash', ecosystem: 'npm' }, version: '4.17.15' });
    assert.equal(r.title, 'OSV · 4 known vulnerabilities for npm lodash@4.17.15');
    const order = [...r.markdown.matchAll(/^\d+\. \*\*(GHSA-[\w-]+)\*\*/gm)].map((m) => m[1]);
    assert.deepEqual(order, ['GHSA-fake-crit', 'GHSA-p6mc-m468-83gw', 'GHSA-35jh-r3h4-6jhm', 'GHSA-29mw-wpgm-hmr9']);
    assert.match(r.markdown, /GHSA-35jh-r3h4-6jhm\*\* \(CVE-2021-23337\) — HIGH 7\.2 — Command Injection in lodash/);
    assert.match(r.markdown, /Fixed in: 4\.17\.19/);
    assert.match(r.markdown, /Verdict: 4 known vulnerabilities affect lodash@4\.17\.15; upgrade to ≥ 4\.17\.21\./);
    assert.equal(r.sources[0].url, 'https://osv.dev/vulnerability/GHSA-fake-crit');
    assert.equal(r.sources[0].kind, 'security-advisory');
  });

  it('by package: maps ecosystem names and reports a clean result', async () => {
    const { http, calls } = fakeHttp([['https://api.osv.dev/v1/query', { body: {} }]]);
    const r = await vulnLookup(http, { ecosystem: 'pypi', package: 'requests', version: '2.32.3' });
    assert.equal(JSON.parse(String(calls[0].opts.body)).package.ecosystem, 'PyPI');
    assert.match(r.markdown, /Verdict: no known vulnerabilities in OSV for requests@2\.32\.3\./);
    await rejects(vulnLookup(http, { package: 'requests' }), 'unsupported', /ecosystem is required/);
    await rejects(vulnLookup(http, {}), 'unsupported');
  });

  it('by CVE: OSV record plus NVD CVSS, CWE and references (with apiKey header)', async () => {
    const nvd = {
      resultsPerPage: 1, startIndex: 0, totalResults: 1, format: 'NVD_CVE', version: '2.0',
      vulnerabilities: [{ cve: {
        id: 'CVE-2021-44228', sourceIdentifier: 'security@apache.org', published: '2021-12-10T10:15:09.143', lastModified: '2024-07-24T17:08:24.167', vulnStatus: 'Analyzed',
        descriptions: [{ lang: 'en', value: 'Apache Log4j2 2.0-beta9 through 2.15.0 JNDI features do not protect against attacker controlled LDAP.' }, { lang: 'es', value: 'Apache Log4j2…' }],
        metrics: { cvssMetricV31: [{ source: 'nvd@nist.gov', type: 'Primary', cvssData: { version: '3.1', vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', baseScore: 10.0, baseSeverity: 'CRITICAL' }, exploitabilityScore: 3.9, impactScore: 6.0 }] },
        weaknesses: [{ source: 'security@apache.org', type: 'Primary', description: [{ lang: 'en', value: 'CWE-917' }, { lang: 'en', value: 'CWE-502' }] }, { source: 'nvd@nist.gov', type: 'Secondary', description: [{ lang: 'en', value: 'NVD-CWE-noinfo' }] }],
        references: Array.from({ length: 12 }, (_, i) => ({ url: `https://logging.apache.org/log4j/2.x/security${i}.html`, source: 'security@apache.org', tags: i === 0 ? ['Vendor Advisory'] : [] })),
      } }],
    };
    const osv = {
      id: 'CVE-2021-44228', summary: 'Log4Shell', aliases: ['GHSA-jfh8-c2jp-5v3q'], published: '2021-12-10T10:15:09Z', modified: '2024-07-24T00:00:00Z',
      details: 'Apache Log4j2 JNDI injection.',
      affected: [{ package: { ecosystem: 'Maven', name: 'org.apache.logging.log4j:log4j-core' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '2.0-beta9' }, { fixed: '2.15.0' }] }] }],
      references: [{ type: 'ADVISORY', url: 'https://logging.apache.org/log4j/2.x/security.html' }],
    };
    const { http, calls } = fakeHttp([
      ['https://api.osv.dev/v1/vulns/CVE-2021-44228', { body: osv }],
      ['https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2021-44228', { body: nvd }],
    ]);
    const r = await vulnLookup(http, { id: 'cve-2021-44228' }, { keys: keysOf({ nvd: 'nvd-key' }) });
    const nvdCall = calls.find((c) => c.url.includes('nvd.nist.gov'));
    assert.equal(nvdCall?.opts.headers?.apiKey, 'nvd-key');
    assert.equal(r.title, 'OSV · CVE-2021-44228 — Log4Shell');
    assert.match(r.markdown, /- CVSS v3\.1: \*\*10 CRITICAL\*\* `CVSS:3\.1\/AV:N\/AC:L\/PR:N\/UI:N\/S:C\/C:H\/I:H\/A:H` \(nvd@nist\.gov\)/);
    assert.match(r.markdown, /- Weakness: CWE-917, CWE-502/);
    assert.match(r.markdown, /published 2021-12-10 · last modified 2024-07-24/);
    assert.match(r.markdown, /Maven org\.apache\.logging\.log4j:log4j-core: introduced 2\.0-beta9, fixed 2\.15\.0 → fixed in 2\.15\.0/);
    assert.equal((r.markdown.match(/security\d+\.html/g) ?? []).length, 8);
    assert.ok(r.sources.some((s) => s.url === 'https://nvd.nist.gov/vuln/detail/CVE-2021-44228'));
  });

  it('by CVE: OSV 404 still answers from NVD; both missing → 404', async () => {
    const empty = { resultsPerPage: 0, startIndex: 0, totalResults: 0, vulnerabilities: [] };
    const { http } = fakeHttp([
      ['https://api.osv.dev/', { status: 404, body: { code: 5, message: 'Bug not found.' } }],
      ['https://services.nvd.nist.gov/', { body: empty }],
    ]);
    await rejects(vulnLookup(http, { id: 'CVE-2099-0001' }), 'http', /no advisory found/);
  });
});

/* ------------------------------------------------------------------ GitHub */

const REPO = {
  id: 1, full_name: 'microsoft/vscode', html_url: 'https://github.com/microsoft/vscode', description: 'Visual Studio Code', fork: false, archived: false,
  homepage: 'https://code.visualstudio.com', language: 'TypeScript', stargazers_count: 163000, watchers_count: 163000, subscribers_count: 3300, forks_count: 28800,
  open_issues_count: 9500, default_branch: 'main', topics: ['editor', 'electron'], created_at: '2015-09-03T20:23:38Z', pushed_at: '2024-09-01T10:00:00Z',
  license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT' },
};

describe('githubLookup', () => {
  it('parseRepo accepts owner/name, URLs and .git suffixes', () => {
    assert.equal(parseRepo('microsoft/vscode'), 'microsoft/vscode');
    assert.equal(parseRepo('https://github.com/microsoft/vscode/tree/main/src'), 'microsoft/vscode');
    assert.equal(parseRepo('git@github.com:nodejs/node.git'), 'nodejs/node');
    assert.throws(() => parseRepo('just-a-name'), WebError);
  });

  it('repo: headers, stats and latest release', async () => {
    const { http, calls } = fakeHttp([
      ['https://api.github.com/repos/microsoft/vscode/releases/latest', { body: { tag_name: '1.93.0', name: 'August 2024', published_at: '2024-09-05T17:00:00Z', html_url: 'https://github.com/microsoft/vscode/releases/tag/1.93.0' } }],
      ['https://api.github.com/repos/microsoft/vscode', { body: REPO }],
    ]);
    const r = await githubLookup(http, { action: 'repo', repo: 'https://github.com/microsoft/vscode' }, { keys: keysOf({ github: 'ghp_x' }) });
    const h = calls[0].opts.headers ?? {};
    assert.equal(h.Accept, 'application/vnd.github+json');
    assert.equal(h['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(h.Authorization, 'Bearer ghp_x');
    assert.match(r.markdown, /163,000 stars · 28,800 forks · 9,500 open issues\+PRs · 3,300 watchers/);
    assert.match(r.markdown, /License: MIT · Default branch: main/);
    assert.match(r.markdown, /Latest release: 1\.93\.0 “August 2024” \(2024-09-05\)/);
    assert.match(r.markdown, /Topics: editor, electron/);
    assert.equal(r.sources[0].kind, 'code-repo');
  });

  it('rate limit (403 + x-ratelimit-remaining: 0) → rate_limited with reset time and token advice', async () => {
    const { http } = fakeHttp([['https://api.github.com/', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1725000000' }, body: { message: 'API rate limit exceeded for 1.2.3.4.' } }]]);
    const e = await rejects(githubLookup(http, { action: 'repo', repo: 'a/b' }), 'rate_limited', /resets at 2024-08-30T06:40:00Z/);
    assert.match(e.message, /Store a GitHub token/);
    const plain = fakeHttp([['https://api.github.com/', { status: 404, body: { message: 'Not Found' } }]]);
    await rejects(githubLookup(plain.http, { action: 'releases', repo: 'a/b' }), 'http', /private/);
  });

  it('readme: base64 decoded; binary file reported, not dumped', async () => {
    const md = '# Hello\n\nThis is the README — ünïcode.\n';
    const b64 = Buffer.from(md, 'utf8').toString('base64').replace(/(.{20})/g, '$1\n');
    const { http, calls } = fakeHttp([
      ['https://api.github.com/repos/o/r/readme', { body: { name: 'README.md', path: 'README.md', size: md.length, encoding: 'base64', content: b64, html_url: 'https://github.com/o/r/blob/main/README.md' } }],
      ['https://api.github.com/repos/o/r/contents/img/logo.png', { body: { name: 'logo.png', path: 'img/logo.png', encoding: 'base64', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]).toString('base64'), html_url: 'https://github.com/o/r/blob/main/img/logo.png' } }],
    ]);
    const r = await githubLookup(http, { action: 'readme', repo: 'o/r', ref: 'v1' });
    assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/readme?ref=v1');
    assert.match(r.markdown, /# Hello\n\nThis is the README — ünïcode\./);
    const f = await githubLookup(http, { action: 'file', repo: 'o/r', path: '/img/logo.png' });
    assert.match(f.markdown, /Binary file \(8 bytes\); not shown\./);
  });

  it('search_issues builds a repo-scoped query; compare_stars sorts a table', async () => {
    const { http, calls } = fakeHttp([
      ['https://api.github.com/search/issues', { body: { total_count: 1, items: [{ number: 42, title: 'Crash on <start>', state: 'open', labels: [{ name: 'bug' }], comments: 3, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-02-01T00:00:00Z', html_url: 'https://github.com/a/b/issues/42' }] } }],
      ['https://api.github.com/repos/a/small', { body: { ...REPO, full_name: 'a/small', html_url: 'https://github.com/a/small', stargazers_count: 5, archived: true } }],
      ['https://api.github.com/repos/a/big', { body: { ...REPO, full_name: 'a/big', html_url: 'https://github.com/a/big', stargazers_count: 5000 } }],
      ['https://api.github.com/repos/a/gone', { status: 404, body: { message: 'Not Found' } }],
    ]);
    const s = await githubLookup(http, { action: 'search_issues', repo: 'a/b', query: 'crash' });
    assert.equal(new URL(calls[0].url).searchParams.get('q'), 'repo:a/b crash state:open');
    assert.match(s.markdown, /1\. \*\*#42 Crash on\*\* — issue, open · \[bug\] · 3 comments/);
    const c = await githubLookup(http, { action: 'compare_stars', repos: ['a/small', 'a/big', 'a/gone'] });
    const rows = c.markdown.split('\n').filter((l) => l.startsWith('| [') || l.includes('not found'));
    assert.match(rows[0], /a\/big.*\| 5,000 \|/);
    assert.match(rows[1], /a\/small.*\| yes \|$/);
    assert.match(rows[2], /a\/gone \| not found/);
  });
});

/* ------------------------------------------------------------------ tech sources */

describe('techSearch', () => {
  it('hackernews: Algolia params, points/comments and the HN discussion link', async () => {
    const { http, calls } = fakeHttp([['https://hn.algolia.com/api/v1/search', { body: {
      hits: [
        { objectID: '38000000', title: 'Show HN: A tiny <b>Rust</b> web server', url: 'https://example.com/server', points: 512, num_comments: 210, author: 'alice', created_at: '2023-10-20T12:00:00.000Z', created_at_i: 1697803200 },
        { objectID: '38000001', title: 'Ask HN: Rust or Go?', url: null, points: 40, num_comments: 99, author: 'bob', created_at_i: 1697803200 },
      ], nbHits: 2, hitsPerPage: 5,
    } }]]);
    const r = await techSearch(http, { source: 'hackernews', query: 'rust server', limit: 5 });
    const p = qs(calls[0].url);
    assert.equal(p.get('query'), 'rust server');
    assert.equal(p.get('tags'), 'story');
    assert.equal(p.get('hitsPerPage'), '5');
    assert.match(r.markdown, /1\. \*\*Show HN: A tiny Rust web server\*\* \(2023-10-20\) — 512 points · 210 comments · by alice/);
    assert.match(r.markdown, /https:\/\/example\.com\/server · discussion: https:\/\/news\.ycombinator\.com\/item\?id=38000000/);
    assert.match(r.markdown, /2\. \*\*Ask HN: Rust or Go\?\*\* \(2023-10-20\) — 40 points · 99 comments[^\n]*\n {3}https:\/\/news\.ycombinator\.com\/item\?id=38000001$/m);
    assert.deepEqual(r.sources.map((s) => s.kind), ['unknown', 'forum', 'forum']);
  });

  it('stackoverflow: search/advanced params and answered/accepted status', async () => {
    const { http, calls } = fakeHttp([['https://api.stackexchange.com/2.3/search/advanced', { body: {
      items: [
        { tags: ['javascript', 'async-await'], is_answered: true, accepted_answer_id: 99, answer_count: 7, score: 1200, creation_date: 1450000000, question_id: 1, link: 'https://stackoverflow.com/questions/1/using-async-await', title: 'Using async/await with a forEach loop &amp; friends' },
        { tags: ['node.js'], is_answered: false, answer_count: 0, score: 1, creation_date: 1700000000, question_id: 2, link: 'https://stackoverflow.com/questions/2/x', title: 'Unanswered one' },
      ], has_more: true, quota_max: 300, quota_remaining: 290,
    } }]]);
    const r = await techSearch(http, { source: 'stackoverflow', query: 'async forEach', limit: 2 });
    const p = qs(calls[0].url);
    assert.equal(p.get('q'), 'async forEach');
    assert.equal(p.get('site'), 'stackoverflow');
    assert.equal(p.get('sort'), 'relevance');
    assert.equal(p.get('pagesize'), '2');
    assert.match(r.markdown, /1\. \*\*Using async\/await with a forEach loop & friends\*\* \(2015-12-13\) — score 1200 · 7 answers · accepted answer · \[javascript, async-await\]/);
    assert.match(r.markdown, /2\. \*\*Unanswered one\*\*.*unanswered/);
    assert.equal(r.sources[0].kind, 'forum');
  });

  it('wikipedia: search then the summary of the top hit', async () => {
    const { http, calls } = fakeHttp([
      ['https://en.wikipedia.org/w/rest.php/v1/search/page', { body: { pages: [
        { id: 1, key: 'Transport_Layer_Security', title: 'Transport Layer Security', excerpt: '<span class="searchmatch">TLS</span> is a protocol', description: 'Cryptographic protocol' },
        { id: 2, key: 'TLS_(disambiguation)', title: 'TLS (disambiguation)', excerpt: 'TLS may refer to', description: null },
      ] } }],
      ['https://en.wikipedia.org/api/rest_v1/page/summary/Transport_Layer_Security', { body: {
        type: 'standard', title: 'Transport Layer Security', extract: 'Transport Layer Security (TLS) is a cryptographic protocol designed to provide communications security over a computer network.',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Transport_Layer_Security' } },
      } }],
    ]);
    const r = await techSearch(http, { source: 'wikipedia', query: 'TLS', limit: 2 });
    assert.equal(qs(calls[0].url).get('q'), 'TLS');
    assert.equal(qs(calls[0].url).get('limit'), '2');
    assert.match(r.markdown, /1\. \*\*Transport Layer Security\*\* — Cryptographic protocol\n {3}https:\/\/en\.wikipedia\.org\/wiki\/Transport_Layer_Security\n {3}Transport Layer Security \(TLS\) is a cryptographic protocol/);
    assert.match(r.markdown, /2\. \*\*TLS \(disambiguation\)\*\*\n {3}https:\/\/en\.wikipedia\.org\/wiki\/TLS_\(disambiguation\)\n {3}TLS may refer to/);
    assert.ok(r.sources.every((s) => s.kind === 'reference'));
  });

  it('rfc: "RFC 9110" goes straight to the rfc-editor JSON', async () => {
    const { http, calls } = fakeHttp([['https://www.rfc-editor.org/rfc/rfc9110.json', { body: {
      draft: 'draft-ietf-httpbis-semantics-19', doc_id: 'RFC9110', title: 'HTTP Semantics ', authors: ['R. Fielding, Ed.', 'M. Nottingham, Ed.', 'J. Reschke, Ed.'],
      format: ['HTML', 'TEXT', 'PDF', 'XML'], page_count: '194', pub_status: 'INTERNET STANDARD', status: 'INTERNET STANDARD', source: 'HTTP',
      abstract: 'The Hypertext Transfer Protocol (HTTP) is a stateless application-level protocol for distributed, collaborative, hypertext information systems.',
      pub_date: 'June 2022', keywords: ['HTTP'], obsoletes: ['RFC2818', 'RFC7230', 'RFC7231'], obsoleted_by: [], updates: ['RFC3864'], updated_by: [], see_also: ['STD0097'], doi: '10.17487/RFC9110', errata_url: null,
    } }]]);
    for (const q of ['RFC 9110', 'rfc9110', 'rfc-9110']) {
      const r = await techSearch(http, { source: 'rfc', query: q });
      assert.equal(r.title, 'RFC 9110 · HTTP Semantics');
      assert.match(r.markdown, /- Status: INTERNET STANDARD/);
      assert.match(r.markdown, /- Published: June 2022 · 194 pages/);
      assert.match(r.markdown, /- Obsoletes: RFC 2818, RFC 7230, RFC 7231/);
      assert.match(r.markdown, /- DOI: 10\.17487\/RFC9110/);
      assert.deepEqual(r.sources, [{ title: 'RFC 9110: HTTP Semantics', url: 'https://www.rfc-editor.org/rfc/rfc9110', kind: 'standard' }]);
    }
    assert.equal(calls.length, 3);
    const missing = fakeHttp([['https://www.rfc-editor.org/', { status: 404, body: '<html>nope</html>' }]]);
    await rejects(techSearch(missing.http, { source: 'rfc', query: 'RFC 99999' }), 'http', /RFC 99999 does not exist/);
  });

  it('rfc: title search via the datatracker API', async () => {
    const { http, calls } = fakeHttp([['https://datatracker.ietf.org/api/v1/doc/document/', { body: {
      meta: { limit: 3, next: null, offset: 0, total_count: 1 },
      objects: [{
        name: 'rfc8446', rfc_number: 8446, title: 'The Transport Layer Security (TLS) Protocol Version 1.3', pages: 160,
        std_level: '/api/v1/name/stdlevelname/ps/', time: '2018-08-10T00:00:00Z', type: '/api/v1/name/doctypename/rfc/',
        abstract: 'This document specifies version 1.3 of the Transport Layer Security (TLS) protocol.',
      }],
    } }]]);
    const r = await techSearch(http, { source: 'rfc', query: 'TLS protocol version 1.3', limit: 3 });
    const p = qs(calls[0].url);
    assert.equal(p.get('title__icontains'), 'TLS protocol version 1.3');
    assert.equal(p.get('format'), 'json');
    assert.equal(p.get('limit'), '3');
    assert.match(r.markdown, /1\. \*\*The Transport Layer Security \(TLS\) Protocol Version 1\.3\*\* — RFC 8446 · Proposed Standard · 160 pages · 2018-08-10\n {3}https:\/\/www\.rfc-editor\.org\/rfc\/rfc8446/);
    assert.equal(r.sources[0].kind, 'standard');
  });

  it('unknown source → unsupported', async () => {
    await rejects(techSearch(fakeHttp([]).http, { source: 'devdocs' as never, query: 'x' }), 'unsupported', /unknown source/);
    await rejects(techSearch(fakeHttp([]).http, { source: 'hackernews', query: ' ' }), 'unsupported');
  });
});

/* ------------------------------------------------------------------ source kinds */

describe('classifyUrlKind', () => {
  const table: Array<[string, string]> = [
    ['https://arxiv.org/abs/1706.03762', 'academic'],
    ['https://doi.org/10.1145/1', 'academic'],
    ['https://www.semanticscholar.org/paper/x', 'academic'],
    ['https://pubmed.ncbi.nlm.nih.gov/123/', 'academic'],
    ['https://ieeexplore.ieee.org/document/1', 'academic'],
    ['https://dl.acm.org/doi/1', 'academic'],
    ['https://link.springer.com/article/1', 'academic'],
    ['https://www.nature.com/articles/x', 'academic'],
    ['https://www.sciencedirect.com/science/article/pii/x', 'academic'],
    ['https://github.com/microsoft/vscode', 'code-repo'],
    ['https://gitlab.com/a/b', 'code-repo'],
    ['https://bitbucket.org/a/b', 'code-repo'],
    ['https://www.npmjs.com/package/lodash', 'package-registry'],
    ['https://pypi.org/project/requests/', 'package-registry'],
    ['https://search.maven.org/artifact/x', 'package-registry'],
    ['https://crates.io/crates/serde', 'package-registry'],
    ['https://www.nuget.org/packages/x', 'package-registry'],
    ['https://pkg.go.dev/golang.org/x/text', 'package-registry'],
    ['https://rubygems.org/gems/rails', 'package-registry'],
    ['https://packagist.org/packages/a/b', 'package-registry'],
    ['https://osv.dev/vulnerability/GHSA-x', 'security-advisory'],
    ['https://nvd.nist.gov/vuln/detail/CVE-2021-44228', 'security-advisory'],
    ['https://www.cve.org/CVERecord?id=CVE-2021-44228', 'security-advisory'],
    ['https://github.com/advisories/GHSA-jfh8-c2jp-5v3q', 'security-advisory'],
    ['https://datatracker.ietf.org/doc/rfc9110/', 'standard'],
    ['https://www.rfc-editor.org/rfc/rfc9110', 'standard'],
    ['https://www.w3.org/TR/html52/', 'standard'],
    ['https://html.spec.whatwg.org/', 'standard'],
    ['https://www.iso.org/standard/1.html', 'standard'],
    ['https://ecma-international.org/publications-and-standards/standards/ecma-262/', 'standard'],
    ['https://www.cisa.gov/news', 'security-advisory'],
    ['https://www.whitehouse.gov/x', 'government'],
    ['https://www.gov.uk/guidance/x', 'government'],
    ['https://data.gov.in/x', 'government'],
    ['https://commission.europa.eu/x', 'government'],
    ['https://stackoverflow.com/questions/1', 'forum'],
    ['https://unix.stackexchange.com/q/1', 'forum'],
    ['https://www.reddit.com/r/rust/', 'forum'],
    ['https://news.ycombinator.com/item?id=1', 'forum'],
    ['https://en.wikipedia.org/wiki/TLS', 'reference'],
    ['https://developer.mozilla.org/en-US/docs/Web', 'official-docs'],
    ['https://docs.github.com/en/rest', 'official-docs'],
    ['https://learn.microsoft.com/en-us/dotnet/', 'official-docs'],
    ['https://docs.python.org/3/', 'official-docs'],
    ['https://nodejs.org/docs/latest/api/', 'official-docs'],
    ['https://example.com/docs/getting-started', 'official-docs'],
    ['https://medium.com/@a/b', 'blog'],
    ['https://dev.to/a/b', 'blog'],
    ['https://x.substack.com/p/y', 'blog'],
    ['https://a.hashnode.dev/b', 'blog'],
    ['https://a.blogspot.com/', 'blog'],
    ['https://a.wordpress.com/', 'blog'],
    ['https://www.reuters.com/technology/x', 'news'],
    ['https://arstechnica.com/x', 'news'],
    ['https://example.com/', 'unknown'],
    ['not a url', 'unknown'],
  ];
  it('maps hosts to source kinds', () => {
    for (const [url, kind] of table) { assert.equal(classifyUrlKind(url), kind, url); }
  });
});
