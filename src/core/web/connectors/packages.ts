/**
 * Package registry facts (latest version, dates, license, downloads, dependencies, deprecation) for
 * npm, PyPI, Maven Central, crates.io, NuGet, the Go module proxy, RubyGems and Packagist, normalised
 * into one summary so the model can compare packages across ecosystems.
 */
import { ConnectorResult, ConnectorSource, HttpFetch, WebError } from '../types';
import { ConnectorOpts, arr, clean, ensureOk, excerpt, fmtInt, getJson, isoDate, num, obj, result, source, stripTags, tryJson } from './util';
import { compareVersions, isPrerelease } from './versions';

export type Ecosystem = 'npm' | 'pypi' | 'maven' | 'crates' | 'nuget' | 'go' | 'rubygems' | 'packagist';

export interface PackageInfoArgs { ecosystem: Ecosystem; name: string; version?: string }

interface VersionRow { v: string; date?: string; flag?: string }

interface PkgInfo {
  registry: string;
  name: string;
  /** The version the details describe (requested or latest). */
  version?: string;
  latest?: string;
  released?: string;
  license?: string;
  description?: string;
  homepage?: string;
  repo?: string;
  downloads?: string;
  deps?: number;
  maintainers?: number;
  deprecated?: string;
  url: string;
  versions: VersionRow[];
  notes: string[];
}

type Fetcher = (http: HttpFetch, name: string, version: string | undefined, signal?: AbortSignal) => Promise<PkgInfo>;

const notFound = (registry: string, name: string): { notFound: string } => ({ notFound: `package "${name}" not found on ${registry}` });

/** "git+https://github.com/a/b.git" → "https://github.com/a/b". */
function repoUrl(v: unknown): string | undefined {
  const s = clean(typeof v === 'string' ? v : obj(v).url);
  if (!s) { return undefined; }
  const gh = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(s);
  if (gh && !s.includes(':')) { return `https://github.com/${gh[1]}`; }
  return s.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '') || undefined;
}

function pickVersion(info: PkgInfo, all: string[], requested?: string): string | undefined {
  if (!requested) { return info.latest; }
  if (all.includes(requested)) { return requested; }
  info.notes.push(`Version ${requested} was not found on ${info.registry}; showing ${info.latest ?? 'the latest'} instead.`);
  return info.latest;
}

/** The newest rows first, by date when known, else by version. */
function recent(rows: VersionRow[], n = 5): VersionRow[] {
  return [...rows].sort((a, b) => (b.date && a.date ? b.date.localeCompare(a.date) : 0) || compareVersions(b.v, a.v)).slice(0, n);
}

/* ------------------------------------------------------------------ npm */

const npm: Fetcher = async (http, name, version, signal) => {
  const enc = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  const [doc, dl] = await Promise.all([
    getJson(http, 'npm', `https://registry.npmjs.org/${enc}`, { signal, maxBytes: 64 * 1024 * 1024 }, notFound('npm', name)),
    tryJson(http, 'npm downloads', `https://api.npmjs.org/downloads/point/last-week/${name}`, { signal }),
  ]);
  const d = obj(doc), time = obj(d.time), versions = obj(d.versions);
  const info: PkgInfo = { registry: 'npm', name: clean(d.name) || name, latest: clean(obj(d['dist-tags']).latest) || undefined, url: `https://www.npmjs.com/package/${name}`, versions: [], notes: [] };
  const v = pickVersion(info, Object.keys(versions), version);
  const vd = obj(v ? versions[v] : undefined);
  const lic = vd.license ?? d.license;
  Object.assign(info, {
    version: v, released: isoDate(v ? time[v] : undefined), license: clean(typeof lic === 'string' ? lic : obj(lic).type) || undefined,
    description: stripTags(vd.description ?? d.description) || undefined, homepage: clean(vd.homepage ?? d.homepage) || undefined,
    repo: repoUrl(vd.repository ?? d.repository), deps: v ? Object.keys(obj(vd.dependencies)).length : undefined,
    maintainers: Array.isArray(d.maintainers) ? d.maintainers.length : undefined,
    deprecated: typeof vd.deprecated === 'string' && vd.deprecated ? clean(vd.deprecated) : undefined,
  });
  const dlCount = num(obj(dl).downloads);
  if (dlCount !== undefined) { info.downloads = `${fmtInt(dlCount)} last week`; }
  info.versions = recent(Object.keys(versions).map((x) => ({
    v: x, date: isoDate(time[x]), flag: obj(versions[x]).deprecated ? 'deprecated' : undefined,
  })));
  return info;
};

