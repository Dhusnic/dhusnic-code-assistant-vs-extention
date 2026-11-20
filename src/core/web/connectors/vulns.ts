/**
 * Vulnerability lookup: OSV (by advisory id or by package/version) enriched with NVD for CVEs.
 * For a package query it also works out the smallest fixed version that clears every advisory, so the
 * model can give a concrete upgrade target instead of a list of ranges.
 */
import { ConnectorResult, ConnectorSource, HttpFetch, WebError } from '../types';
import { ConnectorOpts, arr, clean, excerpt, getJson, isoDate, num, obj, result, source, stripTags } from './util';
import { compareVersions } from './versions';

export interface VulnLookupArgs { ecosystem?: string; package?: string; version?: string; id?: string }

/** Our ecosystem names (and OSV's own, any case) → OSV ecosystem names. */
const OSV_ECOSYSTEMS: Record<string, string> = {
  npm: 'npm', pypi: 'PyPI', maven: 'Maven', crates: 'crates.io', 'crates.io': 'crates.io', cargo: 'crates.io', nuget: 'NuGet',
  go: 'Go', golang: 'Go', rubygems: 'RubyGems', gem: 'RubyGems', packagist: 'Packagist', composer: 'Packagist', hex: 'Hex',
  pub: 'Pub', debian: 'Debian', alpine: 'Alpine', ubuntu: 'Ubuntu', 'github actions': 'GitHub Actions', swifturl: 'SwiftURL',
};

export function osvEcosystem(e: string): string {
  const k = clean(e).toLowerCase();
  return OSV_ECOSYSTEMS[k] ?? clean(e);
}

/* ------------------------------------------------------------------ CVSS */

const W: Record<string, Record<string, number>> = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }, AC: { L: 0.77, H: 0.44 }, UI: { N: 0.85, R: 0.62 },
  C: { H: 0.56, L: 0.22, N: 0 }, I: { H: 0.56, L: 0.22, N: 0 }, A: { H: 0.56, L: 0.22, N: 0 },
};

/** CVSS 3.x "Roundup" (avoids floating-point artefacts such as 4.000000001 → 4.1). */
function roundUp(x: number): number {
  const i = Math.round(x * 100_000);
  return i % 10_000 === 0 ? i / 100_000 : (Math.floor(i / 10_000) + 1) / 10;
}

/** Base score of a CVSS 3.0/3.1 vector ("CVSS:3.1/AV:N/AC:L/…"); undefined when not a complete v3 vector. */
export function cvss3BaseScore(vector: string): number | undefined {
  if (!/^CVSS:3\.[01]\//.test(vector)) { return undefined; }
  const m: Record<string, string> = {};
  for (const part of vector.split('/').slice(1)) { const [k, v] = part.split(':'); if (k && v) { m[k] = v; } }
  const changed = m.S === 'C';
  if (m.S !== 'U' && !changed) { return undefined; }
  const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR as 'N' | 'L' | 'H'];
  const vals = ['AV', 'AC', 'UI', 'C', 'I', 'A'].map((k) => W[k][m[k]]);
  if (pr === undefined || vals.some((v) => v === undefined)) { return undefined; }
  const [av, ac, ui, c, i, a] = vals;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  if (impact <= 0) { return 0; }
  const expl = 8.22 * av * ac * pr * ui;
  return roundUp(Math.min(changed ? 1.08 * (impact + expl) : impact + expl, 10));
}

const band = (s: number): string => (s === 0 ? 'NONE' : s < 4 ? 'LOW' : s < 7 ? 'MEDIUM' : s < 9 ? 'HIGH' : 'CRITICAL');
const LABEL_RANK: Record<string, number> = { CRITICAL: 9.5, HIGH: 7.5, MODERATE: 5, MEDIUM: 5, LOW: 2, NONE: 0 };

interface Severity { label?: string; score?: number; vector?: string; rank: number }

function osvSeverity(v: any): Severity {
  let score: number | undefined, vector: string | undefined;
  for (const s of arr(v?.severity)) {
    const t = clean(s?.score);
    const n = num(t) ?? cvss3BaseScore(t);
    if (n !== undefined && (score === undefined || n > score)) { score = n; vector = /^CVSS:/.test(t) ? t : undefined; }
    if (!vector && /^CVSS:4/.test(t)) { vector = t; }
  }
  const label = clean(obj(v?.database_specific).severity).toUpperCase()
    || clean(arr(v?.affected).map((a) => obj(a?.ecosystem_specific).severity ?? obj(a?.database_specific).severity).find((x) => typeof x === 'string')).toUpperCase()
    || (score !== undefined ? band(score) : '');
  return { label: label || undefined, score, vector, rank: score ?? LABEL_RANK[label] ?? -1 };
}

