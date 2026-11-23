import { hostMatches, isPrivateIp } from '../web/ssrf';

/** Hosts on this machine or the company network: localhost, private IPs, single-label and intranet names, and allow-listed hosts. */
export function isPrivateHost(host: string, allowed: string[] = []): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (!h) { return false; }
  if (h === 'localhost' || h.endsWith('.localhost') || isPrivateIp(h)) { return true; }
  if (!h.includes('.') && !h.includes(':')) { return true; }
  if (/\.(local|internal|intranet|corp|lan|home\.arpa|test|example)$/.test(h)) { return true; }
  return hostMatches(h, allowed);
}

/** Every server URL a testing tool call would contact (bare "localhost:3000" forms included). */
export function testTargets(tool: string, args: any): string[] {
  const out: string[] = [];
  const add = (v: unknown) => { if (typeof v === 'string' && v.trim()) { out.push(v.trim()); } };
  if (!args || typeof args !== 'object') { return out; }
  add(args.url);
  if (tool === 'browser_act' && Array.isArray(args.steps)) { for (const s of args.steps) { add(s?.navigate); } }
  for (const side of [args.expected, args.actual]) {
    const api = side && typeof side === 'object' ? side.api : undefined;
    add(typeof api === 'string' ? api : api?.url);
  }
  return out;
}

export function hostOf(raw: string): string | undefined {
  const s = raw.trim();
  if (/^(file|about|data):/i.test(s)) { return 'localhost'; }
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`).hostname; } catch { return undefined; }
}

/** The first target that is not private, or undefined when every target is on this machine or the intranet. */
export function publicTarget(urls: string[], allowed: string[] = []): string | undefined {
  return urls.find((u) => { const h = hostOf(u); return !h || !isPrivateHost(h, allowed); });
}

/** What the guard needs from the web policy. */
export interface TargetPolicy { enabled: boolean; offline: boolean; allowPrivateHosts: string[] }

/**
 * Testing tools usually target localhost or the intranet. An internet target still obeys the web policy's hard limits:
 * web access off, offline mode, and (via `decide`, the regular per-domain web decision) blocked domains.
 */
export function testTargetDenial(tool: string, args: any, p: TargetPolicy, decide: (url: string) => { effect: string; reason?: string }): string | undefined {
  for (const u of testTargets(tool, args)) {
    const host = hostOf(u);
    if (!host || isPrivateHost(host, p.allowPrivateHosts)) { continue; }
    if (!p.enabled || p.offline) { return `${host} is on the internet and web access is ${p.enabled ? 'in offline mode' : 'turned off'}`; }
    const d = decide(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    if (d.effect === 'deny') { return d.reason ?? `${host} is blocked`; }
  }
  return undefined;
}

/**
 * A secret (restored from its ‹secret:…› placeholder) may go to a local or intranet test server, never to the internet.
 * For browser steps the open page counts too: typing a password into it sends it to that page's server.
 */
export function secretTargetProblem(tool: string, args: any, currentUrl: string | undefined, allowed: string[]): string | undefined {
  const urls = testTargets(tool, args);
  if (tool === 'browser_act' && currentUrl) { urls.push(currentUrl); }
  const pub = publicTarget(urls, allowed);
  if (!pub) { return undefined; }
  return `Refused: these arguments contain a secret (shown to you as ‹secret:…›) and would send it to ${hostOf(pub) ?? pub}, which is not a local or intranet host. Secrets are only used with test servers on localhost or the company network (an internal host can be added to the setting infraonAssistant.web.allowPrivateHosts).`;
}
