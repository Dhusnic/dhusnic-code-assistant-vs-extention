import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { URL } from 'url';
import { globToRegex } from './glob';
import { RoutingConfig } from './modelRouting';
import { renameWithRetry } from './store';
import { parseTeamSources } from './teamSkills';
import { PolicyWeb, validatePolicyWeb } from './web/policy';

/**
 * Central settings distribution. The first policy found wins:
 *   %ProgramData%\Infraon\policy.json or /etc/infraon/policy.json, then $INFRAON_POLICY_FILE, then an optional URL.
 * The machine file comes first because only administrators can write it: a user-set variable must not replace it.
 * Validation fails closed per field: an invalid value becomes its most restrictive form and the other fields still apply.
 * In `allowedModels` and `mcpAllowlist`, undefined means unrestricted, [] means nothing is allowed, and `*` is a wildcard.
 */
export interface PolicyPermissions { allow: string[]; ask: string[]; deny: string[] }
export interface CentralPolicy {
  baseUrl?: string; allowedModels?: string[]; defaultModel?: string; allowSelfSignedTls?: boolean;
  permissions?: PolicyPermissions; disableAutoMode?: boolean; teamSkills?: unknown[]; mcpAllowlist?: string[];
  redactSecrets?: boolean; auditLog?: boolean; routing?: RoutingConfig;
  /** Internet access: domain lists, approvals, downloads, quotas (see web/policy.ts). */
  web?: PolicyWeb;
  /** Self-update: true turns it off; updateUrl replaces the manifest URL derived from baseUrl. */
  disableAutoUpdate?: boolean; updateUrl?: string;
}
export type PolicySource = 'env' | 'machine' | 'url' | 'cache' | 'none';
export interface LoadedPolicy { policy: CentralPolicy; source: PolicySource; errors: string[]; location?: string }
export type PolicyFetch = (url: string, opts: { signal: AbortSignal; maxBytes: number }) => Promise<{ status: number; text: string }>;
export interface LoadPolicyOptions {
  env?: Record<string, string | undefined>; platform?: string; programData?: string; url?: string;
  /** A host allowed to serve the policy over plain http. */
  internalHost?: string; fetchFn?: PolicyFetch; cacheFile?: string;
}
export interface PolicyConfigInput {
  baseUrl?: string; model?: string; allowSelfSignedTls?: boolean; mode?: string; permissions?: Partial<PolicyPermissions>;
  teamSkills?: unknown[]; mcpServers?: Record<string, unknown>; redactSecrets?: boolean; auditLog?: boolean; routing?: RoutingConfig;
}

export const POLICY_MAX_BYTES = 256 * 1024;
export const POLICY_TIMEOUT_MS = 5000;
const MAX_ENTRY = 200;
const ROUTING_KEYS: Array<keyof RoutingConfig> = ['subagent', 'completion', 'vision', 'summary', 'commit'];

/** What applies when a policy exists but cannot be understood at all. */
export const restrictedPolicy = (): CentralPolicy => ({ allowSelfSignedTls: false, disableAutoMode: true, redactSecrets: true, auditLog: true });

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const goodEntry = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= MAX_ENTRY;

function matchesEntry(entries: string[], name: string): boolean {
  const n = name.trim().toLowerCase();
  return !!n && entries.some((e) => (e.includes('*') ? globToRegex(e.replace(/[?{}]/g, '')).test(n) : e.trim().toLowerCase() === n));
}

export const isModelAllowed = (policy: CentralPolicy, model: string): boolean => policy.allowedModels === undefined || matchesEntry(policy.allowedModels, model);
export const isMcpAllowed = (policy: CentralPolicy, name: string): boolean => policy.mcpAllowlist === undefined || matchesEntry(policy.mcpAllowlist, name);
export const clampMode = <T extends string>(policy: CentralPolicy, mode: T): T | 'auto-edit' => (policy.disableAutoMode === true && mode === 'auto' ? 'auto-edit' : mode);

function validUrl(v: unknown): boolean {
  if (typeof v !== 'string') { return false; }
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
  } catch { return false; }
}