/* ------------------------------------------------------------------ OSV ranges */

interface OsvEvent { introduced?: string; fixed?: string; last_affected?: string; limit?: string }

const evVersion = (e: OsvEvent): string => clean(e.introduced ?? e.fixed ?? e.last_affected ?? e.limit);

/** Whether `version` is affected per one OSV `affected[]` entry (ranges walked per the OSV spec). */
export function isAffected(version: string, affected: any): boolean {
  if (arr(affected?.versions).map(clean).includes(version)) { return true; }
  for (const range of arr(affected?.ranges)) {
    if (!/^(SEMVER|ECOSYSTEM)$/.test(clean(range?.type))) { continue; }
    const events = arr(range?.events).map(obj) as OsvEvent[];
    const sorted = [...events].sort((a, b) => {
      const av = evVersion(a), bv = evVersion(b);
      if (av === '0') { return -1; }
      if (bv === '0') { return 1; }
      return compareVersions(av, bv);
    });
    let hit = false;
    for (const e of sorted) {
      if (e.introduced !== undefined && (clean(e.introduced) === '0' || compareVersions(version, clean(e.introduced)) >= 0)) { hit = true; }
      else if (e.fixed !== undefined && compareVersions(version, clean(e.fixed)) >= 0) { hit = false; }
      else if (e.last_affected !== undefined && compareVersions(version, clean(e.last_affected)) > 0) { hit = false; }
    }
    if (hit) { return true; }
  }
  return false;
}

const samePkg = (a: any, name: string, eco: string): boolean =>
  clean(a?.package?.name).toLowerCase() === name.toLowerCase() && (!eco || clean(a?.package?.ecosystem).split(':')[0].toLowerCase() === eco.toLowerCase());

function rangeText(a: any): string {
  return arr(a?.ranges).filter((r) => clean(r?.type) !== 'GIT').map((r) => arr(r?.events).map((e) => {
    const [k, v] = Object.entries(obj(e))[0] ?? [];
    return k ? `${k === 'last_affected' ? 'last affected' : k} ${clean(v)}` : '';
  }).filter(Boolean).join(', ')).filter(Boolean).join('; ');
}

const fixedOf = (a: any): string[] => arr(a?.ranges).flatMap((r) => arr(r?.events).map((e) => clean(e?.fixed)).filter(Boolean));

/**
 * The smallest fixed version (above `current`, when given) that no listed advisory affects; undefined
 * when every candidate is still affected or no advisory names a fix.
 */
export function minimalSafeVersion(vulns: any[], name: string, eco: string, current?: string): string | undefined {
  const affected = vulns.flatMap((v) => arr(v?.affected).filter((a) => samePkg(a, name, eco)));
  const candidates = [...new Set(affected.flatMap(fixedOf))].sort(compareVersions)
    .filter((c) => !current || compareVersions(c, current) > 0);
  return candidates.find((c) => !affected.some((a) => isAffected(c, a)));
}

/* ------------------------------------------------------------------ NVD */

interface NvdInfo { lines: string[]; sources: ConnectorSource[] }

