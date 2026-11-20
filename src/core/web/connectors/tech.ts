/**
 * Developer community and reference sources: Hacker News (Algolia), Stack Overflow (Stack Exchange API),
 * Wikipedia (REST search + page summary) and IETF RFCs (datatracker search, rfc-editor metadata).
 * All keyless public APIs, so they work out of the box.
 */
import { ConnectorResult, HttpFetch, WebError } from '../types';
import { ConnectorOpts, arr, clampInt, clean, epochSecDate, excerpt, fmtInt, getJson, isoDate, num, obj, result, source, stripTags, tryJson } from './util';

export type TechSource = 'hackernews' | 'stackoverflow' | 'wikipedia' | 'rfc';

export interface TechSearchArgs { source: TechSource; query: string; limit?: number }

const SOURCES: readonly TechSource[] = ['hackernews', 'stackoverflow', 'wikipedia', 'rfc'];

export async function techSearch(http: HttpFetch, args: TechSearchArgs, opts: ConnectorOpts = {}): Promise<ConnectorResult> {
  const query = clean(args.query);
  if (!query) { throw new WebError('tech_search: query is empty', 'unsupported'); }
  if (!SOURCES.includes(args.source)) {
    throw new WebError(`tech_search: unknown source "${String(args.source)}" (use ${SOURCES.join(', ')})`, 'unsupported');
  }
  const limit = clampInt(args.limit, 8, 1, 25);
  const signal = opts.signal;
  switch (args.source) {
    case 'hackernews': return hackerNews(http, query, limit, signal);
    case 'stackoverflow': return stackOverflow(http, query, limit, signal);
    case 'wikipedia': return wikipedia(http, query, limit, signal);
    case 'rfc': return rfcSearch(http, query, limit, signal);
  }
}

/* ------------------------------------------------------------------ Hacker News */

async function hackerNews(http: HttpFetch, query: string, limit: number, signal?: AbortSignal): Promise<ConnectorResult> {
  const d = await getJson(http, 'Hacker News', `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit}`, { signal });
  const hits = arr(d.hits).filter((h) => clean(h?.objectID)).slice(0, limit);
  const head = `Hacker News · ${hits.length} stories for “${query}”`;
  const lines = [head, ''];
  if (!hits.length) { lines.push('No stories found.'); }
  const sources = [];
  for (const [i, h] of hits.entries()) {
    const discussion = `https://news.ycombinator.com/item?id=${encodeURIComponent(clean(h.objectID))}`;
    const url = /^https?:\/\//i.test(clean(h.url)) ? clean(h.url) : discussion;
    const date = isoDate(h.created_at) ?? epochSecDate(h.created_at_i);
    const title = stripTags(h.title) || stripTags(h.story_title) || '(untitled)';
    lines.push(`${i + 1}. **${title}** (${date ?? '?'}) — ${fmtInt(num(h.points) ?? 0)} points · ${fmtInt(num(h.num_comments) ?? 0)} comments${clean(h.author) ? ` · by ${clean(h.author)}` : ''}`);
    lines.push(url === discussion ? `   ${discussion}` : `   ${url} · discussion: ${discussion}`);
    sources.push(source(title, url, date));
    if (url !== discussion) { sources.push(source(`HN discussion: ${title}`, discussion, date)); }
  }
  return result(head, lines, sources);
}

/* ------------------------------------------------------------------ Stack Overflow */

