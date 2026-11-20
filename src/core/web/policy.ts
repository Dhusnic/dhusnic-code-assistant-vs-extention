import { SecretVault } from '../redact';
import { hostMatches } from './ssrf';

/**
 * Who may be contacted on the internet, and how much. A URL is data leaving the machine: the path and query can carry
 * anything the model read, so new domains need the user's OK (unless they chose otherwise), and URLs or queries that
 * contain a secret are refused outright.
 */

export type WebApproval = 'new-domains' | 'always' | 'never';

export interface WebPolicy {
  enabled: boolean;
  /** Fetched without asking. Exact host or `*.suffix`. */
  allowedDomains: string[];
  /** Always ask, even after an approval or in Auto-execute. */
  askDomains: string[];
  /** Never contacted. Beats every other list. */
  blockedDomains: string[];
  /** When set (central policy), nothing outside these domains is contacted at all. */
  onlyDomains?: string[];
  /** Intranet hosts that may resolve to private addresses (internal docs, wikis). */
  allowPrivateHosts: string[];
  approval: WebApproval;
  allowDownloads: boolean;
  maxDownloadMB: number;
  searchDailyLimit: number;
  maxRequestsPerSession: number;
  offline: boolean;
  /** Regular expressions; a URL or query matching one is refused (internal code names, customer names…). */
  blockedQueryPatterns: string[];
}

/** The `web` section a central policy file may contain. Lists from the policy are added to the user's; flags win. */
export interface PolicyWeb {
  enabled?: boolean; allowedDomains?: string[]; askDomains?: string[]; blockedDomains?: string[]; onlyDomains?: string[];
  allowPrivateHosts?: string[]; approval?: WebApproval; allowDownloads?: boolean; maxDownloadMB?: number;
  searchDailyLimit?: number; maxRequestsPerSession?: number; offline?: boolean; blockedQueryPatterns?: string[];
}

/** Documentation, standards and research hosts that are read so often that asking each time is noise. */
export const DEFAULT_ALLOWED_DOMAINS = [
  'github.com', '*.github.com', 'raw.githubusercontent.com', '*.github.io', 'gitlab.com',
  'developer.mozilla.org', 'docs.python.org', 'nodejs.org', 'learn.microsoft.com', 'docs.microsoft.com',
  'stackoverflow.com', '*.stackexchange.com', '*.wikipedia.org', 'arxiv.org', 'export.arxiv.org',
  'www.npmjs.com', 'registry.npmjs.org', 'pypi.org', 'docs.rs', 'crates.io', 'pkg.go.dev', 'go.dev',
  'www.rfc-editor.org', 'datatracker.ietf.org', 'www.w3.org', 'html.spec.whatwg.org', 'doi.org',
  'api.semanticscholar.org', 'www.semanticscholar.org', 'api.osv.dev', 'osv.dev', 'nvd.nist.gov',
  'services.nvd.nist.gov', 'docs.oracle.com', 'kubernetes.io', 'docs.docker.com', 'www.typescriptlang.org',
];

export const WEB_APPROVALS: WebApproval[] = ['new-domains', 'always', 'never'];

const cleanList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim() && x.length <= 253).map((x) => x.trim().toLowerCase()) : []);
const posNum = (v: unknown, fallback: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, max) : fallback);

export interface WebSettingsInput {
  enabled?: unknown; approval?: unknown; allowedDomains?: unknown; askDomains?: unknown; blockedDomains?: unknown;
  allowPrivateHosts?: unknown; allowDownloads?: unknown; maxDownloadMB?: unknown; searchDailyLimit?: unknown;
  maxRequestsPerSession?: unknown; offline?: unknown; blockedQueryPatterns?: unknown;
}