/* ------------------------------------------------------------------ PyPI */

const pypi: Fetcher = async (http, name, version, signal) => {
  const base = `https://pypi.org/pypi/${encodeURIComponent(name)}`;
  const doc = obj(await getJson(http, 'PyPI', `${base}/json`, { signal }, notFound('PyPI', name)));
  const releases = obj(doc.releases);
  const latest = clean(obj(doc.info).version);
  const info: PkgInfo = { registry: 'PyPI', name: clean(obj(doc.info).name) || name, latest: latest || undefined, url: `https://pypi.org/project/${name}/`, versions: [], notes: [] };
  const v = pickVersion(info, Object.keys(releases), version);
  const vdoc = v && v !== latest ? obj(await tryJson(http, 'PyPI', `${base}/${encodeURIComponent(v)}/json`, { signal })) : doc;
  const i = obj(vdoc.info);
  const urls = obj(i.project_urls);
  const findUrl = (re: RegExp): string | undefined => clean(Object.entries(urls).find(([k]) => re.test(k))?.[1]) || undefined;
  const licClassifier = arr(i.classifiers).map(clean).find((c) => c.startsWith('License ::'))?.split('::').pop()?.trim();
  const license = clean(i.license_expression) || (clean(i.license).length <= 80 ? clean(i.license) : '') || licClassifier;
  const files = arr(v ? releases[v] : undefined);
  const yanked = files.length > 0 && files.every((f) => f?.yanked);
  Object.assign(info, {
    version: v, released: isoDate(files[0]?.upload_time_iso_8601 ?? files[0]?.upload_time), license: license || undefined,
    description: stripTags(i.summary) || undefined, homepage: clean(i.home_page) || findUrl(/^home/i) || undefined,
    repo: findUrl(/source|repo|code|github/i), deps: Array.isArray(i.requires_dist) ? i.requires_dist.filter((r: unknown) => !/extra\s*==/.test(clean(r))).length : i.requires_dist === null ? 0 : undefined,
    deprecated: yanked ? `yanked${files[0]?.yanked_reason ? `: ${clean(files[0].yanked_reason)}` : ''}` : undefined,
  });
  info.notes.push('PyPI publishes no official download counts (see pypistats.org).');
  info.versions = recent(Object.entries(releases).filter(([, f]) => arr(f).length).map(([x, f]) => ({
    v: x, date: isoDate(arr(f)[0]?.upload_time_iso_8601 ?? arr(f)[0]?.upload_time), flag: arr(f).every((y) => y?.yanked) ? 'yanked' : undefined,
  })));
  return info;
};

/* ------------------------------------------------------------------ Maven Central */

const maven: Fetcher = async (http, name, version, signal) => {
  const [g, a] = name.split(':').map(clean);
  if (!g || !a) { throw new WebError('Maven: name must be "groupId:artifactId"', 'unsupported'); }
  const q = `g:%22${encodeURIComponent(g)}%22+AND+a:%22${encodeURIComponent(a)}%22`;
  const j = obj(await getJson(http, 'Maven Central', `https://search.maven.org/solrsearch/select?q=${q}&core=gav&rows=20&wt=json`, { signal }));
  const docs = obj(j.response).docs;
  if (!Array.isArray(docs)) { throw new WebError('Maven Central: unexpected response shape (response.docs)', 'parse'); }
  if (!docs.length) { throw new WebError(`Maven Central: artifact "${name}" not found`, 'http', 404); }
  const rows = docs.map((d: any) => ({ v: clean(d?.v), date: isoDate(num(d?.timestamp)) })).filter((r) => r.v);
  const stable = recent(rows, rows.length).find((r) => !isPrerelease(r.v) && !/snapshot/i.test(r.v)) ?? recent(rows, 1)[0];
  const info: PkgInfo = { registry: 'Maven Central', name, latest: stable?.v, url: `https://central.sonatype.com/artifact/${g}/${a}`, versions: recent(rows), notes: [] };
  const v = pickVersion(info, rows.map((r) => r.v), version);
  info.version = v;
  info.released = rows.find((r) => r.v === v)?.date;
  if (v) {
    // The POM carries what the search index lacks: description, license, SCM, dependencies.
    const res = await http(`https://repo1.maven.org/maven2/${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}.pom`, { signal }).catch((e) => { if (signal?.aborted) { throw e; } return undefined; });
    if (res && res.status < 400) {
      const pom = res.body.toString('utf8').replace(/<!--[\s\S]*?-->/g, '');
      const top = pom.replace(/<(parent|dependencyManagement|build|profiles|dependencies|licenses|scm|developers|organization|distributionManagement)\b[\s\S]*?<\/\1>/g, '');
      const pick = (xml: string, t: string): string => stripTags(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(xml)?.[1] ?? '');
      const depsBlock = /<dependencies>([\s\S]*?)<\/dependencies>/.exec(pom.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, ''))?.[1] ?? '';
      const deps = [...depsBlock.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].filter((m) => !/<scope>\s*(test|provided)\s*<\/scope>/.test(m[1]));
      Object.assign(info, {
        description: pick(top, 'description') || undefined, homepage: pick(top, 'url') || undefined,
        license: pick(/<licenses>([\s\S]*?)<\/licenses>/.exec(pom)?.[1] ?? '', 'name') || undefined,
        repo: repoUrl(pick(/<scm>([\s\S]*?)<\/scm>/.exec(pom)?.[1] ?? '', 'url')), deps: deps.length,
      });
    }
  }
  return info;
};

