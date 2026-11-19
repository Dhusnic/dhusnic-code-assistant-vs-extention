import type { ChatMessage } from './llm';

export interface SecretSpan { start: number; end: number }
export interface Detector { kind: string; scan(text: string): SecretSpan[] }

const PLACEHOLDER = /‹secret:([a-z0-9_]{1,32}):(\d{1,9})›/g;
const MAX_VALUE = 512;

// ---------------------------------------------------------------- false-positive filters

const TEMPLATE_VALUE = /^(?:\$\{?[\w.:-]*\}?|%[\w()-]+%|\{\{.*\}\}|<[^>]*>|\[[^\]]*\]|#\{.*\})$/;
const REFERENCE_VALUE = /(?:^|[^\w])(?:process\.env|import\.meta\.env|os\.environ|os\.getenv|System\.getenv|Environment\.GetEnvironmentVariable|ENV\[|env\.[A-Za-z_]|secrets\.[A-Za-z_]|vault\.[A-Za-z_])/;
const DUMMY_FRAGMENT = /example|changeme|change[_-]me|replace[_-]?me|placeholder|redacted|dummy|sample|x{3,}|\*{3,}|\.{3,}|your[_-]/i;
const DUMMY_WORD = /^(?:string|str|number|int|integer|float|boolean|bool|object|any|null|nil|none|undefined|true|false|void|bytes?|secret|password|passwd|token|apikey|api_key|test|testing|default|empty|unknown|optional|required|hidden|masked|admin|todo)$/i;
const CODE_REFERENCE = /^[A-Za-z_$][\w$]*(?:(?:\.|::|->)[A-Za-z_$][\w$]*)+$/;

const isPlaceholderValue = (v: string): boolean =>
  !v.trim() || v.includes('‹secret:') || TEMPLATE_VALUE.test(v) || REFERENCE_VALUE.test(v) || DUMMY_FRAGMENT.test(v) || DUMMY_WORD.test(v);

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const counts = new Map<number, number>();
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); counts.set(c, (counts.get(c) ?? 0) + 1); }
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

/** Decides whether the value of a `password = ...` style assignment looks real. */
function isLikelySecret(v: string, quoted: boolean): boolean {
  if (v.length < (quoted ? 6 : 8)) { return false; }
  if (isPlaceholderValue(v) || /\s/.test(v) || /^[-+]?[\d.,_]+$/.test(v) || /^(?:\.{0,2}\/|~\/)/.test(v)) { return false; }
  if (quoted) { return entropy(v) >= 2; }
  if (entropy(v) < 2.5 || CODE_REFERENCE.test(v) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v)) { return false; }
  return /\d/.test(v) || /[^A-Za-z_-]/.test(v) || (v.length >= 20 && entropy(v) >= 3.5 && /[a-z]/.test(v) && /[A-Z]/.test(v));
}

// ---------------------------------------------------------------- detectors

/** A regex detector. `hints` skip the regex entirely when no literal prefix occurs in the text. */
function regexDetector(kind: string, re: RegExp, hints?: string[], group = 0, accept?: (v: string) => boolean): Detector {
  return {
    kind,
    scan(text) {
      if (hints && !hints.some((h) => text.includes(h))) { return []; }
      const out: SecretSpan[] = [];
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (!m[0]) { re.lastIndex++; continue; }
        const value = m[group];
        if (value === undefined || isPlaceholderValue(value) || (accept && !accept(value))) { continue; }
        const start = m.index + m[0].lastIndexOf(value);
        out.push({ start, end: start + value.length });
      }
      return out;
    },
  };
}

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,32}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_BODY = /[A-Za-z0-9+/=\s\\:,-]/;

const pemDetector: Detector = {
  kind: 'private_key',
  scan(text) {
    if (!text.includes('PRIVATE KEY')) { return []; }
    const out: SecretSpan[] = [];
    PEM_BEGIN.lastIndex = 0;
    for (let m = PEM_BEGIN.exec(text); m; m = PEM_BEGIN.exec(text)) {
      const bodyStart = m.index + m[0].length;
      const endTag = text.indexOf('-----END ', bodyStart);
      if (endTag < 0) {
        // Truncated key (for example a partial file read): mask the base64 body that is present.
        let e = bodyStart;
        while (e < text.length && PEM_BODY.test(text[e])) { e++; }
        out.push({ start: m.index, end: e });
        break;
      }
      const close = text.indexOf('-----', endTag + 9);
      const end = close < 0 ? text.length : close + 5;
      out.push({ start: m.index, end });
      PEM_BEGIN.lastIndex = end;
    }
    return out;
  },
};

