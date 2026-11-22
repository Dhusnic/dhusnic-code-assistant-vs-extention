/**
 * Data-correctness checks shared by api_test and data_compare: JSON paths, value rules, CSV parsing,
 * value comparison that sees through display formatting ("$1,234.50" = 1234.5), and row-set diffs.
 */

export type Row = Record<string, unknown>;

/* ------------------------------------------------------------------ JSON paths */

/** "data.items[0].name", "$.items[*].id", "items.length". "[*]" fans out and returns an array. */
export function getPath(value: unknown, path: string | undefined): unknown {
  if (!path || path === '$' || path === '.') { return value; }
  const tokens: Array<string | number | '*'> = [];
  const re = /\[(\*|-?\d+)\]|\[["']([^"']+)["']\]|([^.[\]]+)/g;
  let m: RegExpExecArray | null;
  const p = path.replace(/^\$\.?/, '');
  while ((m = re.exec(p))) { tokens.push(m[1] === '*' ? '*' : m[1] !== undefined ? Number(m[1]) : (m[2] ?? m[3])); }
  const walk = (v: unknown, i: number): unknown => {
    if (i >= tokens.length) { return v; }
    const t = tokens[i];
    if (t === '*') { return Array.isArray(v) ? v.map((x) => walk(x, i + 1)) : v && typeof v === 'object' ? Object.values(v).map((x) => walk(x, i + 1)) : undefined; }
    if (v === null || v === undefined) { return undefined; }
    if (typeof t === 'number') { return Array.isArray(v) ? walk(v[t < 0 ? v.length + t : t], i + 1) : undefined; }
    if (t === 'length' && (Array.isArray(v) || typeof v === 'string')) { return walk(v.length, i + 1); }
    return typeof v === 'object' ? walk((v as any)[t], i + 1) : undefined;
  };
  return walk(value, 0);
}

/** An object with one obvious list in it ({data: [...]}, {items: [...]}) is that list; anything else is one row. */
export function toRows(value: unknown): Row[] {
  if (Array.isArray(value)) { return value.map((v) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : { value: v })); }
  if (value && typeof value === 'object') {
    const lists = Object.entries(value as Row).filter(([, v]) => Array.isArray(v) && (v as unknown[]).every((x) => x && typeof x === 'object'));
    const preferred = lists.find(([k]) => /^(data|items|results|rows|records|content|list|entries|values)$/i.test(k)) ?? (lists.length === 1 ? lists[0] : undefined);
    if (preferred) { return toRows(preferred[1]); }
    return [value as Row];
  }
  return value === undefined ? [] : [{ value }];
}

/* ------------------------------------------------------------------ CSV */

export function parseCsv(text: string, delimiter?: string): Row[] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = delimiter ?? [',', ';', '\t', '|'].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else { q = false; } } else { cell += c; }
    } else if (c === '"' && cell === '') { q = true; }
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') { i++; } row.push(cell); rows.push(row); row = []; cell = ''; }
    else { cell += c; }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const data = rows.filter((r) => r.some((c) => c.trim() !== ''));
  const header = (data.shift() ?? []).map((h, i) => h.trim() || `col${i + 1}`);
  return data.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] === undefined ? null : cells[i]])));
}

/* ------------------------------------------------------------------ value parsing */

const EMPTY = new Set(['', '-', '—', '–', 'n/a', 'na', 'null', 'none', 'undefined', 'nil']);
export const isEmpty = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && EMPTY.has(v.trim().toLowerCase())) || (Array.isArray(v) && v.length === 0);

const TRUE = new Set(['true', 'yes', 'y', 'on', '✓', '✔', 'enabled', 'active']);
const FALSE = new Set(['false', 'no', 'n', 'off', '✗', '✘', 'disabled', 'inactive']);
export function parseBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') { return v; }
  if (typeof v !== 'string') { return undefined; }
  const s = v.trim().toLowerCase();
  return TRUE.has(s) ? true : FALSE.has(s) ? false : undefined;
}