/** Builds the effective policy from the user's settings and the central policy (which can only tighten or extend). */
export function resolveWebPolicy(settings: WebSettingsInput, central?: PolicyWeb): WebPolicy {
  const p: WebPolicy = {
    enabled: settings.enabled !== false,
    allowedDomains: settings.allowedDomains === undefined ? [...DEFAULT_ALLOWED_DOMAINS] : cleanList(settings.allowedDomains),
    askDomains: cleanList(settings.askDomains),
    blockedDomains: cleanList(settings.blockedDomains),
    allowPrivateHosts: cleanList(settings.allowPrivateHosts),
    approval: WEB_APPROVALS.includes(settings.approval as WebApproval) ? settings.approval as WebApproval : 'new-domains',
    allowDownloads: settings.allowDownloads !== false,
    maxDownloadMB: posNum(settings.maxDownloadMB, 50, 2048),
    searchDailyLimit: posNum(settings.searchDailyLimit, 200, 100_000),
    maxRequestsPerSession: posNum(settings.maxRequestsPerSession, 400, 100_000),
    offline: settings.offline === true,
    blockedQueryPatterns: cleanPatterns(settings.blockedQueryPatterns),
  };
  if (!central) { return p; }
  if (central.enabled === false) { p.enabled = false; }
  if (central.offline === true) { p.offline = true; }
  if (central.allowDownloads === false) { p.allowDownloads = false; }
  if (central.approval && WEB_APPROVALS.includes(central.approval)) { p.approval = central.approval; }
  p.blockedDomains = [...new Set([...p.blockedDomains, ...cleanList(central.blockedDomains)])];
  p.askDomains = [...new Set([...p.askDomains, ...cleanList(central.askDomains)])];
  p.allowedDomains = [...new Set([...p.allowedDomains, ...cleanList(central.allowedDomains)])];
  p.allowPrivateHosts = [...new Set([...p.allowPrivateHosts, ...cleanList(central.allowPrivateHosts)])];
  p.blockedQueryPatterns = [...new Set([...p.blockedQueryPatterns, ...cleanPatterns(central.blockedQueryPatterns)])];
  if (central.onlyDomains !== undefined) { p.onlyDomains = cleanList(central.onlyDomains); }
  if (central.maxDownloadMB !== undefined) { p.maxDownloadMB = Math.min(p.maxDownloadMB, posNum(central.maxDownloadMB, p.maxDownloadMB, 2048)); }
  if (central.searchDailyLimit !== undefined) { p.searchDailyLimit = Math.min(p.searchDailyLimit, posNum(central.searchDailyLimit, p.searchDailyLimit, 100_000)); }
  if (central.maxRequestsPerSession !== undefined) { p.maxRequestsPerSession = Math.min(p.maxRequestsPerSession, posNum(central.maxRequestsPerSession, p.maxRequestsPerSession, 100_000)); }
  return p;
}

/** Keeps only patterns that compile, so one typo cannot break every request. */
function cleanPatterns(v: unknown): string[] {
  return (Array.isArray(v) ? v : []).filter((x): x is string => {
    if (typeof x !== 'string' || !x.trim() || x.length > 500) { return false; }
    try { new RegExp(x, 'i'); return true; } catch { return false; }
  });
}

/** Validates the `web` section of a central policy file; invalid fields fail closed. */
export function validatePolicyWeb(raw: unknown, errors: string[]): PolicyWeb {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push('web must be an object; web access is disabled'); return { enabled: false }; }
  const r = raw as Record<string, unknown>;
  const out: PolicyWeb = {};
  for (const key of ['enabled', 'allowDownloads', 'offline'] as const) {
    if (r[key] === undefined) { continue; }
    if (typeof r[key] === 'boolean') { out[key] = r[key] as boolean; continue; }
    errors.push(`web.${key} must be true or false`);
    out[key] = key === 'offline';
  }
  for (const key of ['allowedDomains', 'askDomains', 'blockedDomains', 'onlyDomains', 'allowPrivateHosts', 'blockedQueryPatterns'] as const) {
    if (r[key] === undefined) { continue; }
    if (!Array.isArray(r[key])) {
      errors.push(`web.${key} must be a list`);
      if (key === 'onlyDomains') { out.onlyDomains = []; }
      if (key === 'blockedDomains') { out.blockedDomains = ['*']; }
      continue;
    }
    out[key] = cleanList(r[key]);
  }
  if (out.blockedQueryPatterns) { out.blockedQueryPatterns = cleanPatterns(r.blockedQueryPatterns); }
  if (r.approval !== undefined) {
    if (WEB_APPROVALS.includes(r.approval as WebApproval)) { out.approval = r.approval as WebApproval; } else { errors.push('web.approval must be new-domains, always or never'); out.approval = 'always'; }
  }
  for (const key of ['maxDownloadMB', 'searchDailyLimit', 'maxRequestsPerSession'] as const) {
    if (r[key] === undefined) { continue; }
    if (typeof r[key] === 'number' && (r[key] as number) > 0) { out[key] = r[key] as number; } else { errors.push(`web.${key} must be a positive number`); out[key] = 1; }
  }
  return out;
}

/* ------------------------------------------------------------------ decisions */

const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'com.br', 'com.cn', 'com.sg', 'com.hk', 'co.nz', 'co.za', 'com.mx', 'com.tr',
  'co.kr', 'co.il', 'com.ar', 'com.my', 'com.ph', 'com.tw', 'github.io', 'gitlab.io', 'pages.dev', 'netlify.app', 'vercel.app',
  'herokuapp.com', 'azurewebsites.net', 'cloudfront.net', 'blogspot.com', 'readthedocs.io', 'web.app', 'firebaseapp.com',
]);