const urlDetector: Detector = {
  kind: 'url_password',
  scan(text) {
    const out: SecretSpan[] = [];
    for (let i = text.indexOf('://'); i >= 0; i = text.indexOf('://', i + 3)) {
      const from = i + 3;
      let end = from;
      const limit = Math.min(text.length, from + MAX_VALUE);
      while (end < limit && !'/?#"\'` \t\r\n'.includes(text[end])) { end++; }
      // Searched inside the bounded authority only: an unbounded lastIndexOf would make this quadratic.
      const authority = text.slice(from, end);
      const atRel = authority.lastIndexOf('@');
      const colonRel = authority.indexOf(':');
      if (atRel < 0 || colonRel < 0 || colonRel + 1 >= atRel) { continue; }
      const at = from + atRel, colon = from + colonRel;
      if (i === 0 || !/[A-Za-z0-9+.-]/.test(text[i - 1])) { continue; }
      if (!isPlaceholderValue(text.slice(colon + 1, at))) { out.push({ start: colon + 1, end: at }); }
    }
    return out;
  },
};

const CONN_KEY = /(?<![A-Za-z0-9_])(?:password|pwd)\s{0,4}=\s{0,4}/gi;
const CONN_CONTEXT = /(?<![A-Za-z0-9_])(?:server|host|data source|uid|user id|username|user|database|initial catalog)\s{0,4}=/gi;
const CONN_WINDOW = 256;

const connectionDetector: Detector = {
  kind: 'conn_password',
  scan(text) {
    const out: SecretSpan[] = [];
    CONN_KEY.lastIndex = 0;
    CONN_CONTEXT.lastIndex = 0;
    let prev = -1;
    let next = CONN_CONTEXT.exec(text);
    for (let m = CONN_KEY.exec(text); m; m = CONN_KEY.exec(text)) {
      const start = m.index + m[0].length;
      let end = start;
      const limit = Math.min(text.length, start + MAX_VALUE);
      while (end < limit && !';\'"\r\n'.includes(text[end]) && text[end] !== ' ') { end++; }
      CONN_KEY.lastIndex = Math.max(end, CONN_KEY.lastIndex);
      while (next && next.index < m.index) { prev = next.index; next = CONN_CONTEXT.exec(text); }
      const near = (prev >= 0 && m.index - prev <= CONN_WINDOW) || (next !== null && next.index - end <= CONN_WINDOW);
      if (near && end > start && !isPlaceholderValue(text.slice(start, end))) { out.push({ start, end }); }
    }
    return out;
  },
};