/* ------------------------------------------------------------------ crates.io */

const crates: Fetcher = async (http, name, version, signal) => {
  const base = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`;
  const j = obj(await getJson(http, 'crates.io', base, { signal }, notFound('crates.io', name)));
  const c = obj(j.crate);
  if (!c.name) { throw new WebError('crates.io: unexpected response shape (crate)', 'parse'); }
  const vs = arr(j.versions);
  const latest = clean(c.max_stable_version) || clean(c.newest_version) || clean(c.max_version);
  const info: PkgInfo = { registry: 'crates.io', name: clean(c.name), latest: latest || undefined, url: `https://crates.io/crates/${name}`, versions: [], notes: [] };
  const v = pickVersion(info, vs.map((x) => clean(x?.num)), version);
  const vd = obj(vs.find((x) => clean(x?.num) === v));
  const [deps, owners] = await Promise.all([
    v ? tryJson(http, 'crates.io', `${base}/${encodeURIComponent(v)}/dependencies`, { signal }) : undefined,
    tryJson(http, 'crates.io', `${base}/owners`, { signal }),
  ]);
  const total = num(c.downloads), recentDl = num(c.recent_downloads);
  Object.assign(info, {
    version: v, released: isoDate(vd.created_at), license: clean(vd.license) || undefined, description: stripTags(c.description) || undefined,
    homepage: clean(c.homepage) || undefined, repo: repoUrl(c.repository),
    downloads: [recentDl !== undefined ? `${fmtInt(recentDl)} last 90 days` : '', total !== undefined ? `${fmtInt(total)} total` : ''].filter(Boolean).join(', ') || undefined,
    deps: deps ? arr(obj(deps).dependencies).filter((d) => clean(d?.kind) !== 'dev').length : undefined,
    maintainers: owners ? arr(obj(owners).users).length : undefined,
    deprecated: vd.yanked ? 'yanked' : undefined,
  });
  info.versions = recent(vs.map((x) => ({ v: clean(x?.num), date: isoDate(x?.created_at), flag: x?.yanked ? 'yanked' : undefined })).filter((r) => r.v));
  return info;
};

/* ------------------------------------------------------------------ NuGet */

