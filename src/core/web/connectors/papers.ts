/**
 * Scholarly search and paper details: Semantic Scholar (default), arXiv, PubMed, Crossref, OpenAlex.
 * All results are reduced to one Paper shape so the Markdown looks the same whatever the source.
 */
import { ConnectorResult, ConnectorSource, HttpFetch, WebError } from '../types';
import { ConnectorOpts, arr, clampInt, clean, decodeEntities, ensureOk, errMsg, excerpt, fmtInt, getJson, isAbort, isoDate, num, obj, result, source, stripTags } from './util';

export type PaperSourceId = 'arxiv' | 'semanticscholar' | 'pubmed' | 'crossref' | 'openalex';

export interface PaperSearchArgs {
  query: string;
  source?: 'auto' | PaperSourceId;
  limit?: number;
  yearFrom?: number;
  yearTo?: number;
  sort?: 'relevance' | 'date' | 'citations';
}

export interface PaperDetailsArgs { id: string; include?: Array<'references' | 'citations'>; limit?: number }

interface Paper {
  title: string;
  authors: string[];
  year?: number;
  published?: string;
  venue?: string;
  citations?: number;
  doi?: string;
  arxivId?: string;
  url: string;
  pdf?: string;
  abstract?: string;
}

interface Ctx { http: HttpFetch; opts: ConnectorOpts; args: PaperSearchArgs; limit: number }

const LABEL: Record<PaperSourceId, string> = {
  semanticscholar: 'Semantic Scholar', arxiv: 'arXiv', pubmed: 'PubMed', crossref: 'Crossref', openalex: 'OpenAlex',
};

const S2 = 'https://api.semanticscholar.org/graph/v1';

async function s2Headers(opts: ConnectorOpts): Promise<Record<string, string>> {
  let key: string | undefined;
  try { key = clean(await opts.keys?.('semanticscholar')); } catch { key = undefined; }
  return key ? { 'x-api-key': key } : {};
}

const yearOk = (p: Paper, a: PaperSearchArgs): boolean =>
  p.year === undefined ? !(a.yearFrom || a.yearTo) : (!a.yearFrom || p.year >= a.yearFrom) && (!a.yearTo || p.year <= a.yearTo);

/* ------------------------------------------------------------------ Semantic Scholar */

const S2_FIELDS = 'title,authors,year,venue,citationCount,externalIds,openAccessPdf,abstract,url,publicationDate';

function fromS2(p: any): Paper | undefined {
  const title = stripTags(p?.title);
  if (!title) { return undefined; }
  const ext = obj(p?.externalIds);
  return {
    title, authors: arr(p?.authors).map((a) => clean(a?.name)).filter(Boolean),
    year: num(p?.year), published: isoDate(p?.publicationDate), venue: clean(p?.venue) || undefined,
    citations: num(p?.citationCount), doi: clean(ext.DOI) || undefined, arxivId: clean(ext.ArXiv) || undefined,
    url: clean(p?.url) || (p?.paperId ? `https://www.semanticscholar.org/paper/${clean(p.paperId)}` : ''),
    pdf: clean(obj(p?.openAccessPdf).url) || undefined, abstract: stripTags(p?.abstract) || undefined,
  };
}

async function searchS2({ http, opts, args, limit }: Ctx): Promise<Paper[]> {
  const p = new URLSearchParams({ query: args.query, limit: String(args.sort && args.sort !== 'relevance' ? Math.min(100, limit * 3) : limit), fields: S2_FIELDS });
  if (args.yearFrom || args.yearTo) { p.set('year', `${args.yearFrom ?? ''}-${args.yearTo ?? ''}`); }
  const j = obj(await getJson(http, 'Semantic Scholar', `${S2}/paper/search?${p}`, { headers: await s2Headers(opts), signal: opts.signal },
    { auth: 'access denied — the Semantic Scholar API key is invalid, or the shared keyless quota is exhausted' }));
  if (j.data !== undefined && !Array.isArray(j.data)) { throw new WebError('Semantic Scholar: unexpected response shape (data)', 'parse'); }
  return arr(j.data).map(fromS2).filter((x): x is Paper => !!x);
}

/* ------------------------------------------------------------------ arXiv (Atom XML) */

/** Inner text of the first `<name>` element (namespace prefix allowed in `name`). */
function tag(xml: string, name: string): string {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'i').exec(xml);
  return m ? cdata(m[1]) : '';
}
const tags = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'gi'))].map((m) => cdata(m[1]));
const cdata = (s: string): string => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const openTags = (xml: string, name: string): string[] => [...xml.matchAll(new RegExp(`<${name}\\b([^>]*)/?>`, 'gi'))].map((m) => m[1]);
function attrOf(attrs: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? '') : '';
}