/** A number in display form: currency, thousands separators, %, (negative), K/M/B suffix. decimals: digits shown. */
export function parseNumber(v: unknown): { n: number; decimals?: number; percent?: boolean } | undefined {
  if (typeof v === 'number') { return Number.isFinite(v) ? { n: v } : undefined; }
  if (typeof v !== 'string') { return undefined; }
  let s = v.trim();
  if (!s || s.length > 40) { return undefined; }
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  s = s.replace(/^(?:[A-Z]{3}\s?)|(?:\s?[A-Z]{3})$/g, '').replace(/[$€£₹¥₩₽¢]|Rs\.?\s?/g, '').trim();
  if (/^[-−–]/.test(s)) { neg = !neg; s = s.replace(/^[-−–]\s*/, ''); }
  if (s.startsWith('+')) { s = s.slice(1); }
  const percent = s.endsWith('%');
  if (percent) { s = s.slice(0, -1).trim(); }
  const suffix = /^([\d.,]+)\s*([KMB])$/i.exec(s);
  let mult = 1;
  if (suffix) { s = suffix[1]; mult = { K: 1e3, M: 1e6, B: 1e9 }[suffix[2].toUpperCase() as 'K' | 'M' | 'B']; }
  if (!/^\d{1,3}(?:[,\s\u00A0\u202F]\d{2,3})*(?:\.\d+)?$|^\d+(?:\.\d+)?$|^\.\d+$/.test(s)) { return undefined; }
  const clean = s.replace(/[,\s\u00A0\u202F]/g, '');
  const n = Number(clean) * mult * (neg ? -1 : 1);
  if (!Number.isFinite(n)) { return undefined; }
  const dot = clean.indexOf('.');
  return { n, decimals: suffix ? undefined : dot >= 0 ? clean.length - dot - 1 : 0, percent };
}