/** The domain an approval covers: approving docs.example.com also covers api.example.com, but not every *.github.io site. */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (/^[\d.]+$/.test(h) || h.includes(':')) { return h; }
  const parts = h.split('.');
  if (parts.length <= 2) { return h; }
  const last2 = parts.slice(-2).join('.');
  return MULTI_PART_SUFFIXES.has(last2) ? parts.slice(-3).join('.') : last2;
}

export interface WebDecision { effect: 'allow' | 'ask' | 'deny'; reason: string }

function hostOf(url: string): string | undefined {
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase().replace(/^\[|\]$/g, '') : undefined; } catch { return undefined; }
}

/**
 * Whether a request to `url` may go out. `approved` holds the sites the user allowed in this session;
 * `fixedApi` marks requests the tools make to a well-known API (search, arXiv, GitHub…), which never need an approval.
 */
export function webDecision(url: string, policy: WebPolicy, opts: { approved?: Set<string>; mode?: string; fixedApi?: boolean } = {}): WebDecision {
  if (!policy.enabled) { return { effect: 'deny', reason: 'web access is turned off (Infraon Assistant › Web: Enabled, or your organization policy)' }; }
  const host = hostOf(url);
  if (!host) { return { effect: 'deny', reason: 'not a valid http(s) URL' }; }
  if (hostMatches(host, policy.blockedDomains) || policy.blockedDomains.includes('*')) { return { effect: 'deny', reason: `${host} is on the blocked domain list` }; }
  if (policy.onlyDomains && !hostMatches(host, policy.onlyDomains)) { return { effect: 'deny', reason: `your organization only allows these domains: ${policy.onlyDomains.slice(0, 8).join(', ')}${policy.onlyDomains.length > 8 ? '…' : ''}` }; }
  const leak = outboundProblem(url, policy);
  if (leak) { return { effect: 'deny', reason: leak }; }
  if (hostMatches(host, policy.askDomains)) { return { effect: 'ask', reason: `${host} is on the ask-first domain list` }; }
  if (opts.fixedApi || hostMatches(host, policy.allowedDomains)) { return { effect: 'allow', reason: 'allowed domain' }; }
  if (policy.approval === 'never') { return { effect: 'allow', reason: 'web approval is off' }; }
  if (policy.approval === 'always') { return { effect: 'ask', reason: 'every web request needs approval (Web: Approval = always)' }; }
  if (opts.approved?.has(siteOf(host))) { return { effect: 'allow', reason: `${siteOf(host)} was approved earlier in this session` }; }
  if (opts.mode === 'auto') { return { effect: 'allow', reason: 'Auto-execute' }; }
  return { effect: 'ask', reason: `first request to ${siteOf(host)} in this session` };
}

/**
 * Why text must not leave the machine, or undefined. Checks the same secret detectors that mask the LLM traffic,
 * plus the blocked patterns: a URL like https://evil.example/?k=<token> is the classic exfiltration channel.
 */
export function outboundProblem(text: string, policy: Pick<WebPolicy, 'blockedQueryPatterns'>): string | undefined {
  let decoded = text;
  try { decoded = decodeURIComponent(text.replace(/\+/g, ' ')); } catch { /* keep raw */ }
  for (const t of new Set([text, decoded])) {
    const r = new SecretVault().redact(t);
    if (r.count > 0) { return `it contains what looks like a secret (${r.kinds.join(', ')}); secrets never leave this machine`; }
    for (const p of policy.blockedQueryPatterns) {
      if (new RegExp(p, 'i').test(t)) { return `it matches a blocked pattern (${p}) from your web settings or organization policy`; }
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ quotas */

/** Per-session request budget and a per-day search budget (kept by the host across sessions). */
export class WebQuota {
  private requests = 0;
  constructor(private policy: () => WebPolicy, private daily: { get(): { day: string; count: number }; set(v: { day: string; count: number }): void }, private today = () => new Date().toISOString().slice(0, 10)) {}

  /** An error message when the budget is spent, else undefined (and the request is counted). */
  take(kind: 'request' | 'search'): string | undefined {
    const p = this.policy();
    if (this.requests >= p.maxRequestsPerSession) { return `this session used its ${p.maxRequestsPerSession} web requests (Web: Max Requests Per Session). Start a new session or raise the limit.`; }
    if (kind === 'search') {
      const d = this.daily.get();
      const cur = d.day === this.today() ? d : { day: this.today(), count: 0 };
      if (cur.count >= p.searchDailyLimit) { return `the daily web search limit (${p.searchDailyLimit}) is used up (Web: Search Daily Limit). It resets at midnight UTC.`; }
      this.daily.set({ day: cur.day, count: cur.count + 1 });
    }
    this.requests++;
    return undefined;
  }

  get used(): number { return this.requests; }
}