const nuget: Fetcher = async (http, name, version, signal) => {
  const id = name.toLowerCase();
  const index = obj(await getJson(http, 'NuGet', `https://api.nuget.org/v3/registration5-semver1/${encodeURIComponent(id)}/index.json`, { signal }, notFound('NuGet', name)));
  const pages = arr(index.items);
  if (!pages.length) { throw new WebError(`NuGet: package "${name}" has no registration pages`, 'parse'); }
  const leaves: any[] = [];
  // Small packages inline every page; large ones only link the pages, so fetch the newest two.
  for (const page of pages.slice(-2)) {
    const items = Array.isArray(page?.items) ? page.items : arr(obj(await tryJson(http, 'NuGet', clean(page?.['@id']), { signal })).items);
    leaves.push(...items);
  }
  const entries = leaves.map((l) => obj(l?.catalogEntry)).filter((e) => clean(e.version));
  const listed = entries.filter((e) => e.listed !== false);
  const stable = [...listed].sort((a, b) => compareVersions(clean(b.version), clean(a.version))).find((e) => !isPrerelease(clean(e.version)));
  const info: PkgInfo = { registry: 'NuGet', name: clean(entries[0]?.id) || name, latest: clean(stable?.version) || clean(pages[pages.length - 1]?.upper) || undefined, url: `https://www.nuget.org/packages/${name}`, versions: [], notes: [] };
  const v = pickVersion(info, entries.map((e) => clean(e.version)), version);
  const e = obj(entries.find((x) => clean(x.version) === v));
  const search = await tryJson(http, 'NuGet', `https://azuresearch-usnc.nuget.org/query?q=packageid:${encodeURIComponent(name)}&prerelease=true&take=1`, { signal });
  const hit = obj(arr(obj(search).data)[0]);
  const dep = obj(e.deprecation);
  const published = isoDate(e.published);
  Object.assign(info, {
    version: v, released: published && !published.startsWith('1900') ? published : undefined,
    license: clean(e.licenseExpression) || clean(e.licenseUrl) || undefined, description: excerpt(e.description, 400) || undefined,
    homepage: clean(e.projectUrl) || undefined, repo: undefined,
    deps: arr(e.dependencyGroups).length ? new Set(arr(e.dependencyGroups).flatMap((g) => arr(g?.dependencies).map((d) => clean(d?.id).toLowerCase()))).size : 0,
    downloads: num(hit.totalDownloads) !== undefined ? `${fmtInt(hit.totalDownloads)} total` : undefined,
    maintainers: Array.isArray(hit.owners) ? hit.owners.length : undefined,
    deprecated: dep.reasons || dep.message ? clean([arr(dep.reasons).join(', '), clean(dep.message)].filter(Boolean).join(' — ')) : undefined,
  });
  if (arr(e.vulnerabilities).length) { info.notes.push(`NuGet lists ${arr(e.vulnerabilities).length} known vulnerabilit${arr(e.vulnerabilities).length === 1 ? 'y' : 'ies'} for ${v}.`); }
  info.versions = recent(entries.map((x) => {
    const d = isoDate(x.published);
    return { v: clean(x.version), date: d && !d.startsWith('1900') ? d : undefined, flag: x.listed === false ? 'unlisted' : x.deprecation ? 'deprecated' : undefined };
  }));
  return info;
};

/* ------------------------------------------------------------------ Go module proxy */

/** The proxy's case encoding: every upper-case letter becomes "!" + lower-case. */
export const goModuleEscape = (path: string): string => path.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);

const go: Fetcher = async (http, name, version, signal) => {
  const base = `https://proxy.golang.org/${goModuleEscape(name)}/@v`;
  const hints = notFound('the Go module proxy', name);
  const [listRes, latestDoc] = await Promise.all([
    http(`${base}/list`, { signal }).then((r) => ensureOk('Go proxy', r, hints)),
    tryJson(http, 'Go proxy', `https://proxy.golang.org/${goModuleEscape(name)}/@latest`, { signal }),
  ]);
  const listed = listRes.body.toString('utf8').split('\n').map(clean).filter(Boolean);
  const latest = clean(obj(latestDoc).Version) || [...listed].sort((a, b) => compareVersions(b, a))[0];
  if (!latest) { throw new WebError(`Go proxy: module "${name}" has no versions`, 'http', 404); }
  const info: PkgInfo = { registry: 'Go module proxy', name, latest, url: `https://pkg.go.dev/${name}`, versions: [], notes: [] };
  const v = pickVersion(info, listed.length ? listed : [latest], version) ?? latest;
  const newest = [...new Set([...listed, latest])].sort((a, b) => compareVersions(b, a)).slice(0, 5);
  const [infos, mod] = await Promise.all([
    Promise.all(newest.map((x) => tryJson(http, 'Go proxy', `${base}/${goModuleEscape(x)}.info`, { signal }))),
    http(`${base}/${goModuleEscape(v)}.mod`, { signal }).catch((e) => { if (signal?.aborted) { throw e; } return undefined; }),
  ]);
  info.versions = newest.map((x, i) => ({ v: x, date: isoDate(obj(infos[i]).Time) }));
  info.version = v;
  info.released = info.versions.find((r) => r.v === v)?.date ?? isoDate(obj(latestDoc).Time);
  if (mod && mod.status < 400) {
    const text = mod.body.toString('utf8');
    const block = [...text.matchAll(/^require\s*\(([\s\S]*?)^\)/gm)].flatMap((m) => m[1].split('\n'));
    const single = [...text.matchAll(/^require\s+([^\s(]\S*\s+\S+)/gm)].map((m) => m[1]);
    info.deps = [...block, ...single].filter((l) => !/\/\/\s*indirect\b/.test(l)).map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean).length;
  }
  const gh = /^(github\.com|gitlab\.com|bitbucket\.org)\/[^/]+\/[^/]+/.exec(name);
  if (gh) { info.repo = `https://${gh[0]}`; }
  if (/\+incompatible$/.test(v)) { info.notes.push('This version is "+incompatible" (major version ≥ 2 without a /vN module path).'); }
  info.notes.push('License and downloads are not exposed by the module proxy; see pkg.go.dev.');
  return info;
};