/** Parses an arXiv API Atom feed; exported for tests. */
export function parseArxivAtom(xml: string): Paper[] {
  const out: Paper[] = [];
  for (const [, entry] of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry\s*>/gi)) {
    const idUrl = clean(tag(entry, 'id'));
    if (/arxiv\.org\/api\/errors/i.test(idUrl)) {
      throw new WebError(`arXiv: query rejected — ${stripTags(tag(entry, 'summary')) || 'invalid query'}`, 'http', 400);
    }
    const title = stripTags(tag(entry, 'title'));
    if (!title) { continue; }
    const arxivId = /arxiv\.org\/abs\/(.+?)(v\d+)?$/i.exec(idUrl)?.[1];
    const links = openTags(entry, 'link');
    const pdf = links.find((l) => attrOf(l, 'title') === 'pdf' || attrOf(l, 'type') === 'application/pdf');
    const cat = openTags(entry, 'arxiv:primary_category').map((a) => attrOf(a, 'term'))[0];
    const journal = stripTags(tag(entry, 'arxiv:journal_ref'));
    const published = isoDate(clean(tag(entry, 'published')));
    out.push({
      title, authors: tags(entry, 'author').map((a) => stripTags(tag(a, 'name'))).filter(Boolean),
      published, year: published ? Number(published.slice(0, 4)) : undefined,
      venue: journal || (cat ? `arXiv ${cat}` : 'arXiv'), doi: stripTags(tag(entry, 'arxiv:doi')) || undefined,
      arxivId, url: arxivId ? `https://arxiv.org/abs/${arxivId}` : idUrl,
      pdf: pdf ? attrOf(pdf, 'href').replace(/^http:/, 'https:') : undefined, abstract: stripTags(tag(entry, 'summary')) || undefined,
    });
  }
  return out;
}

