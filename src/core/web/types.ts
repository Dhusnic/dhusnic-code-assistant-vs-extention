/**
 * Shared contracts of the web subsystem (internet access for the agent).
 *
 * Layout (src/core/web):
 *   types.ts        these contracts
 *   ssrf.ts         URL validation and private-address blocking
 *   net.ts          HTTP client: redirects, decompression, proxy, size/time limits, per-host rate limit
 *   cache.ts        disk cache + snapshot archive (ETag revalidation, LRU eviction, per-URL history)
 *   extract/*       content → Markdown (HTML, PDF, Office, feeds, JSON, CSV, images) + injection defence
 *   search.ts       web search providers (SearXNG, Brave, Tavily, Bing, Google CSE, DuckDuckGo)
 *   connectors.ts   R&D sources (arXiv, Semantic Scholar, PubMed, Crossref, GitHub, npm/PyPI/…, OSV/NVD, HN, SO, Wikipedia, RFC)
 *   policy.ts       domain allow/ask/deny, quotas, central-policy merge
 *   sources.ts      per-session source registry, citations, credibility
 *   library.ts      offline full-text (BM25) search over everything fetched before
 *   tools.ts        the agent tools built from all of the above
 *
 * Everything is dependency-free (Node built-ins only) so the extension installs on locked-down machines.
 */

/* ------------------------------------------------------------------ errors */

export type WebErrorCode =
  | 'invalid_url' | 'blocked' | 'policy' | 'timeout' | 'too_large' | 'http' | 'network'
  | 'aborted' | 'unsupported' | 'rate_limited' | 'not_configured' | 'parse';

export class WebError extends Error {
  constructor(message: string, readonly code: WebErrorCode, readonly status?: number) {
    super(message);
    this.name = 'WebError';
  }
}

/* ------------------------------------------------------------------ HTTP */

export interface FetchOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Whole request including redirects and body download. Default 30 000 ms. */
  timeoutMs?: number;
  /** Decompressed body cap. Default 10 MiB. Bigger bodies are cut off and `truncated` is set (never an error). */
  maxBytes?: number;
  /** Default 5. */
  maxRedirects?: number;
  signal?: AbortSignal;
  /** Host names (exact, or `*.corp.example` wildcards) allowed although they resolve to private addresses. */
  allowPrivateHosts?: string[];
  /** Disables every private-address check. Tests only. */
  allowPrivateAll?: boolean;
}

export interface FetchResponse {
  /** Final URL after redirects. */
  url: string;
  status: number;
  /** Lower-cased names; repeated headers joined with ", ". */
  headers: Record<string, string>;
  /** Decompressed body. */
  body: Buffer;
  /** MIME type, lower-cased, without parameters ("text/html"). Empty when the server sent none. */
  contentType: string;
  charset?: string;
  /** The body reached maxBytes and was cut off. */
  truncated: boolean;
  /** Every URL redirected through, in order (not including the final one). */
  redirects: string[];
  ms: number;
}

export type HttpFetch = (url: string, opts?: FetchOptions) => Promise<FetchResponse>;

export interface NetConfig {
  /** Sent as User-Agent. Generic; never contains user data. */
  userAgent: string;
  /** Explicit proxy "http://host:port" (optionally with user:pass). Empty: direct (VS Code's own proxy support still applies). */
  proxy?: string;
  /** Hosts that bypass the explicit proxy (exact or *.suffix). */
  noProxy?: string[];
  /** Accept self-signed certificates. Default false. */
  allowSelfSigned?: boolean;
  /** Extra PEM CA certificates (corporate TLS inspection). */
  extraCaPem?: string;
  /** Requests per second per host. Default 4. */
  perHostRps?: number;
}

/* ------------------------------------------------------------------ cache */

export interface CacheEntry {
  /** The requested URL (cache key source). */
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  charset?: string;
  etag?: string;
  lastModified?: string;
  fetchedAt: number;
  sha256: string;
  size: number;
  truncated?: boolean;
}

export interface Snapshot { sha256: string; fetchedAt: number; size: number }

/* ------------------------------------------------------------------ extraction */

export type DocKind =
  | 'html' | 'pdf' | 'json' | 'xml' | 'feed' | 'text' | 'markdown' | 'csv' | 'image'
  | 'docx' | 'xlsx' | 'pptx' | 'binary';

export interface DocLink { text: string; url: string }
export interface DocImage { url: string; alt?: string; width?: number; height?: number }

export interface ExtractedDoc {
  kind: DocKind;
  title?: string;
  description?: string;
  author?: string;
  /** ISO date when the document states one. */
  published?: string;
  siteName?: string;
  canonicalUrl?: string;
  lang?: string;
  /** Main content as Markdown (or plain text). PDF/PPTX pages are separated by "\n\n<!-- page N -->\n\n". */
  markdown: string;
  /** Absolute http(s) URLs only, de-duplicated, document order. */
  links: DocLink[];
  images: DocImage[];
  /** PDF / PPTX page or slide count; XLSX sheet count. */
  pages?: number;
  /** For kind "image". */
  image?: { format: string; width?: number; height?: number };
  /** Human-readable notes: hidden text removed, suspected prompt injection, scanned PDF without text, truncated… */
  warnings: string[];
}

/** Input of the extractors: a fetched (or cached) response. */
export interface RawDoc { url: string; body: Buffer; contentType: string; charset?: string }

/* ------------------------------------------------------------------ search */

export interface SearchQuery {
  query: string;
  /** Default 8, max 20. */
  count?: number;
  /** Restrict to these domains. */
  sites?: string[];
  excludeSites?: string[];
  freshness?: 'day' | 'week' | 'month' | 'year';
  /** e.g. "en-US", "de-DE". */
  region?: string;
  /** e.g. "pdf". */
  fileType?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** ISO date when the provider gives one. */
  published?: string;
  /** Provider id that returned it. */
  provider?: string;
}

export type SearchProviderId = 'searxng' | 'brave' | 'tavily' | 'bing' | 'google' | 'duckduckgo';

export interface SearchConfig {
  /** 'auto' = first configured provider (a key or URL is set), else duckduckgo. */
  provider: 'auto' | SearchProviderId;
  searxngUrl?: string;
  /** Google Programmable Search engine id. */
  googleCx?: string;
}

/** Reads an API key from VS Code SecretStorage (never from settings files). */
export type KeyLookup = (provider: SearchProviderId | 'github' | 'nvd' | 'semanticscholar') => Promise<string | undefined>;

/* ------------------------------------------------------------------ sources & connectors */

export type SourceKind =
  | 'official-docs' | 'standard' | 'academic' | 'government' | 'code-repo' | 'package-registry'
  | 'security-advisory' | 'vendor' | 'news' | 'forum' | 'blog' | 'reference' | 'unknown';

export type Credibility = 'high' | 'medium' | 'low';

export interface ConnectorSource { title: string; url: string; kind?: SourceKind; published?: string }

/** What every R&D connector returns: compact Markdown for the model, plus the sources it drew on. */
export interface ConnectorResult { title: string; markdown: string; sources: ConnectorSource[] }

/* ------------------------------------------------------------------ helpers shared by every module */

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 5;

/** Trims text to `max` characters on a line boundary when possible, saying how much was cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) { return text; }
  const cut = text.lastIndexOf('\n', max);
  const end = cut > max * 0.8 ? cut : max;
  return `${text.slice(0, end)}\n… [${text.length - end} more characters]`;
}
