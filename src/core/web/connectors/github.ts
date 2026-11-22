/**
 * GitHub REST lookups (repo health, releases, issues, README/file contents, commits, star comparison).
 * Works without a token (60 requests/hour); a token from SecretStorage raises that to 5 000 and
 * unlocks private repositories the token can see.
 */
import { ConnectorResult, ConnectorSource, FetchResponse, HttpFetch, WebError } from '../types';
import { ConnectorOpts, arr, cell, clampInt, clean, excerpt, fmtInt, httpError, isoDate, num, parseJson, result, source, stripTags } from './util';

export type GithubAction = 'repo' | 'search_repos' | 'releases' | 'issues' | 'search_issues' | 'readme' | 'file' | 'commits' | 'compare_stars';

export interface GithubLookupArgs {
  action: GithubAction;
  /** "owner/name" or any github.com URL inside the repository. */
  repo?: string;
  query?: string;
  path?: string;
  ref?: string;
  state?: 'open' | 'closed' | 'all';
  limit?: number;
  repos?: string[];
}

const API = 'https://api.github.com';
/** README/file contents can be long and are the point of the call, so they get a larger cap. */
const MAX_FILE_CHARS = 60_000;

/** "https://github.com/o/r/tree/main/x" / "o/r.git" → "o/r". */
export function parseRepo(raw: string): string {
  const s = clean(raw).replace(/^git\+/, '').replace(/^git@github\.com:/i, 'https://github.com/');
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(s);
  if (!m || m[1].toLowerCase() === 'api.github.com') { throw new WebError(`GitHub: "${raw}" is not an owner/name repository`, 'unsupported'); }
  return `${m[1]}/${m[2]}`;
}

interface Gh { get(path: string, allow404?: boolean): Promise<any | undefined> }

function client(http: HttpFetch, token: string | undefined, signal?: AbortSignal): Gh {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) { headers.Authorization = `Bearer ${token}`; }
  return {
    async get(path, allow404 = false) {
      const res = await http(`${API}${path}`, { headers, signal });
      if (allow404 && res.status === 404) { return undefined; }
      throwIfError(res, !!token);
      return parseJson('GitHub', res);
    },
  };
}

function throwIfError(res: FetchResponse, hasToken: boolean): void {
  if (res.status < 400) { return; }
  const remaining = res.headers['x-ratelimit-remaining'];
  if ((res.status === 403 || res.status === 429) && (remaining === '0' || res.headers['retry-after'])) {
    const reset = num(res.headers['x-ratelimit-reset']);
    const when = reset ? new Date(reset * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : res.headers['retry-after'] ? `in ${res.headers['retry-after']} s` : 'later';
    throw new WebError(`GitHub: API rate limit exhausted; it resets at ${when}.${hasToken ? '' : ' Store a GitHub token to raise the limit from 60 to 5 000 requests per hour.'}`, 'rate_limited', res.status);
  }
  throw httpError('GitHub', res, {
    auth: hasToken ? 'access denied — the GitHub token is invalid, expired or lacks access' : 'access denied — this needs a GitHub token',
    notFound: hasToken ? 'not found' : 'not found (or private — store a GitHub token to see private repositories)',
  });
}

const ghSource = (title: string, url: string, published?: string): ConnectorSource => source(title, url, published);

/** Decodes a contents-API payload; binary files are reported, not dumped. */
function decodeContent(c: any): { text?: string; note?: string } {
  if (clean(c?.encoding) !== 'base64' || typeof c?.content !== 'string') {
    return { note: c?.size > 1_000_000 ? `File is ${fmtInt(c.size)} bytes — too large for the contents API; download it from ${clean(c?.download_url)}` : 'File content not available through the API.' };
  }
  const buf = Buffer.from(c.content.replace(/\s+/g, ''), 'base64');
  const sample = buf.subarray(0, 8000);
  const ctrl = [...sample].filter((b) => b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13)).length;
  if (sample.includes(0) || ctrl > sample.length * 0.1) { return { note: `Binary file (${fmtInt(buf.length)} bytes); not shown.` }; }
  return { text: buf.toString('utf8') };
}