function validatePermissions(raw: unknown, errors: string[]): PolicyPermissions {
  if (!isObject(raw)) {
    errors.push('permissions must be an object; every action will ask for approval');
    return { allow: [], ask: ['*'], deny: [] };
  }
  const read = (key: 'allow' | 'ask' | 'deny'): string[] => {
    const v = raw[key];
    if (v === undefined) { return []; }
    const good = Array.isArray(v) ? v.filter(goodEntry) : [];
    if (Array.isArray(v) && good.length === v.length) { return good; }
    errors.push(`permissions.${key} is invalid`);
    return key === 'allow' ? good : ['*'];                            // a rule we cannot read may have been a restriction
  };
  return { allow: read('allow'), ask: read('ask'), deny: read('deny') };
}

export function validatePolicy(raw: unknown): { policy: CentralPolicy; errors: string[] } {
  if (!isObject(raw)) { return { policy: restrictedPolicy(), errors: ['policy must be a JSON object'] }; }
  const errors: string[] = [];
  const policy: CentralPolicy = {};
  const flag = (key: 'allowSelfSignedTls' | 'disableAutoMode' | 'redactSecrets' | 'auditLog' | 'disableAutoUpdate', closed: boolean): void => {
    const v = raw[key];
    if (v === undefined) { return; }
    if (typeof v === 'boolean') { policy[key] = v; return; }
    errors.push(`${key} must be true or false`);
    policy[key] = closed;
  };
  const allowList = (key: 'allowedModels' | 'mcpAllowlist'): void => {
    const v = raw[key];
    if (v === undefined) { return; }
    if (!Array.isArray(v)) { errors.push(`${key} must be a list; nothing is allowed`); policy[key] = []; return; }
    policy[key] = v.filter(goodEntry);
    if (policy[key]!.length !== v.length) { errors.push(`${key} has invalid entries, which were ignored`); }
  };
  flag('allowSelfSignedTls', false);
  flag('disableAutoMode', true);
  flag('redactSecrets', true);
  flag('auditLog', true);
  flag('disableAutoUpdate', true);
  if (raw.updateUrl !== undefined) {
    if (validUrl(raw.updateUrl)) { policy.updateUrl = raw.updateUrl as string; } else { errors.push('updateUrl must be an http(s) URL without credentials'); }
  }
  allowList('allowedModels');
  allowList('mcpAllowlist');
  if (raw.baseUrl !== undefined) {
    if (validUrl(raw.baseUrl)) { policy.baseUrl = raw.baseUrl as string; } else { errors.push('baseUrl must be an http(s) URL without credentials'); }
  }
  if (raw.defaultModel !== undefined) {
    if (!goodEntry(raw.defaultModel)) { errors.push('defaultModel must be a model name'); }
    else if (!isModelAllowed(policy, raw.defaultModel)) { errors.push(`defaultModel "${raw.defaultModel}" is not in allowedModels`); }
    else { policy.defaultModel = raw.defaultModel; }
  }
  if (raw.permissions !== undefined) { policy.permissions = validatePermissions(raw.permissions, errors); }
  if (raw.teamSkills !== undefined) {
    if (!Array.isArray(raw.teamSkills)) { errors.push('teamSkills must be a list'); policy.teamSkills = []; }
    else {
      policy.teamSkills = raw.teamSkills.filter((entry) => {
        const r = parseTeamSources([entry]);
        errors.push(...r.errors.map((e) => `teamSkills: ${e}`));
        return r.sources.length === 1;
      });
    }
  }
  if (raw.routing !== undefined) {
    if (!isObject(raw.routing)) { errors.push('routing must be an object'); }
    else {
      const routing: RoutingConfig = {};
      for (const key of ROUTING_KEYS) {
        const v = raw.routing[key];
        if (v === undefined) { continue; }
        if (goodEntry(v) && isModelAllowed(policy, v)) { routing[key] = v; } else { errors.push(`routing.${key} is invalid or not an allowed model`); }
      }
      policy.routing = routing;
    }
  }
  if (raw.web !== undefined) { policy.web = validatePolicyWeb(raw.web, errors); }
  return { policy, errors };
}