async function nvd(http: HttpFetch, cve: string, opts: ConnectorOpts): Promise<NvdInfo | undefined> {
  let key: string | undefined;
  try { key = clean(await opts.keys?.('nvd')) || undefined; } catch { key = undefined; }
  const j = obj(await getJson(http, 'NVD', `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(cve)}`,
    { headers: key ? { apiKey: key } : {}, signal: opts.signal }, { auth: 'access denied — the NVD API key is invalid, or the keyless rate limit (5 requests / 30 s) was hit' }));
  const c = obj(obj(arr(j.vulnerabilities)[0]).cve);
  if (!c.id) { return undefined; }
  const metrics = obj(c.metrics);
  const lines: string[] = ['', `**NVD** — ${clean(c.vulnStatus) || 'record'} · published ${isoDate(c.published) ?? '?'} · last modified ${isoDate(c.lastModified) ?? '?'}`];
  const desc = arr(c.descriptions).find((d) => d?.lang === 'en') ?? arr(c.descriptions)[0];
  if (desc) { lines.push(excerpt(desc.value, 1200)); }
  for (const [key2, label] of [['cvssMetricV40', 'CVSS v4.0'], ['cvssMetricV31', 'CVSS v3.1'], ['cvssMetricV30', 'CVSS v3.0']] as const) {
    const list = arr(metrics[key2]);
    const m = obj(list.find((x) => x?.type === 'Primary') ?? list[0]);
    const d = obj(m.cvssData);
    if (num(d.baseScore) !== undefined) {
      lines.push(`- ${label}: **${d.baseScore} ${clean(d.baseSeverity) || band(Number(d.baseScore))}** \`${clean(d.vectorString)}\`${m.source ? ` (${clean(m.source)})` : ''}`);
    }
  }
  const cwes = [...new Set(arr(c.weaknesses).flatMap((w) => arr(w?.description).map((d) => clean(d?.value))).filter((x) => /^CWE-\d+$/.test(x)))];
  if (cwes.length) { lines.push(`- Weakness: ${cwes.join(', ')}`); }
  const refs = arr(c.references).slice(0, 8);
  if (refs.length) {
    lines.push('- References:');
    for (const r of refs) { lines.push(`  - ${clean(r?.url)}${arr(r?.tags).length ? ` (${arr(r.tags).map(clean).join(', ')})` : ''}`); }
  }
  const url = `https://nvd.nist.gov/vuln/detail/${clean(c.id)}`;
  return { lines, sources: [source(`${clean(c.id)} (NVD)`, url, isoDate(c.published)), ...refs.map((r) => source(clean(r?.url), clean(r?.url)))] };
}

/* ------------------------------------------------------------------ entry point */

/** Advisories listed in full for a package; the verdict still accounts for all of them. */
const MAX_LISTED = 40;