const repoRow = (r: any): string => {
  const flags = [r?.archived ? 'ARCHIVED' : '', r?.fork ? 'fork' : '', r?.private ? 'private' : ''].filter(Boolean).join(', ');
  return `${fmtInt(num(r?.stargazers_count) ?? 0)} stars · ${fmtInt(num(r?.forks_count) ?? 0)} forks · ${clean(r?.language) || 'n/a'} · pushed ${isoDate(r?.pushed_at) ?? '?'}${flags ? ` · ${flags}` : ''}`;
};

/** GitHub lookups; see GithubAction for what each action returns. */
export async function githubLookup(http: HttpFetch, args: GithubLookupArgs, opts: ConnectorOpts = {}): Promise<ConnectorResult> {
  let token: string | undefined;
  try { token = clean(await opts.keys?.('github')) || undefined; } catch { token = undefined; }
  const gh = client(http, token, opts.signal);
  const limit = clampInt(args.limit, 10, 1, 100);
  const needRepo = (): string => { if (!args.repo) { throw new WebError(`GitHub: action "${args.action}" needs repo`, 'unsupported'); } return parseRepo(args.repo); };
  const refQ = args.ref ? `ref=${encodeURIComponent(args.ref)}` : '';

  switch (args.action) {
    case 'repo': {
      const r = needRepo();
      const [d, rel] = await Promise.all([gh.get(`/repos/${r}`), gh.get(`/repos/${r}/releases/latest`, true)]);
      const head = `GitHub · ${clean(d.full_name) || r}`;
      const lines = [head, '', `**${clean(d.full_name) || r}**${d.description ? ` — ${stripTags(d.description)}` : ''}`,
        `- ${fmtInt(num(d.stargazers_count) ?? 0)} stars · ${fmtInt(num(d.forks_count) ?? 0)} forks · ${fmtInt(num(d.open_issues_count) ?? 0)} open issues+PRs · ${fmtInt(num(d.subscribers_count) ?? num(d.watchers_count) ?? 0)} watchers`,
        `- Language: ${clean(d.language) || 'n/a'} · License: ${clean(d.license?.spdx_id) && d.license.spdx_id !== 'NOASSERTION' ? clean(d.license.spdx_id) : clean(d.license?.name) || 'none'} · Default branch: ${clean(d.default_branch) || '?'}`,
        `- Created ${isoDate(d.created_at) ?? '?'} · Last push ${isoDate(d.pushed_at) ?? '?'}${d.archived ? ' · ARCHIVED (read-only)' : ''}${d.fork ? ` · fork of ${clean(d.parent?.full_name) || '?'}` : ''}`];
      if (arr(d.topics).length) { lines.push(`- Topics: ${arr(d.topics).map(clean).join(', ')}`); }
      if (clean(d.homepage)) { lines.push(`- Homepage: ${clean(d.homepage)}`); }
      lines.push(rel ? `- Latest release: ${clean(rel.tag_name)}${rel.name && rel.name !== rel.tag_name ? ` “${clean(rel.name)}”` : ''} (${isoDate(rel.published_at) ?? '?'}) ${clean(rel.html_url)}` : '- No published releases.');
      lines.push(`- ${clean(d.html_url) || `https://github.com/${r}`}`);
      return result(head, lines, [ghSource(clean(d.full_name) || r, clean(d.html_url) || `https://github.com/${r}`, isoDate(d.pushed_at))]);
    }
    case 'search_repos': {
      const q = clean(args.query);
      if (!q) { throw new WebError('GitHub: search_repos needs query', 'unsupported'); }
      const d = await gh.get(`/search/repositories?q=${encodeURIComponent(q)}&per_page=${limit}`);
      const items = arr(d.items);
      const head = `GitHub · ${items.length} of ${fmtInt(num(d.total_count) ?? items.length)} repositories for “${q}”`;
      const lines = [head, ''];
      items.forEach((r, i) => lines.push(`${i + 1}. **${clean(r?.full_name)}** — ${excerpt(r?.description, 200) || 'no description'}`, `   ${repoRow(r)} · ${clean(r?.html_url)}`));
      return result(head, lines, items.map((r) => ghSource(clean(r?.full_name), clean(r?.html_url), isoDate(r?.pushed_at))));
    }
    case 'releases': {
      const r = needRepo();
      const items = arr(await gh.get(`/repos/${r}/releases?per_page=${limit}`));
      const head = `GitHub · ${items.length} releases of ${r}`;
      const lines = [head, ''];
      if (!items.length) { lines.push('No releases published (the project may only use tags).'); }
      items.forEach((x, i) => {
        lines.push(`${i + 1}. **${clean(x?.tag_name)}**${x?.name && x.name !== x.tag_name ? ` “${clean(x.name)}”` : ''} — ${isoDate(x?.published_at) ?? 'unpublished'}${x?.prerelease ? ' · pre-release' : ''}${x?.draft ? ' · draft' : ''} · ${clean(x?.html_url)}`);
        const body = String(x?.body ?? '').replace(/\r/g, '').trim();
        if (body) { lines.push(...(body.length > 600 ? `${body.slice(0, 600)}…` : body).split('\n').map((l) => `   ${l}`)); }
      });
      return result(head, lines, items.map((x) => ghSource(`${r} ${clean(x?.tag_name)}`, clean(x?.html_url), isoDate(x?.published_at))));
    }
    case 'issues':
    case 'search_issues': {
      const state = args.state ?? 'open';
      let items: any[], head: string;
      if (args.action === 'issues') {
        const r = needRepo();
        items = arr(await gh.get(`/repos/${r}/issues?state=${state}&per_page=${limit}&sort=updated`));
        head = `GitHub · ${items.length} ${state === 'all' ? '' : `${state} `}issues/PRs in ${r}`;
      } else {
        const q = clean(args.query);
        if (!q && !args.repo) { throw new WebError('GitHub: search_issues needs query or repo', 'unsupported'); }
        const parts = [args.repo ? `repo:${parseRepo(args.repo)}` : '', q, state !== 'all' ? `state:${state}` : ''].filter(Boolean);
        const d = await gh.get(`/search/issues?q=${encodeURIComponent(parts.join(' '))}&per_page=${limit}`);
        items = arr(d.items);
        head = `GitHub · ${items.length} of ${fmtInt(num(d.total_count) ?? items.length)} issues/PRs for “${parts.join(' ')}”`;
      }
      const lines = [head, ''];
      items.forEach((x, i) => {
        const labels = arr(x?.labels).map((l) => clean(typeof l === 'string' ? l : l?.name)).filter(Boolean);
        lines.push(`${i + 1}. **#${clean(x?.number)} ${stripTags(x?.title)}** — ${x?.pull_request ? 'PR' : 'issue'}, ${clean(x?.state)}${labels.length ? ` · [${labels.join(', ')}]` : ''} · ${fmtInt(num(x?.comments) ?? 0)} comments · created ${isoDate(x?.created_at) ?? '?'} · updated ${isoDate(x?.updated_at) ?? '?'}`, `   ${clean(x?.html_url)}`);
      });
      return result(head, lines, items.map((x) => ghSource(`#${clean(x?.number)} ${stripTags(x?.title)}`, clean(x?.html_url), isoDate(x?.created_at))));
    }
    case 'readme':
    case 'file': {
      const r = needRepo();
      const path = clean(args.path).replace(/^\/+/, '');
      if (args.action === 'file' && !path) { throw new WebError('GitHub: file needs path', 'unsupported'); }
      const url = args.action === 'readme' ? `/repos/${r}/readme${refQ ? `?${refQ}` : ''}` : `/repos/${r}/contents/${path.split('/').map(encodeURIComponent).join('/')}${refQ ? `?${refQ}` : ''}`;
      const d = await gh.get(url);
      if (Array.isArray(d)) {
        const head = `GitHub · ${r}/${path} (directory, ${d.length} entries)`;
        const lines = [head, '', ...d.map((e) => `- ${clean(e?.type) === 'dir' ? `${clean(e?.name)}/` : clean(e?.name)}${num(e?.size) ? ` (${fmtInt(e.size)} B)` : ''}`)];
        return result(head, lines, [ghSource(`${r}/${path}`, `https://github.com/${r}/tree/${args.ref ?? 'HEAD'}/${path}`)]);
      }
      const { text, note } = decodeContent(d);
      const head = `GitHub · ${r}/${clean(d.path) || path}${args.ref ? ` @ ${args.ref}` : ''}`;
      const lines = [head, clean(d.html_url), ''];
      lines.push(text ?? note ?? '');
      return result(head, lines, [ghSource(`${r}/${clean(d.path) || path}`, clean(d.html_url) || `https://github.com/${r}`)], MAX_FILE_CHARS);
    }
    case 'commits': {
      const r = needRepo();
      const q = [`per_page=${limit}`, args.ref ? `sha=${encodeURIComponent(args.ref)}` : '', args.path ? `path=${encodeURIComponent(args.path)}` : ''].filter(Boolean).join('&');
      const items = arr(await gh.get(`/repos/${r}/commits?${q}`));
      const head = `GitHub · ${items.length} recent commits in ${r}${args.ref ? ` (${args.ref})` : ''}${args.path ? ` touching ${args.path}` : ''}`;
      const lines = [head, ''];
      items.forEach((c) => {
        const msg = String(c?.commit?.message ?? '').split('\n')[0].trim();
        lines.push(`- \`${clean(c?.sha).slice(0, 7)}\` ${isoDate(c?.commit?.author?.date) ?? '?'} ${clean(c?.author?.login) || clean(c?.commit?.author?.name) || '?'}: ${msg} ${clean(c?.html_url)}`);
      });
      return result(head, lines, items.slice(0, 20).map((c) => ghSource(`${r}@${clean(c?.sha).slice(0, 7)}`, clean(c?.html_url), isoDate(c?.commit?.author?.date))));
    }
    case 'compare_stars': {
      const list = [...new Set((args.repos?.length ? args.repos : args.repo ? [args.repo] : []).map(parseRepo))].slice(0, 20);
      if (list.length < 1) { throw new WebError('GitHub: compare_stars needs repos', 'unsupported'); }
      const rows = await Promise.all(list.map((r) => gh.get(`/repos/${r}`, true).then((d) => ({ r, d }))));
      rows.sort((a, b) => (num(b.d?.stargazers_count) ?? -1) - (num(a.d?.stargazers_count) ?? -1));
      const head = `GitHub · comparing ${list.length} repositories`;
      const lines = [head, '', '| Repository | Stars | Forks | Open issues | Last push | License | Archived |', '|---|---:|---:|---:|---|---|---|'];
      for (const { r, d } of rows) {
        if (!d) { lines.push(`| ${cell(r)} | not found | | | | | |`); continue; }
        lines.push(`| [${cell(clean(d.full_name))}](${clean(d.html_url)}) | ${fmtInt(num(d.stargazers_count) ?? 0)} | ${fmtInt(num(d.forks_count) ?? 0)} | ${fmtInt(num(d.open_issues_count) ?? 0)} | ${isoDate(d.pushed_at) ?? '?'} | ${cell(clean(d.license?.spdx_id) || 'none')} | ${d.archived ? 'yes' : 'no'} |`);
      }
      return result(head, lines, rows.filter((x) => x.d).map(({ d }) => ghSource(clean(d.full_name), clean(d.html_url), isoDate(d.pushed_at))));
    }
    default:
      throw new WebError(`GitHub: unknown action "${String(args.action)}"`, 'unsupported');
  }
}