const parsePolicy = (text: string): unknown => JSON.parse(text.replace(/^\uFEFF/, ''));

async function readCapped(file: string): Promise<string> {
  const s = await fs.stat(file);
  if (s.size > POLICY_MAX_BYTES) { throw new Error(`larger than ${POLICY_MAX_BYTES} bytes`); }
  return fs.readFile(file, 'utf8');
}

/** The URL's problem, or undefined when it may be used. */
export function checkPolicyUrl(url: string, internalHost?: string): string | undefined {
  let u: URL;
  try { u = new URL(url); } catch { return 'policy URL is not valid'; }
  if (u.username || u.password) { return 'policy URL must not contain credentials'; }
  if (u.protocol === 'https:') { return undefined; }
  if (u.protocol === 'http:' && internalHost && u.hostname.toLowerCase() === internalHost.trim().toLowerCase()) { return undefined; }
  return 'policy URL must use https or the configured internal host';
}

const defaultFetch: PolicyFetch = (url, { signal, maxBytes }) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = (u.protocol === 'https:' ? https : http).get(u, { signal, headers: { Accept: 'application/json' } }, (res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (d: Buffer) => {
      size += d.length;
      if (size > maxBytes) { req.destroy(new Error(`larger than ${maxBytes} bytes`)); return; }
      chunks.push(d);
    });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    res.on('error', reject);
  });
  req.on('error', reject);
});

async function fetchPolicy(url: string, fetchFn: PolicyFetch): Promise<string> {
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ctl.abort(); reject(new Error('timed out')); }, POLICY_TIMEOUT_MS);
  });
  try {
    const res = await Promise.race([fetchFn(url, { signal: ctl.signal, maxBytes: POLICY_MAX_BYTES }), limit]);
    if (res.status !== 200) { throw new Error(`HTTP ${res.status}`); }             // redirects are not followed: they could leave the approved host
    if (Buffer.byteLength(res.text) > POLICY_MAX_BYTES) { throw new Error(`larger than ${POLICY_MAX_BYTES} bytes`); }
    return res.text;
  } finally { clearTimeout(timer); }
}

async function writeCache(file: string, url: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ url, body }), 'utf8');
  try { await renameWithRetry(tmp, file); } catch (e) { await fs.rm(tmp, { force: true }); throw e; }
}

async function readCache(file: string | undefined, url: string): Promise<unknown> {
  if (!file) { return undefined; }
  try {
    const c = JSON.parse(await fs.readFile(file, 'utf8'));
    return c?.url === url && typeof c.body === 'string' ? parsePolicy(c.body) : undefined;
  } catch { return undefined; }
}

async function loadFromUrl(url: string, opts: LoadPolicyOptions, errors: string[]): Promise<LoadedPolicy> {
  const problem = checkPolicyUrl(url, opts.internalHost);
  if (problem) { return { policy: {}, source: 'none', errors: [...errors, problem] }; }
  let failure: string;
  let malformed = false;
  try {
    const text = await fetchPolicy(url, opts.fetchFn ?? defaultFetch);
    try {
      const raw = parsePolicy(text);
      if (!isObject(raw)) { throw new Error('not a JSON object'); }
      const v = validatePolicy(raw);
      if (opts.cacheFile && !v.errors.length) {
        await writeCache(opts.cacheFile, url, text).catch((e: any) => errors.push(`policy cache: ${e.message}`));
      }
      return { policy: v.policy, source: 'url', errors: [...errors, ...v.errors], location: url };
    } catch (e: any) { malformed = true; failure = e.message; }
  } catch (e: any) { failure = e?.message ?? String(e); }
  errors.push(`policy URL: ${failure!}`);
  const cached = await readCache(opts.cacheFile, url);
  if (isObject(cached)) {
    const v = validatePolicy(cached);
    return { policy: v.policy, source: 'cache', errors: [...errors, ...v.errors], location: opts.cacheFile };
  }
  return { policy: malformed ? restrictedPolicy() : {}, source: malformed ? 'url' : 'none', errors, ...(malformed ? { location: url } : {}) };
}