/* ------------------------------------------------------------------ RubyGems */

const rubygems: Fetcher = async (http, name, version, signal) => {
  const enc = encodeURIComponent(name);
  const [g, vs, owners] = await Promise.all([
    getJson(http, 'RubyGems', `https://rubygems.org/api/v1/gems/${enc}.json`, { signal }, notFound('RubyGems', name)),
    tryJson(http, 'RubyGems', `https://rubygems.org/api/v1/versions/${enc}.json`, { signal }),
    tryJson(http, 'RubyGems', `https://rubygems.org/api/v1/gems/${enc}/owners.json`, { signal }),
  ]);
  const gem = obj(g), versions = arr(vs);
  const info: PkgInfo = { registry: 'RubyGems', name: clean(gem.name) || name, latest: clean(gem.version) || undefined, url: `https://rubygems.org/gems/${name}`, versions: [], notes: [] };
  const v = pickVersion(info, versions.length ? versions.map((x) => clean(x?.number)) : [clean(gem.version)], version);
  const vd = obj(versions.find((x) => clean(x?.number) === v));
  const dl = num(gem.downloads);
  Object.assign(info, {
    version: v, released: isoDate(v === info.latest ? gem.version_created_at ?? vd.created_at : vd.created_at),
    license: arr(v === info.latest ? gem.licenses : vd.licenses ?? gem.licenses).map(clean).filter(Boolean).join(', ') || undefined,
    description: stripTags(gem.info) || undefined, homepage: clean(gem.homepage_uri) || undefined,
    repo: repoUrl(gem.source_code_uri), downloads: dl !== undefined ? `${fmtInt(dl)} total` : undefined,
    deps: v === info.latest ? arr(obj(gem.dependencies).runtime).length : undefined,
    maintainers: Array.isArray(owners) ? owners.length : undefined, deprecated: gem.yanked || vd.yanked ? 'yanked' : undefined,
  });
  info.versions = recent(versions.map((x) => ({ v: clean(x?.number), date: isoDate(x?.created_at), flag: x?.prerelease ? 'pre-release' : undefined })).filter((r) => r.v));
  return info;
};

/* ------------------------------------------------------------------ Packagist */

/** Expands Composer 2 "minified" metadata, where each version only lists the fields that changed. */
export function expandComposerMinified(versions: unknown[]): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  let prev: Record<string, any> = {};
  for (const raw of versions) {
    const cur: Record<string, any> = { ...prev };
    for (const [k, val] of Object.entries(obj(raw))) { if (val === '__unset') { delete cur[k]; } else { cur[k] = val; } }
    out.push(cur);
    prev = cur;
  }
  return out;
}