const osvUrl = (id: string): string => `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;

function sevText(s: Severity): string {
  return [s.label, s.score !== undefined ? s.score.toFixed(1) : ''].filter(Boolean).join(' ') || 'severity unknown';
}

async function byId(http: HttpFetch, rawId: string, opts: ConnectorOpts): Promise<ConnectorResult> {
  const id = /^(cve|ghsa)-/i.test(rawId) ? rawId.replace(/^(cve|ghsa)/i, (m) => m.toUpperCase()) : rawId;
  const isCve = /^CVE-\d{4}-\d{4,}$/i.test(id);
  const [osv, nv] = await Promise.all([
    getJson(http, 'OSV', `https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, { signal: opts.signal }).catch((e) => {
      if (opts.signal?.aborted || !(e instanceof WebError && e.status === 404)) { throw e; }
      return undefined;
    }),
    isCve ? nvd(http, id.toUpperCase(), opts).catch((e) => { if (opts.signal?.aborted) { throw e; } return { lines: ['', `_NVD lookup failed: ${e instanceof Error ? e.message : String(e)}_`], sources: [] }; }) : undefined,
  ]);
  if (!osv && (!nv || !nv.sources.length)) { throw new WebError(`OSV: no advisory found for ${id}`, 'http', 404); }
  const v = obj(osv);
  const head = `${osv ? 'OSV' : 'NVD'} · ${id}${v.summary ? ` — ${clean(v.summary)}` : ''}`;
  const lines = [head];
  const sources: ConnectorSource[] = [];
  if (osv) {
    const sev = osvSeverity(v);
    lines.push('', `**${clean(v.id)}** — ${sevText(sev)}${sev.vector ? ` \`${sev.vector}\`` : ''} · published ${isoDate(v.published) ?? '?'} · modified ${isoDate(v.modified) ?? '?'}${v.withdrawn ? ` · WITHDRAWN ${isoDate(v.withdrawn)}` : ''}`);
    if (arr(v.aliases).length) { lines.push(`Aliases: ${arr(v.aliases).map(clean).join(', ')}`); }
    const cwes = arr(obj(v.database_specific).cwe_ids).map(clean).filter(Boolean);
    if (cwes.length) { lines.push(`Weakness: ${cwes.join(', ')}`); }
    if (v.details) { lines.push('', excerpt(v.details, 1500)); }
    const aff = arr(v.affected).slice(0, 12);
    if (aff.length) {
      lines.push('', 'Affected packages:');
      for (const a of aff) {
        const fixed = fixedOf(a);
        lines.push(`- ${clean(a?.package?.ecosystem)} ${clean(a?.package?.name)}: ${rangeText(a) || `${arr(a?.versions).length} listed versions`}${fixed.length ? ` → fixed in ${fixed.join(', ')}` : ' → no fix listed'}`);
      }
    }
    const refs = arr(v.references).slice(0, 8);
    if (refs.length) { lines.push('', 'References:', ...refs.map((r) => `- ${clean(r?.url)}${r?.type ? ` (${clean(r.type).toLowerCase()})` : ''}`)); }
    lines.push('', osvUrl(clean(v.id)));
    sources.push(source(`${clean(v.id)}${v.summary ? `: ${clean(v.summary)}` : ''}`, osvUrl(clean(v.id)), isoDate(v.published)), ...refs.map((r) => source(clean(r?.url), clean(r?.url))));
  }
  if (nv) { lines.push(...nv.lines); sources.push(...nv.sources); }
  return result(head, lines, sources);
}

async function byPackage(http: HttpFetch, args: VulnLookupArgs, opts: ConnectorOpts): Promise<ConnectorResult> {
  const name = clean(args.package);
  const eco = osvEcosystem(args.ecosystem ?? '');
  const version = clean(args.version) || undefined;
  if (!eco) { throw new WebError('vulnLookup: ecosystem is required with package (npm, pypi, maven, crates, nuget, go, rubygems, packagist)', 'unsupported'); }
  const vulns: any[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const body: Record<string, unknown> = { package: { name, ecosystem: eco }, ...(version ? { version } : {}), ...(pageToken ? { page_token: pageToken } : {}) };
    const j = obj(await getJson(http, 'OSV', 'https://api.osv.dev/v1/query', {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal: opts.signal,
    }));
    if (j.vulns !== undefined && !Array.isArray(j.vulns)) { throw new WebError('OSV: unexpected response shape (vulns)', 'parse'); }
    vulns.push(...arr(j.vulns));
    pageToken = clean(j.next_page_token) || undefined;
    if (!pageToken) { break; }
  }
  const label = `${name}${version ? `@${version}` : ''}`;
  const rows = vulns.filter((v) => !v?.withdrawn).map((v) => ({ v, sev: osvSeverity(v) })).sort((a, b) => b.sev.rank - a.sev.rank);
  const head = `OSV · ${rows.length} known vulnerabilit${rows.length === 1 ? 'y' : 'ies'} for ${eco} ${label}`;
  const lines = [head, ''];
  const shown = rows.slice(0, MAX_LISTED);
  shown.forEach(({ v, sev }, i) => {
    const id = clean(v.id);
    const aff = arr(v.affected).filter((a) => samePkg(a, name, eco));
    const fixed = [...new Set(aff.flatMap(fixedOf))];
    const aliases = arr(v.aliases).map(clean).filter(Boolean);
    lines.push(`${i + 1}. **${id}**${aliases.length ? ` (${aliases.join(', ')})` : ''} — ${sevText(sev)} — ${stripTags(v.summary) || excerpt(v.details, 160) || 'no summary'}`);
    lines.push(`   Affected: ${aff.map(rangeText).filter(Boolean).join('; ') || 'see advisory'} · Fixed in: ${fixed.join(', ') || 'no fix yet'} · Published ${isoDate(v.published) ?? '?'}`);
    lines.push(`   ${osvUrl(id)}`);
  });
  if (rows.length > shown.length) { lines.push(`… and ${rows.length - shown.length} more.`); }
  lines.push('');
  if (!rows.length) {
    lines.push(`Verdict: no known vulnerabilities in OSV for ${label}.`);
  } else {
    const safe = minimalSafeVersion(rows.map((r) => r.v), name, eco, version);
    const verb = version ? 'affect' : 'are recorded for';
    const n = `${rows.length} known vulnerabilit${rows.length === 1 ? 'y' : 'ies'}`;
    lines.push(safe
      ? `Verdict: ${n} ${verb} ${label}; upgrade to ≥ ${safe}.`
      : `Verdict: ${n} ${verb} ${label}; no single fixed version clears all of them — review each advisory (some have no fix yet).`);
  }
  return result(head, lines, shown.map(({ v }) => source(`${clean(v.id)}: ${stripTags(v.summary)}`, osvUrl(clean(v.id)), isoDate(v.published))));
}

/** Looks up one advisory (CVE / GHSA / PYSEC / … id) or every advisory for a package (and version). */
export async function vulnLookup(http: HttpFetch, args: VulnLookupArgs, opts: ConnectorOpts = {}): Promise<ConnectorResult> {
  const id = clean(args.id);
  if (id) { return byId(http, id, opts); }
  if (clean(args.package)) { return byPackage(http, args, opts); }
  throw new WebError('vulnLookup: give an advisory id (CVE-…, GHSA-…) or a package with its ecosystem', 'unsupported');
}
