/**
 * URL → SourceKind, used to tag connector and search sources so citations can show what kind of
 * source a claim rests on. Rules are ordered: more specific ones (advisories on github.com, PubMed on
 * a .gov host) win over generic ones.
 */
import { SourceKind } from '../types';

/** True when `host` is `domain` or a subdomain of it. */
const under = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);
const anyUnder = (host: string, domains: string[]): boolean => domains.some((d) => under(host, d));

const ADVISORY = ['osv.dev', 'nvd.nist.gov', 'cve.org', 'cve.mitre.org', 'cvedetails.com', 'security.snyk.io', 'snyk.io', 'msrc.microsoft.com', 'cisa.gov', 'cert.org', 'kb.cert.org', 'rustsec.org'];
const ACADEMIC = [
  'arxiv.org', 'doi.org', 'dx.doi.org', 'semanticscholar.org', 'pubmed.ncbi.nlm.nih.gov', 'ieeexplore.ieee.org', 'dl.acm.org',
  'acm.org', 'springer.com', 'link.springer.com', 'nature.com', 'sciencedirect.com', 'openalex.org', 'crossref.org',
  'biorxiv.org', 'medrxiv.org', 'jstor.org', 'wiley.com', 'onlinelibrary.wiley.com', 'plos.org', 'ssrn.com', 'researchgate.net',
  'scholar.google.com', 'aclanthology.org', 'openreview.net', 'proceedings.neurips.cc', 'proceedings.mlr.press', 'sciencemag.org',
  'science.org', 'cell.com', 'tandfonline.com', 'mdpi.com', 'frontiersin.org', 'europepmc.org', 'paperswithcode.com', 'usenix.org',
];
const REGISTRY = [
  'npmjs.com', 'npmjs.org', 'pypi.org', 'search.maven.org', 'central.sonatype.com', 'mvnrepository.com', 'repo1.maven.org',
  'crates.io', 'nuget.org', 'pkg.go.dev', 'proxy.golang.org', 'rubygems.org', 'packagist.org', 'hex.pm', 'pub.dev', 'cocoapods.org',
  'anaconda.org', 'hub.docker.com',
];
const CODE = ['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'sourceforge.net', 'sr.ht', 'githubusercontent.com', 'gitee.com'];
const STANDARD = ['ietf.org', 'rfc-editor.org', 'w3.org', 'whatwg.org', 'iso.org', 'ecma-international.org', 'tc39.es', 'unicode.org', 'standards.ieee.org', 'iana.org', 'oasis-open.org', 'etsi.org', 'itu.int', 'khronos.org'];
const FORUM = ['stackoverflow.com', 'stackexchange.com', 'serverfault.com', 'superuser.com', 'askubuntu.com', 'reddit.com', 'news.ycombinator.com', 'lobste.rs', 'quora.com', 'discourse.org'];
const REFERENCE = ['wikipedia.org', 'wiktionary.org', 'wikidata.org', 'britannica.com'];
const DOCS = [
  'developer.mozilla.org', 'learn.microsoft.com', 'docs.microsoft.com', 'docs.python.org', 'nodejs.org', 'readthedocs.io',
  'readthedocs.org', 'docs.rs', 'developer.apple.com', 'developer.android.com', 'go.dev', 'doc.rust-lang.org', 'typescriptlang.org',
  'react.dev', 'kubernetes.io', 'cppreference.com', 'devdocs.io', 'php.net', 'postgresql.org', 'docs.oracle.com',
];
const BLOG = ['medium.com', 'dev.to', 'substack.com', 'hashnode.dev', 'hashnode.com', 'blogspot.com', 'wordpress.com', 'ghost.io', 'tumblr.com', 'hackernoon.com'];
const NEWS = [
  'nytimes.com', 'bbc.com', 'bbc.co.uk', 'reuters.com', 'theguardian.com', 'wsj.com', 'bloomberg.com', 'cnn.com', 'apnews.com',
  'washingtonpost.com', 'ft.com', 'techcrunch.com', 'theverge.com', 'arstechnica.com', 'wired.com', 'zdnet.com', 'theregister.com',
  'venturebeat.com', 'engadget.com', 'cnbc.com', 'forbes.com', 'economist.com', 'aljazeera.com', 'npr.org', 'axios.com',
  'thehindu.com', 'ndtv.com', 'indiatimes.com', 'hindustantimes.com', 'economictimes.indiatimes.com', 'lwn.net', 'infoq.com',
  'bleepingcomputer.com', 'thehackernews.com', 'politico.com', 'nbcnews.com', 'cbsnews.com', 'abcnews.go.com', 'usatoday.com',
];

export function classifyUrlKind(url: string): SourceKind {
  let u: URL;
  try { u = new URL(url); } catch { return 'unknown'; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.toLowerCase();
  if (anyUnder(host, ADVISORY) || (host === 'github.com' && path.startsWith('/advisories'))) { return 'security-advisory'; }
  if (anyUnder(host, ACADEMIC) || (under(host, 'ncbi.nlm.nih.gov') && path.startsWith('/pmc'))) { return 'academic'; }
  // docs.github.com, docs.gitlab.com, developer.hashicorp.com…: documentation even on code-host domains.
  if (/^(docs|doc|developer|developers|devdocs)\./.test(host) && !anyUnder(host, REGISTRY)) { return 'official-docs'; }
  if (anyUnder(host, REGISTRY)) { return 'package-registry'; }
  if (anyUnder(host, CODE)) { return 'code-repo'; }
  if (anyUnder(host, STANDARD)) { return 'standard'; }
  if (anyUnder(host, FORUM)) { return 'forum'; }
  if (anyUnder(host, REFERENCE)) { return 'reference'; }
  if (anyUnder(host, DOCS) || /^(docs|doc|developer|developers|devdocs)\./.test(host)) { return 'official-docs'; }
  if (/\.(gov|mil)(\.[a-z]{2})?$/.test(host) || /^gov\.[a-z]{2}$/.test(host) || under(host, 'europa.eu') || /\.gc\.ca$/.test(host)) { return 'government'; }
  if (anyUnder(host, BLOG) || /^blogs?\./.test(host)) { return 'blog'; }
  if (anyUnder(host, NEWS)) { return 'news'; }
  if (/^\/(docs|documentation|reference|manual|api-docs)(\/|$)/.test(path)) { return 'official-docs'; }
  if (/^\/blogs?(\/|$)/.test(path)) { return 'blog'; }
  return 'unknown';
}