async function searchArxiv({ http, opts, args, limit }: Ctx): Promise<Paper[]> {
  const words = clean(args.query).replace(/[()"]/g, ' ').split(' ').filter(Boolean);
  let q = words.map((w) => `all:${w}`).join(' AND ');
  if (args.yearFrom || args.yearTo) { q += ` AND submittedDate:[${args.yearFrom ?? 1991}01010000 TO ${args.yearTo ?? 2999}12312359]`; }
  const p = new URLSearchParams({ search_query: q, start: '0', max_results: String(limit), sortBy: args.sort === 'date' ? 'submittedDate' : 'relevance', sortOrder: 'descending' });
  const res = ensureOk('arXiv', await http(`http://export.arxiv.org/api/query?${p}`, { headers: { Accept: 'application/atom+xml' }, signal: opts.signal }));
  const xml = res.body.toString('utf8');
  if (!/<feed\b/i.test(xml)) { throw new WebError('arXiv: response was not an Atom feed', 'parse'); }
  return parseArxivAtom(xml);
}

/* ------------------------------------------------------------------ PubMed */

async function searchPubmed({ http, opts, args, limit }: Ctx): Promise<Paper[]> {
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
  let term = clean(args.query);
  if (args.yearFrom || args.yearTo) { term += ` AND ${args.yearFrom ?? 1800}:${args.yearTo ?? 3000}[dp]`; }
  const p = new URLSearchParams({ db: 'pubmed', term, retmode: 'json', retmax: String(limit), sort: args.sort === 'date' ? 'pub_date' : 'relevance' });
  const s = obj(await getJson(http, 'PubMed', `${base}/esearch.fcgi?${p}`, { signal: opts.signal }));
  const ids = arr(obj(s.esearchresult).idlist).map(clean).filter(Boolean);
  if (!obj(s.esearchresult).idlist) { throw new WebError('PubMed: unexpected response shape (esearchresult.idlist)', 'parse'); }
  if (!ids.length) { return []; }
  const sum = obj(obj(await getJson(http, 'PubMed', `${base}/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`, { signal: opts.signal })).result);
  return ids.map((id): Paper | undefined => {
    const r = obj(sum[id]);
    const title = stripTags(r.title);
    if (!title) { return undefined; }
    const aid = (t: string): string => clean(arr(r.articleids).find((a) => a?.idtype === t)?.value);
    const pmc = aid('pmc');
    const year = num(/\d{4}/.exec(clean(r.pubdate))?.[0]);
    return {
      title, authors: arr(r.authors).map((a) => clean(a?.name)).filter(Boolean), year,
      published: isoDate(clean(r.sortpubdate).replace(/\//g, '-')), venue: clean(r.fulljournalname) || clean(r.source) || undefined,
      doi: aid('doi') || undefined, url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      pdf: pmc ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmc}/` : undefined,
    };
  }).filter((x): x is Paper => !!x);
}

/* ------------------------------------------------------------------ Crossref */

async function searchCrossref({ http, opts, args, limit }: Ctx): Promise<Paper[]> {
  const p = new URLSearchParams({ query: args.query, rows: String(limit) });
  const f = [args.yearFrom ? `from-pub-date:${args.yearFrom}` : '', args.yearTo ? `until-pub-date:${args.yearTo}` : ''].filter(Boolean);
  if (f.length) { p.set('filter', f.join(',')); }
  p.set('sort', args.sort === 'date' ? 'published' : args.sort === 'citations' ? 'is-referenced-by-count' : 'relevance');
  p.set('order', 'desc');
  const j = obj(await getJson(http, 'Crossref', `https://api.crossref.org/works?${p}`, { signal: opts.signal }));
  const items = obj(j.message).items;
  if (!Array.isArray(items)) { throw new WebError('Crossref: unexpected response shape (message.items)', 'parse'); }
  return items.map((it: any): Paper | undefined => {
    const title = stripTags(arr(it?.title)[0]);
    if (!title) { return undefined; }
    const parts = arr(arr(obj(it?.issued ?? it?.published)['date-parts'])[0]).map(num);
    const year = parts[0];
    const published = year && parts[1] ? `${year}-${String(parts[1]).padStart(2, '0')}-${String(parts[2] ?? 1).padStart(2, '0')}` : undefined;
    const doi = clean(it?.DOI);
    const pdf = arr(it?.link).find((l) => /pdf/i.test(clean(l?.['content-type'])));
    return {
      title, authors: arr(it?.author).map((a) => clean(`${clean(a?.given)} ${clean(a?.family)}`) || clean(a?.name)).filter(Boolean),
      year, published, venue: stripTags(arr(it?.['container-title'])[0]) || undefined, citations: num(it?.['is-referenced-by-count']),
      doi: doi || undefined, url: doi ? `https://doi.org/${doi}` : clean(it?.URL), pdf: clean(pdf?.URL) || undefined,
      abstract: stripTags(it?.abstract).replace(/^Abstract\s+/i, '') || undefined,
    };
  }).filter((x): x is Paper => !!x);
}

/* ------------------------------------------------------------------ OpenAlex */

/** OpenAlex ships abstracts as { word: [positions] }; rebuilds the running text. */
export function rebuildInvertedAbstract(index: unknown): string {
  const words: string[] = [];
  for (const [w, positions] of Object.entries(obj(index))) {
    for (const p of arr(positions)) { if (Number.isInteger(p) && p >= 0 && p < 20_000) { words[p] = w; } }
  }
  return clean(words.filter((w) => w !== undefined).join(' '));
}

async function searchOpenalex({ http, opts, args, limit }: Ctx): Promise<Paper[]> {
  const p = new URLSearchParams({ search: args.query, 'per-page': String(limit) });
  const f = [args.yearFrom ? `from_publication_date:${args.yearFrom}-01-01` : '', args.yearTo ? `to_publication_date:${args.yearTo}-12-31` : ''].filter(Boolean);
  if (f.length) { p.set('filter', f.join(',')); }
  if (args.sort === 'date') { p.set('sort', 'publication_date:desc'); }
  if (args.sort === 'citations') { p.set('sort', 'cited_by_count:desc'); }
  const j = obj(await getJson(http, 'OpenAlex', `https://api.openalex.org/works?${p}`, { signal: opts.signal }));
  if (!Array.isArray(j.results)) { throw new WebError('OpenAlex: unexpected response shape (results)', 'parse'); }
  return j.results.map((w: any): Paper | undefined => {
    const title = stripTags(w?.display_name ?? w?.title);
    if (!title) { return undefined; }
    const doi = clean(w?.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    const arxivLoc = arr(w?.locations).map((l) => clean(l?.landing_page_url)).find((u) => /arxiv\.org\/abs\//.test(u));
    return {
      title, authors: arr(w?.authorships).map((a) => clean(a?.author?.display_name)).filter(Boolean),
      year: num(w?.publication_year), published: isoDate(w?.publication_date),
      venue: clean(w?.primary_location?.source?.display_name) || undefined, citations: num(w?.cited_by_count),
      doi: doi || undefined, arxivId: arxivLoc ? /abs\/(.+?)(v\d+)?$/.exec(arxivLoc)?.[1] : undefined,
      url: doi ? `https://doi.org/${doi}` : clean(w?.id),
      pdf: clean(w?.best_oa_location?.pdf_url) || clean(w?.open_access?.oa_url) || undefined,
      abstract: rebuildInvertedAbstract(w?.abstract_inverted_index) || undefined,
    };
  }).filter((x): x is Paper => !!x);
}

/* ------------------------------------------------------------------ rendering */

const SEARCHERS: Record<PaperSourceId, (c: Ctx) => Promise<Paper[]>> = {
  semanticscholar: searchS2, arxiv: searchArxiv, pubmed: searchPubmed, crossref: searchCrossref, openalex: searchOpenalex,
};

function authorLine(a: string[]): string {
  return a.length > 5 ? `${a.slice(0, 5).join(', ')} et al.` : a.join(', ');
}

function renderPaper(p: Paper, i: number, abstractMax = 350): string {
  const meta = [authorLine(p.authors), p.venue, p.citations !== undefined ? `${fmtInt(p.citations)} citations` : ''].filter(Boolean).join(' · ');
  const ids = [p.url, p.doi ? `DOI: ${p.doi}` : '', p.arxivId ? `arXiv: ${p.arxivId}` : '', p.pdf ? `PDF: ${p.pdf}` : ''].filter(Boolean).join(' · ');
  const lines = [`${i + 1}. **${p.title}**${p.year ? ` (${p.year})` : ''}${meta ? ` — ${meta}` : ''}`, `   ${ids}`];
  if (p.abstract && abstractMax) { lines.push(`   ${excerpt(p.abstract, abstractMax)}`); }
  return lines.join('\n');
}

const paperSource = (p: Paper): ConnectorSource => source(p.title, p.url, p.published ?? (p.year ? String(p.year) : undefined));

/**
 * Searches scholarly literature. 'auto' uses Semantic Scholar and falls back to arXiv, then OpenAlex,
 * when it fails (its keyless quota is small and 429s are common).
 */
export async function paperSearch(http: HttpFetch, args: PaperSearchArgs, opts: ConnectorOpts = {}): Promise<ConnectorResult> {
  const query = clean(args.query);
  if (!query) { throw new WebError('paperSearch: query is empty', 'unsupported'); }
  const a = { ...args, query };
  const limit = clampInt(args.limit, 10, 1, 50);
  const chain: PaperSourceId[] = !args.source || args.source === 'auto' ? ['semanticscholar', 'arxiv', 'openalex'] : [args.source];
  if (!SEARCHERS[chain[0]]) { throw new WebError(`paperSearch: unknown source "${String(args.source)}"`, 'unsupported'); }
  const notes: string[] = [];
  let papers: Paper[] | undefined, used: PaperSourceId = chain[0];
  for (let i = 0; i < chain.length && !papers; i++) {
    try { papers = await SEARCHERS[chain[i]]({ http, opts, args: a, limit }); used = chain[i]; } catch (e) {
      if (isAbort(e, opts.signal) || i === chain.length - 1) { throw notes.length && e instanceof WebError ? new WebError(`${e.message} (earlier: ${notes.join(' ')})`, e.code, e.status) : e; }
      notes.push(`${LABEL[chain[i]]} failed (${errMsg(e)}); used ${LABEL[chain[i + 1]]} instead.`);
    }
  }
  let list = (papers ?? []).filter((p) => yearOk(p, a));
  if (a.sort === 'citations') { list = [...list].sort((x, y) => (y.citations ?? -1) - (x.citations ?? -1)); }
  if (a.sort === 'date') { list = [...list].sort((x, y) => (y.published ?? String(y.year ?? '')).localeCompare(x.published ?? String(x.year ?? ''))); }
  list = list.slice(0, limit);
  const head = `${LABEL[used]} · ${list.length} paper${list.length === 1 ? '' : 's'} for “${query}”`;
  const lines = [head, ...notes.map((n) => `_${n}_`)];
  if (a.sort === 'citations' && (used === 'arxiv' || used === 'pubmed')) { lines.push(`_${LABEL[used]} has no citation counts; kept relevance order._`); }
  lines.push('');
  if (!list.length) { lines.push('No papers found. Try broader terms, another source, or a wider year range.'); }
  list.forEach((p, i) => lines.push(renderPaper(p, i)));
  return result(head, lines, list.map(paperSource));
}

/** DOI / arXiv / Semantic Scholar id or URL → the Semantic Scholar graph id form ("DOI:…", "ARXIV:…", hash). */
export function normalizePaperId(raw: string): string {
  let id = clean(raw);
  const doiUrl = /^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i.exec(id);
  if (doiUrl) { return `DOI:${decodeURIComponent(doiUrl[1])}`; }
  const ax = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\/(.+?)(?:v\d+)?(?:\.pdf)?\/?$/i.exec(id);
  if (ax) { return `ARXIV:${ax[1]}`; }
  const s2 = /^https?:\/\/(?:www\.|api\.)?semanticscholar\.org\/(?:paper\/(?:[^/]+\/)?|graph\/v1\/paper\/)([0-9a-f]{40}|[A-Za-z]+:[^/?#]+)/i.exec(id);
  if (s2) { return s2[1]; }
  id = id.replace(/^doi:\s*/i, 'DOI:').replace(/^arxiv:\s*/i, 'ARXIV:').replace(/^pmid:\s*/i, 'PMID:');
  if (/^10\.\d{4,9}\//.test(id)) { return `DOI:${id}`; }
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(id) || /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/.test(id)) { return `ARXIV:${id.replace(/v\d+$/, '')}`; }
  return id.replace(/^(ARXIV:.+?)v\d+$/, '$1');
}

/** Full record for one paper (with TL;DR) plus, on request, who cites it and what it cites. */
export async function paperDetails(http: HttpFetch, args: PaperDetailsArgs, opts: ConnectorOpts = {}): Promise<ConnectorResult> {
  const id = normalizePaperId(args.id);
  if (!id) { throw new WebError('paperDetails: id is empty', 'unsupported'); }
  const limit = clampInt(args.limit, 10, 1, 100);
  const headers = await s2Headers(opts);
  const fields = `${S2_FIELDS},tldr,referenceCount,influentialCitationCount,fieldsOfStudy,paperId`;
  const p = obj(await getJson(http, 'Semantic Scholar', `${S2}/paper/${encodeURI(id)}?fields=${fields}`, { headers, signal: opts.signal },
    { notFound: `no paper matches "${clean(args.id)}"` }));
  const paper = fromS2(p);
  if (!paper) { throw new WebError('Semantic Scholar: unexpected response shape (paper without title)', 'parse'); }
  const head = `Semantic Scholar · ${paper.title}`;
  const lines = [head, '', renderPaper(paper, 0, 0).replace(/^1\. /, '')];
  const counts = [num(p.citationCount) !== undefined ? `${fmtInt(p.citationCount)} citations` : '', num(p.influentialCitationCount) ? `${fmtInt(p.influentialCitationCount)} influential` : '',
    num(p.referenceCount) !== undefined ? `${fmtInt(p.referenceCount)} references` : '', arr(p.fieldsOfStudy).map(clean).filter(Boolean).join(', ')].filter(Boolean);
  if (counts.length) { lines.push(`   ${counts.join(' · ')}`); }
  const tldr = clean(obj(p.tldr).text);
  if (tldr) { lines.push('', `**TL;DR:** ${tldr}`); }
  if (paper.abstract) { lines.push('', `**Abstract:** ${excerpt(paper.abstract, 2000)}`); }
  const sources = [paperSource(paper)];
  const pid = clean(p.paperId) || id;
  for (const kind of args.include ?? []) {
    if (kind !== 'citations' && kind !== 'references') { continue; }
    const rel = obj(await getJson(http, 'Semantic Scholar', `${S2}/paper/${encodeURI(pid)}/${kind}?fields=title,year,authors,citationCount,externalIds,url&limit=${limit}`, { headers, signal: opts.signal }));
    const list = arr(rel.data).map((d) => fromS2(kind === 'citations' ? d?.citingPaper : d?.citedPaper)).filter((x): x is Paper => !!x);
    lines.push('', `### ${kind === 'citations' ? 'Cited by' : 'References'} (${list.length} shown${kind === 'citations' && num(p.citationCount) !== undefined ? ` of ${fmtInt(p.citationCount)}` : ''})`);
    if (!list.length) { lines.push('None listed.'); }
    list.forEach((x, i) => lines.push(renderPaper(x, i, 0)));
    sources.push(...list.map(paperSource));
  }
  return result(head, lines, sources);
}