/** Finds and validates the policy. Never rejects. */
export async function loadPolicy(opts: LoadPolicyOptions = {}): Promise<LoadedPolicy> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const errors: string[] = [];
  const machine = platform === 'win32'
    ? path.win32.join(opts.programData ?? env.ProgramData ?? 'C:\\ProgramData', 'Infraon', 'policy.json')
    : '/etc/infraon/policy.json';
  const candidates: Array<{ file: string; source: PolicySource }> = [
    { file: machine, source: 'machine' },
    ...(env.INFRAON_POLICY_FILE?.trim() ? [{ file: env.INFRAON_POLICY_FILE.trim(), source: 'env' as const }] : []),
  ];
  for (const { file, source } of candidates) {
    let text: string;
    try { text = await readCapped(file); } catch (e: any) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
        if (source === 'env') { errors.push(`INFRAON_POLICY_FILE not found: ${file}`); }
        continue;
      }
      return { policy: restrictedPolicy(), source, errors: [...errors, `${file}: ${e.message}`], location: file };
    }
    try {
      const v = validatePolicy(parsePolicy(text));
      return { policy: v.policy, source, errors: [...errors, ...v.errors], location: file };
    } catch (e: any) {                                                // present but unreadable: must not fall through to a weaker source
      return { policy: restrictedPolicy(), source, errors: [...errors, `${file}: ${e.message}`], location: file };
    }
  }
  if (opts.url?.trim()) { return loadFromUrl(opts.url.trim(), opts, errors); }
  return { policy: {}, source: 'none', errors };
}

/** Effective settings under a policy, and the keys the user can no longer change. */
export function applyPolicyToConfig<T extends PolicyConfigInput>(cfg: T, policy: CentralPolicy): { config: T; locked: string[] } {
  const config: T = { ...cfg };
  const locked = new Set<string>();
  if (policy.baseUrl !== undefined) { config.baseUrl = policy.baseUrl; locked.add('baseUrl'); }
  if (policy.allowSelfSignedTls !== undefined) { config.allowSelfSignedTls = policy.allowSelfSignedTls; locked.add('allowSelfSignedTls'); }
  if (policy.redactSecrets !== undefined) { config.redactSecrets = policy.redactSecrets; locked.add('redactSecrets'); }
  if (policy.auditLog !== undefined) { config.auditLog = policy.auditLog; locked.add('auditLog'); }
  if (policy.allowedModels !== undefined) { locked.add('allowedModels'); }
  const model = cfg.model?.trim();
  if (!model || !isModelAllowed(policy, model)) {
    const fallback = policy.defaultModel ?? policy.allowedModels?.find((m) => !m.includes('*'));
    if (model) { locked.add('model'); }
    if (fallback !== undefined || model) { config.model = fallback ?? ''; }
  }
  if (policy.disableAutoMode === true) {
    locked.add('mode');
    if (cfg.mode !== undefined) { config.mode = clampMode(policy, cfg.mode); }
  }
  if (policy.permissions) {
    const merged = (key: keyof PolicyPermissions): string[] => [...new Set([...policy.permissions![key], ...(cfg.permissions?.[key] ?? [])])];
    config.permissions = { allow: merged('allow'), ask: merged('ask'), deny: merged('deny') };
    locked.add('permissions');
  }
  if (policy.teamSkills !== undefined) { config.teamSkills = policy.teamSkills; locked.add('teamSkills'); }
  if (policy.mcpAllowlist !== undefined) {
    locked.add('mcpServers');
    if (cfg.mcpServers) { config.mcpServers = Object.fromEntries(Object.entries(cfg.mcpServers).filter(([name]) => isMcpAllowed(policy, name))); }
  }
  if (policy.routing !== undefined) { locked.add('routing'); }
  if (policy.routing !== undefined || (cfg.routing && policy.allowedModels !== undefined)) {
    const routing: RoutingConfig = { ...cfg.routing, ...policy.routing };
    for (const key of ROUTING_KEYS) {
      const m = routing[key];
      if (m !== undefined && !isModelAllowed(policy, m)) { delete routing[key]; }
    }
    config.routing = routing;
  }
  return { config, locked: [...locked] };
}