async function stackOverflow(http: HttpFetch, query: string, limit: number, signal?: AbortSignal): Promise<ConnectorResult> {
  const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=${limit}`;
  const d = await getJson(http, 'Stack Overflow', url, { signal });
  if (num(d.quota_remaining) === 0) {
    throw new WebError('Stack Overflow: the daily API quota for this network address is used up; try again tomorrow', 'rate_limited');
  }
  const items = arr(d.items).slice(0, limit);
  const head = `Stack Overflow · ${items.length} questions for “${query}”`;
  const lines = [head, ''];
  if (!items.length) { lines.push('No questions found.'); }
  const sources = [];
  for (const [i, q] of items.entries()) {
    const title = stripTags(q?.title) || '(untitled)';
    const link = clean(q?.link);
    const date = epochSecDate(q?.creation_date);
    const status = q?.accepted_answer_id ? 'accepted answer' : q?.is_answered ? 'answered' : 'unanswered';
    const tags = arr(q?.tags).map(clean).filter(Boolean).slice(0, 6);
    lines.push(`${i + 1}. **${title}** (${date ?? '?'}) — score ${num(q?.score) ?? 0} · ${num(q?.answer_count) ?? 0} answers · ${status}${tags.length ? ` · [${tags.join(', ')}]` : ''}`);
    if (link) { lines.push(`   ${link}`); sources.push(source(title, link, date)); }
  }
  if (d.has_more) { lines.push('', '_More results exist; refine the query or raise the limit._'); }
  return result(head, lines, sources);
}

/* ------------------------------------------------------------------ Wikipedia */

async function wikipedia(http: HttpFetch, query: string, limit: number, signal?: AbortSignal): Promise<ConnectorResult> {
  const base = 'https://en.wikipedia.org';
  const d = await getJson(http, 'Wikipedia', `${base}/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=${limit}`, { signal });
  const pages = arr(d.pages).filter((p) => clean(p?.key) || clean(p?.title)).slice(0, limit);
  const head = `Wikipedia · ${pages.length} articles for “${query}”`;
  const lines = [head, ''];
  if (!pages.length) { lines.push('No articles found.'); return result(head, lines, []); }
  const pageUrl = (p: any): string => `${base}/wiki/${encodeURIComponent((clean(p.key) || clean(p.title)).replace(/ /g, '_'))}`;

  // The top hit gets its lead summary, which is usually what the agent needs.
  const top = pages[0];
  const summary = await tryJson(http, 'Wikipedia', `${base}/api/rest_v1/page/summary/${encodeURIComponent((clean(top.key) || clean(top.title)).replace(/ /g, '_'))}`, { signal });
  const sources = [];
  for (const [i, p] of pages.entries()) {
    const title = clean(p.title) || clean(p.key);
    const url = i === 0 ? clean(obj(obj(obj(summary).content_urls).desktop).page) || pageUrl(p) : pageUrl(p);
    const desc = clean(p.description);
    lines.push(`${i + 1}. **${title}**${desc ? ` — ${desc}` : ''}`, `   ${url}`);
    if (i === 0 && clean(obj(summary).extract)) {
      lines.push(`   ${excerpt(obj(summary).extract, 1200)}`);
    } else if (clean(p.excerpt)) {
      lines.push(`   ${excerpt(p.excerpt, 240)}`);
    }
    sources.push({ ...source(title, url), kind: 'reference' as const });
  }
  return result(head, lines, sources);
}

/* ------------------------------------------------------------------ RFCs */

const STD_LEVEL: Record<string, string> = {
  std: 'Internet Standard', ps: 'Proposed Standard', ds: 'Draft Standard', bcp: 'Best Current Practice',
  inf: 'Informational', exp: 'Experimental', hist: 'Historic', unkn: 'Unknown',
};

/** "RFC 9110", "rfc9110", "RFC-9110" → 9110; anything else undefined. */
export function rfcNumber(query: string): number | undefined {
  const m = /^\s*rfc[\s\-_#]*(\d{1,5})\s*$/i.exec(query);
  return m ? Number(m[1]) : undefined;
}

const rfcUrl = (n: number): string => `https://www.rfc-editor.org/rfc/rfc${n}`;
const rfcList = (v: unknown): string => arr(v).map((x) => clean(x).replace(/^RFC0*/i, 'RFC ')).filter(Boolean).join(', ');

async function rfcSearch(http: HttpFetch, query: string, limit: number, signal?: AbortSignal): Promise<ConnectorResult> {
  const n = rfcNumber(query);
  if (n !== undefined) { return rfcDirect(http, n, signal); }

  const url = `https://datatracker.ietf.org/api/v1/doc/document/?type=rfc&title__icontains=${encodeURIComponent(query)}&format=json&limit=${limit}&order_by=-rfc_number`;
  const d = await getJson(http, 'IETF datatracker', url, { signal });
  const docs = arr(d.objects).slice(0, limit);
  const head = `IETF RFCs · ${docs.length} documents with “${query}” in the title`;
  const lines = [head, ''];
  if (!docs.length) { lines.push('No RFCs found. Search titles with fewer or different words (e.g. "HTTP semantics").'); }
  const sources = [];
  for (const [i, doc] of docs.entries()) {
    const rfcNo = num(doc?.rfc_number) ?? num(/^rfc(\d+)$/i.exec(clean(doc?.name))?.[1]);
    const title = stripTags(doc?.title) || clean(doc?.name);
    const link = rfcNo !== undefined ? rfcUrl(rfcNo) : `https://datatracker.ietf.org/doc/${encodeURIComponent(clean(doc?.name))}/`;
    const level = STD_LEVEL[clean(doc?.std_level).replace(/\/+$/, '').split('/').pop() ?? ''] ?? '';
    const date = isoDate(doc?.time);
    const meta = [rfcNo !== undefined ? `RFC ${rfcNo}` : clean(doc?.name), level, num(doc?.pages) ? `${num(doc?.pages)} pages` : '', date ?? ''].filter(Boolean).join(' · ');
    lines.push(`${i + 1}. **${title}** — ${meta}`, `   ${link}`);
    if (clean(doc?.abstract)) { lines.push(`   ${excerpt(doc.abstract, 350)}`); }
    sources.push({ ...source(title, link, date), kind: 'standard' as const });
  }
  return result(head, lines, sources);
}

async function rfcDirect(http: HttpFetch, n: number, signal?: AbortSignal): Promise<ConnectorResult> {
  const d = await getJson(http, 'RFC Editor', `${rfcUrl(n)}.json`, { signal }, { notFound: `RFC ${n} does not exist (or has not been published yet)` });
  const title = stripTags(d.title) || `RFC ${n}`;
  const head = `RFC ${n} · ${title}`;
  const authors = arr(d.authors).map((a) => clean(typeof a === 'string' ? a : obj(a).name)).filter(Boolean);
  const lines = [head, '',
    `- Status: ${clean(d.pub_status) || clean(d.status) || 'unknown'}${clean(d.stream) ? ` · Stream: ${clean(d.stream)}` : ''}`,
    `- Published: ${clean(d.pub_date) || '?'}${num(d.page_count) ? ` · ${num(d.page_count)} pages` : ''}`];
  if (authors.length) { lines.push(`- Authors: ${authors.slice(0, 8).join(', ')}${authors.length > 8 ? ' et al.' : ''}`); }
  if (rfcList(d.obsoleted_by)) { lines.push(`- **Obsoleted by ${rfcList(d.obsoleted_by)}** — read the newer document instead.`); }
  if (rfcList(d.updated_by)) { lines.push(`- Updated by: ${rfcList(d.updated_by)}`); }
  if (rfcList(d.obsoletes)) { lines.push(`- Obsoletes: ${rfcList(d.obsoletes)}`); }
  if (rfcList(d.updates)) { lines.push(`- Updates: ${rfcList(d.updates)}`); }
  if (clean(d.doi)) { lines.push(`- DOI: ${clean(d.doi)}`); }
  lines.push(`- Text: ${rfcUrl(n)} (HTML) · ${rfcUrl(n)}.txt (plain text — fetch it with web_fetch to read the RFC)`);
  if (clean(d.abstract)) { lines.push('', excerpt(d.abstract, 1500)); }
  return result(head, lines, [{ ...source(`RFC ${n}: ${title}`, rfcUrl(n)), kind: 'standard' }]);
}