const DATE_LIKE = /\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4}|\d{1,2} [A-Za-z]{3,9}\.? \d{4}/;
/** A date or timestamp. dateOnly: no time of day was given. */
export function parseDate(v: unknown): { t: number; dateOnly: boolean } | undefined {
  if (typeof v !== 'string' || v.length > 60 || !DATE_LIKE.test(v)) { return undefined; }
  const s = v.trim();
  const dateOnly = !/\d:\d{2}/.test(s);
  let t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
  if (Number.isNaN(t)) {
    // 31/12/2024 or 31-12-2024: day first when the first number cannot be a month.
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(.*)$/.exec(s);
    if (m && Number(m[1]) > 12) { t = Date.parse(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T00:00:00`); }
  }
  return Number.isNaN(t) ? undefined : { t, dateOnly };
}

const ymd = (t: number, utc: boolean) => { const d = new Date(t); return utc ? `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}` : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

export interface CompareOptions { tolerance?: number; ignoreCase?: boolean }

/** True when `actual` shows the same value as `expected`, allowing for display formatting. */
export function sameValue(expected: unknown, actual: unknown, o: CompareOptions = {}): boolean {
  const ignoreCase = o.ignoreCase ?? true;
  if (isEmpty(expected) || isEmpty(actual)) { return isEmpty(expected) && isEmpty(actual); }
  if (typeof expected === 'object' || typeof actual === 'object') {
    if (Array.isArray(expected) && typeof actual === 'string') { return sameValue(expected.join(', '), actual, o); }
    if (typeof expected !== 'object' || typeof actual !== 'object') { return false; }
    if (Array.isArray(expected) !== Array.isArray(actual)) { return false; }
    const ek = Object.keys(expected as object), ak = Object.keys(actual as object);
    if (ek.length !== ak.length) { return false; }
    return ek.every((k) => sameValue((expected as any)[k], (actual as any)[k], o));
  }
  const eb = parseBool(expected), ab = parseBool(actual);
  if (eb !== undefined && ab !== undefined) { return eb === ab; }
  const en = parseNumber(expected), an = parseNumber(actual);
  if (en && an) {
    const tol = o.tolerance ?? 0;
    const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(tol, 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));
    if (close(en.n, an.n)) { return true; }
    // A rounded display: 12.35 shown for 12.3456.
    const shown = typeof actual === 'string' ? an : typeof expected === 'string' ? en : undefined;
    const raw = shown === an ? en : an;
    if (shown?.decimals !== undefined && close(Number(raw.n.toFixed(shown.decimals)), shown.n)) { return true; }
    // A percentage shown as "45%" for 0.45.
    if (an.percent && !en.percent && close(en.n * 100, an.n)) { return true; }
    if (en.percent && !an.percent && close(an.n * 100, en.n)) { return true; }
    return false;
  }
  const ed = parseDate(expected), ad = parseDate(actual);
  if (ed && ad) {
    if (ed.dateOnly || ad.dateOnly) { return [true, false].some((u1) => [true, false].some((u2) => ymd(ed.t, u1) === ymd(ad.t, u2))); }
    return Math.abs(ed.t - ad.t) <= Math.max(1000, (o.tolerance ?? 0) * 1000);
  }
  const es = squash(String(expected)), as = squash(String(actual));
  return ignoreCase ? es.toLowerCase() === as.toLowerCase() : es === as;
}

/* ------------------------------------------------------------------ rules */

export const RULE_HELP = 'Rules are words separated by spaces: required, not_empty, number, integer, string, boolean, date, email, url, uuid, array, object, unique (whole column), >=N, >N, <=N, <N, min_len:N, max_len:N, one_of:a|b|c, =value, !=value, contains:text, /regex/. Example: "required number >=0". A non-string rule (number, true, null) means "equals".';

const TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  number: (v) => typeof v === 'number' ? Number.isFinite(v) : !!parseNumber(v),
  integer: (v) => { const p = parseNumber(v); return !!p && Number.isInteger(p.n); },
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean' || parseBool(v) !== undefined,
  date: (v) => !!parseDate(v) || (typeof v === 'number' && v > 1e11 && v < 1e14),
  email: (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()),
  url: (v) => typeof v === 'string' && /^https?:\/\/[^\s]+$/i.test(v.trim()),
  uuid: (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim()),
  array: (v) => Array.isArray(v),
  object: (v) => !!v && typeof v === 'object' && !Array.isArray(v),
};

const show = (v: unknown): string => { const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v); return s.length > 80 ? `${s.slice(0, 79)}…` : s; };

/** Splits a rule string, keeping /regex/ and one_of:… with spaces in one piece. */
export function ruleTokens(rule: string): string[] {
  const out: string[] = [];
  const re = /\/(?:\\.|[^/])+\/[gimsuy]*|(?:one_of|contains|=|!=):"[^"]*"|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rule))) { out.push(m[0]); }
  return out;
}

const RULE_WORDS = new Set(['required', 'not_empty', 'unique', 'optional', ...Object.keys(TYPE_CHECKS)]);
/** True for words the rule language knows; "POST" or "Ann" are values, not rules. */
export const isRuleToken = (t: string): boolean => RULE_WORDS.has(t) || /^(>=|<=|>|<)-?\d+(\.\d+)?$|^(min_len|max_len):\d+$|^(one_of|contains):|^!?=|^\/.+\/[gimsuy]*$/.test(t);

/**
 * Failures of one value against one rule. `unique` is a column rule and is ignored here.
 * A string with no rule words in it ("POST", "Ann Smith") means "equals that value".
 */
export function checkRule(value: unknown, rule: unknown): string[] {
  if (typeof rule !== 'string' || !ruleTokens(rule).some(isRuleToken)) {
    return sameValue(rule, value, { ignoreCase: false }) ? [] : [`expected ${show(rule)}, got ${show(value)}`];
  }
  const fails: string[] = [];
  const tokens = ruleTokens(rule);
  const empty = isEmpty(value);
  if (tokens.includes('required') && (value === undefined || value === null)) { return ['is missing (required)']; }
  if (tokens.includes('not_empty') && empty) { return [`is empty (${show(value)})`]; }
  // Optional fields: other rules only apply when there is a value.
  if (value === undefined || value === null) { return tokens.some((t) => t.startsWith('=') && !t.startsWith('==')) ? [`expected ${tokens.find((t) => t.startsWith('='))!.slice(1)}, got ${show(value)}`] : []; }
  const num = parseNumber(value)?.n;
  for (const t of tokens) {
    if (t === 'required' || t === 'not_empty' || t === 'unique' || t === 'optional') { continue; }
    if (TYPE_CHECKS[t]) { if (!TYPE_CHECKS[t](value)) { fails.push(`is not ${/^[aeiou]/.test(t) ? 'an' : 'a'} ${t} (${show(value)})`); } continue; }
    let m: RegExpExecArray | null;
    if ((m = /^(>=|<=|>|<)(-?\d+(?:\.\d+)?)$/.exec(t))) {
      const lim = Number(m[2]);
      if (num === undefined) { fails.push(`is not a number (${show(value)}), so ${t} cannot hold`); continue; }
      const ok = m[1] === '>=' ? num >= lim : m[1] === '<=' ? num <= lim : m[1] === '>' ? num > lim : num < lim;
      if (!ok) { fails.push(`${num} is not ${t}`); }
      continue;
    }
    if ((m = /^(min_len|max_len):(\d+)$/.exec(t))) {
      const len = typeof value === 'string' || Array.isArray(value) ? value.length : String(value).length;
      if (m[1] === 'min_len' ? len < Number(m[2]) : len > Number(m[2])) { fails.push(`length ${len} breaks ${t}`); }
      continue;
    }
    if ((m = /^one_of:"?(.*?)"?$/.exec(t))) {
      const opts = m[1].split('|');
      if (!opts.some((o) => sameValue(o, value))) { fails.push(`${show(value)} is not one of ${opts.join(', ')}`); }
      continue;
    }
    if ((m = /^contains:"?(.*?)"?$/.exec(t))) { if (!String(typeof value === 'object' ? JSON.stringify(value) : value).toLowerCase().includes(m[1].toLowerCase())) { fails.push(`does not contain "${m[1]}"`); } continue; }
    if ((m = /^!=(?:"(.*)"|(.*))$/.exec(t))) { if (sameValue(m[1] ?? m[2], value)) { fails.push(`must not be ${m[1] ?? m[2]}`); } continue; }
    if ((m = /^=(?:"(.*)"|(.*))$/.exec(t))) { if (!sameValue(m[1] ?? m[2], value)) { fails.push(`expected ${m[1] ?? m[2]}, got ${show(value)}`); } continue; }
    if ((m = /^\/(.+)\/([gimsuy]*)$/.exec(t))) {
      let re: RegExp;
      try { re = new RegExp(m[1], m[2].replace('g', '')); } catch { fails.push(`bad regex ${t}`); continue; }
      if (!re.test(String(value))) { fails.push(`${show(value)} does not match ${t}`); }
      continue;
    }
    fails.push(`unknown rule "${t}" (${RULE_HELP})`);
  }
  return fails;
}

export interface RuleReport { field: string; rule: string; failed: number; total: number; samples: string[] }

/** Applies field rules to every row; "unique" checks the whole column. Field names may be JSON paths. */
export function validateRows(rows: Row[], rules: Record<string, unknown>, keyField?: string): RuleReport[] {
  const out: RuleReport[] = [];
  for (const [field, rule] of Object.entries(rules)) {
    const r: RuleReport = { field, rule: typeof rule === 'string' ? rule : `= ${show(rule)}`, failed: 0, total: rows.length, samples: [] };
    const seen = new Map<string, number>();
    rows.forEach((row, i) => {
      const v = field.includes('.') || field.includes('[') ? getPath(row, field) : findField(row, field);
      const label = keyField && row[keyField] !== undefined ? `${keyField}=${show(row[keyField])}` : `row ${i + 1}`;
      const fails = checkRule(v, rule);
      if (typeof rule === 'string' && ruleTokens(rule).includes('unique') && !isEmpty(v)) {
        const k = JSON.stringify(typeof v === 'string' ? v.trim().toLowerCase() : v);
        if (seen.has(k)) { fails.push(`duplicate of row ${seen.get(k)! + 1} (${show(v)})`); } else { seen.set(k, i); }
      }
      if (fails.length) { r.failed++; if (r.samples.length < 5) { r.samples.push(`${label}: ${fails.join('; ')}`); } }
    });
    out.push(r);
  }
  return out;
}

/* ------------------------------------------------------------------ row comparison */

/** "User Name", "user_name" and "userName" are the same column. */
export const fieldKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

function findField(row: Row, name: string): unknown {
  if (name in row) { return row[name]; }
  const k = fieldKey(name);
  const hit = Object.keys(row).find((f) => fieldKey(f) === k);
  return hit === undefined ? undefined : row[hit];
}

export interface CompareRowsOptions extends CompareOptions {
  /** Field(s) that identify a row (expected-side names). Default: an "id" column when both sides have one. */
  key?: string[];
  /** Expected-side field names to compare. Default: every field the two sides share. */
  fields?: string[];
  /** Expected field → actual field, for columns whose names differ beyond case and punctuation. */
  map?: Record<string, string>;
  /** Without a key, compare rows in order (true) or match identical rows wherever they are (false, default). */
  ordered?: boolean;
  maxReport?: number;
}

export interface CellDiff { row: string; field: string; expected: unknown; actual: unknown }
export interface CompareResult {
  expectedCount: number; actualCount: number; matchedBy: string; fields: string[];
  onlyInExpected: string[]; onlyInActual: string[];
  missing: string[]; extra: string[]; diffs: CellDiff[]; diffRows: number; equalRows: number;
  duplicateKeys: string[]; unmappedExpected: string[]; unmappedActual: string[]; orderMismatch?: boolean;
}

export function compareRows(expected: Row[], actual: Row[], o: CompareRowsOptions = {}): CompareResult {
  const eFields = [...new Set(expected.flatMap((r) => Object.keys(r)))];
  const aFields = [...new Set(actual.flatMap((r) => Object.keys(r)))];
  const map: Record<string, string> = {};
  const aByKey = new Map(aFields.map((f) => [fieldKey(f), f]));
  for (const f of eFields) {
    const explicit = o.map?.[f];
    if (explicit !== undefined) { map[f] = explicit; continue; }
    const hit = aFields.includes(f) ? f : aByKey.get(fieldKey(f));
    if (hit !== undefined) { map[f] = hit; }
  }
  for (const [e, a] of Object.entries(o.map ?? {})) { map[e] = a; }
  const fields = (o.fields?.length ? o.fields : Object.keys(map)).filter((f) => map[f] !== undefined || o.fields?.includes(f));
  const unmappedExpected = eFields.filter((f) => map[f] === undefined);
  const mappedActual = new Set(Object.values(map));
  const unmappedActual = aFields.filter((f) => !mappedActual.has(f));

  let key = o.key?.filter(Boolean);
  if (!key?.length) {
    const id = eFields.find((f) => /^(id|_id|uuid|key|code)$/i.test(f) && map[f] !== undefined);
    if (id && new Set(expected.map((r) => JSON.stringify(r[id]))).size === expected.length) { key = [id]; }
  }
  const val = (row: Row, eField: string, side: 'e' | 'a') => (side === 'e' ? findField(row, eField) : findField(row, map[eField] ?? eField));
  const norm = (v: unknown) => { if (isEmpty(v)) { return ''; } const n = parseNumber(v); if (n) { return String(n.n); } return String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/\s+/g, ' ').trim().toLowerCase(); };
  const keyOf = (row: Row, side: 'e' | 'a') => key!.map((k) => norm(val(row, k, side))).join(' | ');
  // Key values read from CSV files and pages are strings: "id=2" reads better than id="2".
  const keyText = (v: unknown) => (typeof v === 'string' && v.trim() && !/[,=]/.test(v) ? (v.length > 60 ? `${v.slice(0, 59)}…` : v.trim()) : show(v));
  const label = (row: Row, idx: number, side: 'e' | 'a' = 'e') => (key?.length ? key.map((k) => `${k}=${keyText(val(row, k, side))}`).join(', ') : `row ${idx + 1}`);
  const brief = (row: Row) => { const s = JSON.stringify(row); return s.length > 160 ? `${s.slice(0, 159)}…` : s; };

  const res: CompareResult = {
    expectedCount: expected.length, actualCount: actual.length, fields, onlyInExpected: [], onlyInActual: [],
    matchedBy: key?.length ? `key ${key.join(' + ')}` : o.ordered ? 'position' : 'content (no key)',
    missing: [], extra: [], diffs: [], diffRows: 0, equalRows: 0, duplicateKeys: [], unmappedExpected, unmappedActual,
  };
  const maxReport = o.maxReport ?? 50;
  const diffRow = (e: Row, a: Row, lbl: string) => {
    let bad = false;
    for (const f of fields) {
      const ev = val(e, f, 'e'), av = val(a, f, 'a');
      if (!sameValue(ev, av, o)) { bad = true; if (res.diffs.length < maxReport) { res.diffs.push({ row: lbl, field: f, expected: ev, actual: av }); } }
    }
    if (bad) { res.diffRows++; } else { res.equalRows++; }
  };

  if (key?.length) {
    const aIndex = new Map<string, Row>();
    actual.forEach((r) => { const k = keyOf(r, 'a'); if (aIndex.has(k)) { res.duplicateKeys.push(`actual: ${k}`); } else { aIndex.set(k, r); } });
    const seenE = new Set<string>();
    const eOrder: string[] = [];
    expected.forEach((e, i) => {
      const k = keyOf(e, 'e');
      if (seenE.has(k)) { res.duplicateKeys.push(`expected: ${k}`); return; }
      seenE.add(k);
      const a = aIndex.get(k);
      if (!a) { if (res.missing.length < maxReport) { res.missing.push(label(e, i)); } else { res.missing.push(''); } return; }
      eOrder.push(k);
      aIndex.delete(k);
      diffRow(e, a, label(e, i));
    });
    for (const a of aIndex.values()) { res.extra.push(label(a, 0, 'a')); }
    const aOrder = actual.map((r) => keyOf(r, 'a')).filter((k) => seenE.has(k));
    res.orderMismatch = eOrder.join('\n') !== aOrder.filter((k, i, arr) => arr.indexOf(k) === i).join('\n') ? true : undefined;
  } else if (o.ordered) {
    const n = Math.max(expected.length, actual.length);
    for (let i = 0; i < n; i++) {
      if (i >= actual.length) { res.missing.push(`row ${i + 1}: ${brief(expected[i])}`); continue; }
      if (i >= expected.length) { res.extra.push(`row ${i + 1}: ${brief(actual[i])}`); continue; }
      diffRow(expected[i], actual[i], `row ${i + 1}`);
    }
  } else {
    // No key: rows that are equal on every compared field pair up; the rest pair in order and show their differences.
    const left = actual.map((a, i) => ({ a, i }));
    const unmatched: Array<{ e: Row; i: number }> = [];
    expected.forEach((e, i) => {
      const j = left.findIndex(({ a }) => fields.every((f) => sameValue(val(e, f, 'e'), val(a, f, 'a'), o)));
      if (j >= 0) { left.splice(j, 1); res.equalRows++; } else { unmatched.push({ e, i }); }
    });
    unmatched.forEach(({ e, i }, n) => {
      const a = left[n];
      if (a) { diffRow(e, a.a, `row ${i + 1} vs actual row ${a.i + 1}`); } else { res.missing.push(`row ${i + 1}: ${brief(e)}`); }
    });
    for (const a of left.slice(unmatched.length)) { res.extra.push(`row ${a.i + 1}: ${brief(a.a)}`); }
  }
  res.missing = res.missing.filter(Boolean);
  return res;
}

export function formatCompare(r: CompareResult, names: { expected: string; actual: string }, maxLines = 120): string {
  const ok = !r.missing.length && !r.extra.length && !r.diffRows && !r.duplicateKeys.length;
  const out: string[] = [];
  out.push(`${ok ? '✔ MATCH' : '✘ MISMATCH'}: expected (${names.expected}) has ${r.expectedCount} row(s), actual (${names.actual}) has ${r.actualCount}. Rows matched by ${r.matchedBy}.`);
  out.push(`Compared fields: ${r.fields.join(', ') || '(none in common: use "map" or "fields")'}`);
  out.push(`Equal rows: ${r.equalRows} · rows with wrong values: ${r.diffRows} · missing: ${r.missing.length} · extra: ${r.extra.length}${r.duplicateKeys.length ? ` · duplicate keys: ${r.duplicateKeys.length}` : ''}`);
  if (r.diffs.length) {
    out.push('', 'Wrong values (row · field: expected → actual):');
    for (const d of r.diffs) { out.push(`  ✘ ${d.row} · ${d.field}: ${show(d.expected)} → ${show(d.actual)}`); }
    if (r.diffRows > 0 && r.diffs.length >= 50) { out.push('  … (more differences not shown)'); }
  }
  if (r.missing.length) { out.push('', `Missing from actual (${r.missing.length}):`, ...r.missing.slice(0, 30).map((m) => `  ✘ ${m}`)); }
  if (r.extra.length) { out.push('', `Extra in actual, not expected (${r.extra.length}):`, ...r.extra.slice(0, 30).map((m) => `  ✘ ${m}`)); }
  if (r.duplicateKeys.length) { out.push('', 'Duplicate keys:', ...r.duplicateKeys.slice(0, 10).map((d) => `  ⚠ ${d}`)); }
  if (r.orderMismatch) { out.push('', '⚠ The rows are in a different order (check sorting if order matters).'); }
  if (r.unmappedExpected.length) { out.push('', `Not compared — only in expected: ${r.unmappedExpected.join(', ')}`); }
  if (r.unmappedActual.length) { out.push(`Not compared — only in actual: ${r.unmappedActual.join(', ')}`); }
  return out.slice(0, maxLines).join('\n');
}

export function formatRules(reports: RuleReport[]): string {
  const bad = reports.filter((r) => r.failed);
  const lines = [`${bad.length ? '✘' : '✔'} Rules: ${reports.length - bad.length}/${reports.length} passed`];
  for (const r of reports) {
    lines.push(`  ${r.failed ? '✘' : '✔'} ${r.field}: ${r.rule}${r.failed ? ` — ${r.failed} of ${r.total} row(s) fail` : ''}`);
    for (const s of r.samples) { lines.push(`      ${s}`); }
  }
  return lines.join('\n');
}