const GENERIC_KEY = /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)(?:[_-]?(?:key|value))?["']?\s{0,4}(?:\??:\s{0,4}[A-Za-z_][\w<>[\]|.]{0,32}\s{0,4}={1,3}(?!=)|:=|={1,3}>?|:)\s{0,8}/gi;
const VALUE_END = new Set([' ', '\t', '\r', '\n', ',', ';', '&', ')', '}', ']', '"', "'", '`', '<', '>', '(', '[', '{']);

const genericDetector: Detector = {
  kind: 'generic',
  scan(text) {
    const out: SecretSpan[] = [];
    GENERIC_KEY.lastIndex = 0;
    for (let m = GENERIC_KEY.exec(text); m; m = GENERIC_KEY.exec(text)) {
      const at = m.index + m[0].length;
      const q = text[at];
      if (q === '"' || q === "'" || q === '`') {
        let e = at + 1;
        const limit = Math.min(text.length, at + 1 + MAX_VALUE);
        while (e < limit && text[e] !== q && text[e] !== '\n') { e += text[e] === '\\' ? 2 : 1; }
        GENERIC_KEY.lastIndex = Math.max(GENERIC_KEY.lastIndex, Math.min(e + 1, text.length));
        if (e < limit && text[e] === q && isLikelySecret(text.slice(at + 1, e), true)) { out.push({ start: at + 1, end: e }); }
        continue;
      }
      let e = at;
      const limit = Math.min(text.length, at + MAX_VALUE);
      while (e < limit && !VALUE_END.has(text[e])) { e++; }
      GENERIC_KEY.lastIndex = Math.max(GENERIC_KEY.lastIndex, e);
      if (e > at && text[e] !== '(' && isLikelySecret(text.slice(at, e), false)) { out.push({ start: at, end: e }); }
    }
    return out;
  },
};

/** Ordered by priority: when two detectors claim the same span the earlier one names it. */
export const DETECTORS: Detector[] = [
  pemDetector,
  regexDetector('aws_access_key', /(?<![A-Za-z0-9])(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, ['AKIA', 'ASIA', 'AGPA', 'AIDA', 'AROA', 'AIPA', 'ANPA', 'ANVA']),
  regexDetector('aws_secret', /aws_?secret_?(?:access_?)?key["']?\s{0,4}[:=]\s{0,4}["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi, undefined, 1),
  regexDetector('github', /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})(?![A-Za-z0-9_])/g, ['gh', 'github_pat_']),
  regexDetector('gitlab', /(?<![A-Za-z0-9_-])(?:glpat|gldt|glrt|glsoat)-[A-Za-z0-9_-]{20,128}/g, ['glpat-', 'gldt-', 'glrt-', 'glsoat-']),
  regexDetector('slack', /(?<![A-Za-z0-9-])(?:xox[abeoprs]|xapp)-[A-Za-z0-9-]{10,255}/g, ['xox', 'xapp-']),
  regexDetector('slack', /hooks\.slack\.com\/services\/(T[A-Za-z0-9]{4,32}\/B[A-Za-z0-9]{4,32}\/[A-Za-z0-9]{16,64})/g, ['hooks.slack.com'], 1),
  regexDetector('stripe', /(?<![A-Za-z0-9_])(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}|whsec_[A-Za-z0-9]{24,255})/g, ['sk_live_', 'sk_test_', 'rk_live_', 'rk_test_', 'whsec_']),
  regexDetector('google', /(?<![A-Za-z0-9_-])(?:AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])|ya29\.[A-Za-z0-9_-]{20,1024})/g, ['AIza', 'ya29.']),
  regexDetector('azure', /(?:AccountKey|SharedAccessKey)\s{0,4}=\s{0,4}([A-Za-z0-9+/]{20,128}={0,2})/gi, undefined, 1),
  regexDetector('azure', /[?&]sig=([A-Za-z0-9%+/]{20,128}={0,2})/g, ['sig='], 1),
  regexDetector('azure', /(?<![A-Za-z0-9_~.-])[A-Za-z0-9_~.-]{3}8Q~[A-Za-z0-9_~.-]{31,34}(?![A-Za-z0-9_~.-])/g, ['8Q~']),
  regexDetector('npm', /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9_])/g, ['npm_']),
  regexDetector('jwt', /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,1024}\.eyJ[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,2048}/g, ['eyJ']),
  regexDetector('auth_header', /Authorization["']?\s{0,4}[:=]\s{0,4}["']?(?:Bearer|Basic|Token)\s{1,8}([A-Za-z0-9._~+/-]{8,4096}={0,2})/gi, undefined, 1),
  regexDetector('auth_header', /(?<![A-Za-z0-9])Bearer\s{1,8}([A-Za-z0-9._~+/-]{16,4096}={0,2})/g, ['Bearer'], 1, (v) => /\d/.test(v) && entropy(v) >= 3),
  urlDetector,
  connectionDetector,
  genericDetector,
];

// ---------------------------------------------------------------- vault

const SENSITIVE_KEY = /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)(?:[_-]?(?:key|value))?$/i;

export interface RedactResult { text: string; count: number; kinds: string[] }

/** Session-scoped, reversible secret masking. Keep one vault per session, in memory only. */
export class SecretVault {
  private bySecret = new Map<string, string>();
  private byPlaceholder = new Map<string, string>();
  private next = 1;
  /** Exact values that are always secret (saved server passwords, environment values), whatever they look like. */
  private known = new Map<string, string>();

  addKnown(secret: string, kind: string): void { if (typeof secret === 'string' && secret.length >= 4) { this.known.set(secret, kind); } }

  get size(): number { return this.bySecret.size; }

  private mask(secret: string, kind: string): string {
    let ph = this.bySecret.get(secret);
    if (!ph) {
      ph = `‹secret:${kind}:${this.next++}›`;
      this.bySecret.set(secret, ph);
      this.byPlaceholder.set(ph, secret);
    }
    return ph;
  }