const packagist: Fetcher = async (http, name, version, signal) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) { throw new WebError('Packagist: name must be "vendor/package"', 'unsupported'); }
  const lower = name.toLowerCase();
  const [p2, meta] = await Promise.all([
    getJson(http, 'Packagist', `https://repo.packagist.org/p2/${lower}.json`, { signal }, notFound('Packagist', name)),
    tryJson(http, 'Packagist', `https://packagist.org/packages/${lower}.json`, { signal }),
  ]);
  const rawVersions = obj(obj(p2).packages)[lower];
  if (!Array.isArray(rawVersions)) { throw new WebError('Packagist: unexpected response shape (packages)', 'parse'); }
  const all = clean(obj(p2).minified) ? expandComposerMinified(rawVersions) : rawVersions.map(obj);
  const stable = all.find((x) => !isPrerelease(clean(x.version)) && !/dev/i.test(clean(x.version))) ?? all[0];
  const info: PkgInfo = { registry: 'Packagist', name, latest: clean(stable?.version) || undefined, url: `https://packagist.org/packages/${name}`, versions: [], notes: [] };
  const v = pickVersion(info, all.map((x) => clean(x.version)), version);
  const vd = obj(all.find((x) => clean(x.version) === v));
  const pkg = obj(obj(meta).package);
  const monthly = num(obj(pkg.downloads).monthly), total = num(obj(pkg.downloads).total);
  const abandoned = pkg.abandoned ?? vd.abandoned;
  Object.assign(info, {
    version: v, released: isoDate(vd.time), license: arr(vd.license).map(clean).filter(Boolean).join(', ') || undefined,
    description: stripTags(vd.description ?? pkg.description) || undefined, homepage: clean(vd.homepage) || undefined,
    repo: repoUrl(obj(vd.source).url) ?? (clean(pkg.repository) || undefined),
    deps: Object.keys(obj(vd.require)).filter((k) => k !== 'php' && !k.startsWith('ext-')).length,
    downloads: [monthly !== undefined ? `${fmtInt(monthly)} last month` : '', total !== undefined ? `${fmtInt(total)} total` : ''].filter(Boolean).join(', ') || undefined,
    maintainers: Array.isArray(pkg.maintainers) ? pkg.maintainers.length : undefined,
    deprecated: abandoned ? `abandoned${typeof abandoned === 'string' ? ` — use ${abandoned}` : ''}` : undefined,
  });
  info.versions = recent(all.map((x) => ({ v: clean(x.version), date: isoDate(x.time) })).filter((r) => r.v));
  return info;
};

/* ------------------------------------------------------------------ entry point */

const FETCHERS: Record<Ecosystem, Fetcher> = { npm, pypi, maven, crates, nuget, go, rubygems, packagist };

/** Registry summary for one package (latest or a given version). */
export async function packageInfo(http: HttpFetch, args: PackageInfoArgs, opts: ConnectorOpts = {}): Promise<ConnectorResult> {
  const eco = clean(args.ecosystem).toLowerCase() as Ecosystem;
  const name = clean(args.name);
  const fetcher = FETCHERS[eco];
  if (!fetcher) { throw new WebError(`packageInfo: unsupported ecosystem "${args.ecosystem}" (use ${Object.keys(FETCHERS).join(', ')})`, 'unsupported'); }
  if (!name) { throw new WebError('packageInfo: name is empty', 'unsupported'); }
  const i = await fetcher(http, name, clean(args.version) || undefined, opts.signal);
  const head = `${i.registry} · ${i.name}${i.version ? ` ${i.version}` : ''}`;
  const facts = [
    i.latest ? `Latest: ${i.latest}${i.version === i.latest && i.released ? ` (${i.released})` : ''}` : '',
    i.version && i.version !== i.latest ? `Shown: ${i.version}${i.released ? ` (${i.released})` : ''}` : '',
    i.license ? `License: ${i.license}` : '', i.deps !== undefined ? `Dependencies: ${i.deps}` : '',
    i.maintainers !== undefined ? `Maintainers: ${i.maintainers}` : '',
  ].filter(Boolean);
  const lines = [head, '', `**${i.name}**${i.description ? ` — ${excerpt(i.description, 400)}` : ''}`];
  if (facts.length) { lines.push(`- ${facts.join(' · ')}`); }
  if (i.downloads) { lines.push(`- Downloads: ${i.downloads}`); }
  if (i.deprecated) { lines.push(`- DEPRECATED: ${i.deprecated}`); }
  const links = [i.homepage ? `Homepage: ${i.homepage}` : '', i.repo && i.repo !== i.homepage ? `Repository: ${i.repo}` : '', `Registry: ${i.url}`].filter(Boolean);
  lines.push(`- ${links.join(' · ')}`);
  for (const n of i.notes) { lines.push(`- _${n}_`); }
  if (i.versions.length) {
    lines.push('', 'Recent versions:');
    for (const r of i.versions) { lines.push(`- ${r.v}${r.date ? ` — ${r.date}` : ''}${r.flag ? ` (${r.flag})` : ''}`); }
  }
  const sources: ConnectorSource[] = [source(`${i.name} on ${i.registry}`, i.url, i.released)];
  if (i.repo && /^https?:\/\//.test(i.repo)) { sources.push(source(`${i.name} repository`, i.repo)); }
  return result(head, lines, sources);
}