  redact(text: string): RedactResult {
    if (typeof text !== 'string' || !text) { return { text, count: 0, kinds: [] }; }
    const taken: Array<SecretSpan & { rank: number; kind: string }> = [];
    let sources = 0;
    DETECTORS.forEach((d, rank) => {
      const spans = d.scan(text) as Array<SecretSpan & { rank: number; kind: string }>;
      if (spans.length) { sources++; }
      for (const s of spans) { s.rank = rank; s.kind = d.kind; taken.push(s); }
    });
    for (const [secret, kind] of this.known) {
      let i = text.indexOf(secret), found = false;
      while (i >= 0) { taken.push({ start: i, end: i + secret.length, rank: -1, kind }); found = true; i = text.indexOf(secret, i + secret.length); }
      if (found) { sources += 2; }
    }
    if (!taken.length) { return { text, count: 0, kinds: [] }; }
    // Each detector reports in text order, so a single source needs no sort.
    if (sources > 1) { taken.sort((a, b) => a.start - b.start || b.end - a.end || a.rank - b.rank); }

    const existing: SecretSpan[] = [];
    if (text.includes('‹secret:')) {
      for (const m of text.matchAll(PLACEHOLDER)) { existing.push({ start: m.index!, end: m.index! + m[0].length }); }
    }
    const parts: string[] = [];
    const kinds = new Set<string>();
    let pos = 0, count = 0, e = 0;
    for (const s of taken) {
      if (s.start < pos) { continue; }
      while (e < existing.length && existing[e].end <= s.start) { e++; }
      if (e < existing.length && existing[e].start < s.end) { continue; }
      parts.push(text.slice(pos, s.start), this.mask(text.slice(s.start, s.end), s.kind));
      pos = s.end; count++; kinds.add(s.kind);
    }
    if (!count) { return { text, count: 0, kinds: [] }; }
    parts.push(text.slice(pos));
    return { text: parts.join(''), count, kinds: [...kinds].sort() };
  }

  /** Swaps known placeholders back. Unknown ones stay as they are; check hasUnknownPlaceholder before writing to disk. */
  restore(text: string): string {
    if (typeof text !== 'string' || !text.includes('‹secret:')) { return text; }
    return text.replace(PLACEHOLDER, (ph) => this.byPlaceholder.get(ph) ?? ph);
  }

  /** Restores inside a JSON document (tool_call arguments) so that restored values stay correctly escaped. */
  restoreJson(json: string): string {
    if (typeof json !== 'string' || !json.includes('‹secret:')) { return json; }
    try { return JSON.stringify(this.restoreValue(JSON.parse(json))); } catch { return this.restore(json); }
  }

  /** Deep-restores every string in a parsed value. */
  restoreValue<T>(value: T): T {
    if (typeof value === 'string') { return this.restore(value) as unknown as T; }
    if (Array.isArray(value)) { return value.map((v) => this.restoreValue(v)) as unknown as T; }
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.restoreValue(v)])) as T;
    }
    return value;
  }

  hasUnknownPlaceholder(text: string): boolean {
    if (typeof text !== 'string' || !text.includes('‹secret:')) { return false; }
    for (const m of text.matchAll(PLACEHOLDER)) { if (!this.byPlaceholder.has(m[0])) { return true; } }
    return false;
  }

  /** Masks strings in parsed JSON; a sensitive key marks its value as secret even without an assignment in the text. */
  redactValue(value: unknown, key?: string): unknown {
    if (typeof value === 'string') {
      if (key && SENSITIVE_KEY.test(key) && isLikelySecret(value, true)) { return this.mask(value, 'generic'); }
      return this.redact(value).text;
    }
    if (Array.isArray(value)) { return value.map((v) => this.redactValue(v)); }
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.redactValue(v, k)]));
    }
    return value;
  }
}

function redactArguments(args: string, vault: SecretVault): string {
  let parsed: unknown;
  try { parsed = JSON.parse(args); } catch { return vault.redact(args).text; }
  const masked = JSON.stringify(vault.redactValue(parsed));
  return masked === JSON.stringify(parsed) ? args : masked;
}

/** Returns masked copies of the messages (content and tool_call arguments). Safe to apply repeatedly. */
export function redactMessages(messages: ChatMessage[], vault: SecretVault): ChatMessage[] {
  return messages.map((m) => ({
    ...m,
    content: typeof m.content === 'string' ? vault.redact(m.content).text : m.content,
    ...(m.tool_calls ? {
      tool_calls: m.tool_calls.map((c) => ({ ...c, function: { ...c.function, arguments: redactArguments(c.function.arguments, vault) } })),
    } : {}),
  }));
}
