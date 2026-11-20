/**
 * HTML → Markdown without dependencies.
 *
 * A small forgiving tokenizer and tree builder (enough of the HTML parsing rules to survive real pages:
 * implied end tags, void and raw-text elements, stray end tags, unterminated quotes) followed by
 * Readability-style main-content selection and a Markdown renderer. Hidden elements are dropped and
 * counted because invisible text is the classic prompt-injection carrier. Everything is linear-ish:
 * nesting is capped and stack searches are bounded, so hostile input cannot make it hang.
 */
import { DocImage, DocLink, ExtractedDoc } from '../types';
import { detectInjection, sanitizeText } from './injection';

/* ------------------------------------------------------------------ tree */

export interface MElement { type: 'el'; tag: string; attrs: Record<string, string>; children: MNode[] }
export interface MText { type: 'text'; text: string }
export type MNode = MElement | MText;

/* ------------------------------------------------------------------ entities */

/** Windows-1252 code points for bytes 0x80–0x9F (also used for numeric references in that range). */
export const CP1252_HIGH: readonly number[] = [
  0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
  0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178,
];

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', AMP: '&', LT: '<', GT: '>', QUOT: '"',
  copy: '©', COPY: '©', reg: '®', REG: '®', trade: '™', TRADE: '™', mdash: '—', ndash: '–', hellip: '…', mldr: '…',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  prime: '′', Prime: '″', times: '×', divide: '÷', plusmn: '±', minus: '−', ne: '≠', le: '≤', ge: '≥', asymp: '≈',
  equiv: '≡', infin: '∞', sum: '∑', prod: '∏', radic: '√', part: '∂', int: '∫', nabla: '∇', isin: '∈', notin: '∉',
  forall: '∀', exist: '∃', empty: '∅', and: '∧', or: '∨', cap: '∩', cup: '∪', sub: '⊂', sup: '⊃', sube: '⊆', supe: '⊇',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤', deg: '°', micro: 'µ', para: '¶', sect: '§', middot: '·',
  bull: '•', dagger: '†', Dagger: '‡', permil: '‰', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', lArr: '⇐',
  rArr: '⇒', hArr: '⇔', uArr: '⇑', dArr: '⇓', crarr: '↵', spades: '♠', clubs: '♣', hearts: '♥', diams: '♦', loz: '◊',
  iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º', not: '¬', shy: '­', macr: '¯', acute: '´', cedil: '¸', uml: '¨',
  sup1: '¹', sup2: '²', sup3: '³', frac14: '¼', frac12: '½', frac34: '¾', brvbar: '¦', ensp: ' ', emsp: ' ',
  thinsp: ' ', zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏', oline: '‾', frasl: '⁄', fnof: 'ƒ', circ: 'ˆ', tilde: '˜',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É',
  Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', ETH: 'Ð', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó',
  Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', THORN: 'Þ',
  szlig: 'ß', agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è',
  eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', eth: 'ð', ntilde: 'ñ', ograve: 'ò',
  oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý',
  thorn: 'þ', yuml: 'ÿ', Yuml: 'Ÿ', OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigma: 'σ', sigmaf: 'ς', tau: 'τ', upsilon: 'υ',
  phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', check: '✓', star: '☆', starf: '★', hyphen: '‐', dash: '‐', Tab: '\t', NewLine: '\n',
};

/** Legacy entities browsers also accept without the trailing semicolon. */
const LEGACY = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg', 'AMP', 'LT', 'GT', 'QUOT', 'COPY', 'REG', 'deg', 'times', 'middot']);

function fromCodePoint(cp: number): string {
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) { return '�'; }
  if (cp >= 0x80 && cp <= 0x9F) { return String.fromCodePoint(CP1252_HIGH[cp - 0x80]); }
  return String.fromCodePoint(cp);
}

const ENTITY_RE = /&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}))(;?)/g;

/** Decodes named and numeric character references. In attributes, semicolon-less names before = or alnum stay literal. */
export function decodeEntities(s: string, inAttr = false): string {
  if (s.indexOf('&') < 0) { return s; }
  return s.replace(ENTITY_RE, (m: string, dec: string, hex: string, name: string, semi: string, off: number, str: string) => {
    if (dec) { return fromCodePoint(parseInt(dec, 10)); }
    if (hex) { return fromCodePoint(parseInt(hex, 16)); }
    const ch = ENTITIES[name];
    if (ch === undefined) { return m; }
    if (!semi) {
      if (!LEGACY.has(name)) { return m; }
      const next = str[off + m.length];
      if (inAttr && next !== undefined && /[=A-Za-z0-9]/.test(next)) { return m; }
    }
    return ch;
  });
}

/* ------------------------------------------------------------------ tokenizer + tree builder */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen', 'basefont', 'frame']);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
const RCDATA = new Set(['textarea', 'title']);
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'ul', 'li', 'dd', 'dt', 'center', 'listing', 'summary',
]);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const TABLE_PARTS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup']);
const P_STOPS = new Set(['button', 'table', 'td', 'th', 'caption', 'template', 'object', 'marquee', 'applet']);
const LIST_STOPS = new Set(['ul', 'ol', 'menu', 'table', 'td', 'th', 'template']);
const DL_STOPS = new Set(['dl', 'table', 'td', 'th', 'template']);
const CELL_STOPS = new Set(['tr', 'table', 'template']);
const ROW_STOPS = new Set(['table', 'thead', 'tbody', 'tfoot', 'template']);
const SECTION_STOPS = new Set(['table', 'template']);
const CELL_BOUNDARY = new Set(['td', 'th', 'caption', 'table', 'template']);
const A_STOPS = new Set(['table', 'td', 'th', 'template']);

/** Deeper nesting is flattened: it keeps the renderer's recursion safe on hostile pages. */
const MAX_DEPTH = 400;
/** Element budget: past it, further tags are ignored and their text is kept flat, which bounds the work on huge pages. */
export const MAX_ELEMENTS = 60_000;
/** Root attribute set when the element budget was exhausted. */
export const FLATTENED = 'data-flattened';
/** How far an end tag or implied close may search the open-element stack. */
const MAX_SEARCH = 128;

/** Length of the longest run of `ch` in `s` (at least `min`); no array spread, so huge inputs cannot overflow the stack. */
export function longestRun(s: string, ch: string, min: number): number {
  let best = min;
  let run = 0;
  for (let i = s.indexOf(ch); i >= 0 && i < s.length; i++) {
    if (s[i] === ch) { run++; if (run > best) { best = run; } continue; }
    run = 0;
    i = s.indexOf(ch, i) - 1;
    if (i < 0) { break; }
  }
  return best;
}

const isWs = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const rawEndCache = new Map<string, RegExp>();

/** The end tag of a raw-text element (script, style…) at or after `from`. */
function rawEnd(src: string, name: string, from: number): RegExpExecArray | null {
  let re = rawEndCache.get(name);
  if (!re) { re = new RegExp(`</${name}(?=[\\s/>]|$)`, 'gi'); rawEndCache.set(name, re); }
  re.lastIndex = from;
  return re.exec(src);
}

/** Index just past the end tag of a raw-text element whose content starts at `from`. */
function skipRaw(src: string, name: string, from: number): number {
  const m = rawEnd(src, name, from);
  const gt = m ? src.indexOf('>', m.index) : -1;
  return gt < 0 ? src.length : gt + 1;
}

/** Parses HTML (or, with `xml`, XML: case-folded names, no HTML implied-end or raw-text rules) into a tree. */
export function parseMarkup(src: string, xml = false): MElement {
  const root: MElement = { type: 'el', tag: '#root', attrs: Object.create(null), children: [] };
  const stack: MElement[] = [root];
  const open = new Map<string, number>();
  const n = src.length;
  let i = 0;
  let elements = 0;
  const top = () => stack[stack.length - 1];
  const addText = (t: string) => {
    if (!t) { return; }
    const kids = top().children;
    const last = kids[kids.length - 1];
    if (last && last.type === 'text') { last.text += t; } else { kids.push({ type: 'text', text: t }); }
  };
  const pop = () => { const el = stack.pop()!; open.set(el.tag, (open.get(el.tag) ?? 1) - 1); };
  const push = (el: MElement) => { stack.push(el); open.set(el.tag, (open.get(el.tag) ?? 0) + 1); };
  /** Closes the nearest open `tag` if it is reached before any element in `stops`. */
  const closeIfOpen = (tag: string, stops: Set<string>) => {
    if (!open.get(tag)) { return; }
    for (let k = stack.length - 1, lim = Math.max(1, stack.length - MAX_SEARCH); k >= lim; k--) {
      const t = stack[k].tag;
      if (t === tag) { while (stack.length > k) { pop(); } return; }
      if (stops.has(t)) { return; }
    }
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { addText(decodeEntities(src.slice(i))); break; }
    if (lt > i) { addText(decodeEntities(src.slice(i, lt))); }
    i = lt;
    const c1 = src.charCodeAt(i + 1);
    if (c1 === 33 /* ! */) {
      if (src.startsWith('<!--', i)) {
        const e = src.indexOf('-->', i + 4);
        i = e < 0 ? n : e + 3;
      } else if (src.startsWith('<![CDATA[', i)) {
        const e = src.indexOf(']]>', i + 9);
        addText(src.slice(i + 9, e < 0 ? n : e));
        i = e < 0 ? n : e + 3;
      } else {
        const e = src.indexOf('>', i + 2);
        i = e < 0 ? n : e + 1;
      }
      continue;
    }
    if (c1 === 63 /* ? */) { const e = src.indexOf('>', i + 2); i = e < 0 ? n : e + 1; continue; }
    if (c1 === 47 /* / */) {
      if (!isAlpha(src.charCodeAt(i + 2))) { const e = src.indexOf('>', i + 2); i = e < 0 ? n : e + 1; continue; }
      let j = i + 2;
      while (j < n) { const c = src.charCodeAt(j); if (isWs(c) || c === 62 || c === 47) { break; } j++; }
      const name = src.slice(i + 2, j).toLowerCase();
      const e = src.indexOf('>', j);
      i = e < 0 ? n : e + 1;
      if (!xml && name === 'br') { if (stack.length <= MAX_DEPTH) { top().children.push(el('br')); } continue; }
      if (!open.get(name)) { continue; }
      const boundary = xml ? undefined : name === 'table' ? undefined : TABLE_PARTS.has(name) ? SECTION_STOPS : CELL_BOUNDARY;
      for (let k = stack.length - 1, lim = Math.max(1, stack.length - MAX_SEARCH); k >= lim; k--) {
        const t = stack[k].tag;
        if (t === name) { while (stack.length > k) { pop(); } break; }
        if (boundary?.has(t)) { break; }
      }
      continue;
    }
    if (!isAlpha(c1)) { addText('<'); i++; continue; }

    // start tag
    let j = i + 1;
    while (j < n) { const c = src.charCodeAt(j); if (isWs(c) || c === 62 || c === 47) { break; } j++; }
    const name = src.slice(i + 1, j).toLowerCase();
    const attrs: Record<string, string> = Object.create(null);
    let selfClose = false;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 62) { j++; break; }
      if (isWs(c)) { j++; continue; }
      if (c === 47) { if (src.charCodeAt(j + 1) === 62) { selfClose = true; j += 2; break; } j++; continue; }
      let k = j;
      while (k < n) { const d = src.charCodeAt(k); if (isWs(d) || d === 61 || d === 62 || d === 47) { break; } k++; }
      if (k === j) { k++; }
      const an = src.slice(j, k).toLowerCase();
      j = k;
      while (j < n && isWs(src.charCodeAt(j))) { j++; }
      let val = '';
      if (src.charCodeAt(j) === 61) {
        j++;
        while (j < n && isWs(src.charCodeAt(j))) { j++; }
        const q = src[j];
        if (q === '"' || q === "'") {
          const e = src.indexOf(q, j + 1);
          if (e < 0) {
            const g = src.indexOf('>', j + 1);
            const end = g < 0 ? n : g;
            val = src.slice(j + 1, end);
            j = end;
          } else { val = src.slice(j + 1, e); j = e + 1; }
        } else {
          let e = j;
          while (e < n) { const d = src.charCodeAt(e); if (isWs(d) || d === 62) { break; } e++; }
          val = src.slice(j, e);
          j = e;
        }
      }
      if (an && !(an in attrs)) { attrs[an] = decodeEntities(val, true); }
    }
    i = j;
    const node: MElement = { type: 'el', tag: name, attrs, children: [] };
    const full = elements >= MAX_ELEMENTS;
    if (full) { root.attrs[FLATTENED] = '1'; }

    if (!xml) {
      if (full) {
        // Past the element budget tags are dropped (their text stays), but raw-text content must still be skipped.
        if (RAW.has(name) && !selfClose && name !== 'plaintext') { i = skipRaw(src, name, i); }
        continue;
      }
      if (CLOSES_P.has(name)) { closeIfOpen('p', P_STOPS); }
      if (name === 'li') { closeIfOpen('li', LIST_STOPS); }
      else if (name === 'dt' || name === 'dd') { closeIfOpen('dt', DL_STOPS); closeIfOpen('dd', DL_STOPS); }
      else if (HEADINGS.has(name) && HEADINGS.has(top().tag)) { pop(); }
      else if (name === 'tr') { closeIfOpen('tr', ROW_STOPS); }
      else if (name === 'td' || name === 'th') { closeIfOpen('td', CELL_STOPS); closeIfOpen('th', CELL_STOPS); }
      else if (name === 'thead' || name === 'tbody' || name === 'tfoot') { for (const t of ['thead', 'tbody', 'tfoot']) { closeIfOpen(t, SECTION_STOPS); } }
      else if (name === 'option' || name === 'optgroup') { if (top().tag === 'option') { pop(); } }
      else if (name === 'a') { closeIfOpen('a', A_STOPS); }

      if (RAW.has(name) && !selfClose) {
        const m = name === 'plaintext' ? null : rawEnd(src, name, i);
        const end = m ? m.index : n;
        const content = src.slice(i, end);
        if (content) { node.children.push({ type: 'text', text: RCDATA.has(name) ? decodeEntities(content) : content }); }
        top().children.push(node);
        const gt = m ? src.indexOf('>', end) : -1;
        i = gt < 0 ? n : gt + 1;
        elements++;
        continue;
      }
      if (VOID.has(name)) { top().children.push(node); elements++; continue; }
    } else if (full) { continue; }
    if (selfClose) { top().children.push(node); elements++; continue; }
    if (stack.length > MAX_DEPTH) { continue; }
    top().children.push(node);
    push(node);
    elements++;
  }
  return root;
}

function el(tag: string): MElement { return { type: 'el', tag, attrs: Object.create(null), children: [] }; }

/* ------------------------------------------------------------------ tree helpers */

export function attr(e: MElement, name: string): string { return e.attrs[name] ?? ''; }

/** Concatenated text of a subtree; `skip` prunes subtrees. */
export function textOf(e: MNode, skip?: (e: MElement) => boolean): string {
  if (e.type === 'text') { return e.text; }
  if (skip?.(e)) { return ''; }
  let s = '';
  for (const c of e.children) { s += c.type === 'text' ? c.text : textOf(c, skip); }
  return s;
}

/** Depth-first search for elements matching `pred` (does not descend into matches when `stopAtMatch`). */
export function findAll(e: MElement, pred: (e: MElement) => boolean, stopAtMatch = false, out: MElement[] = []): MElement[] {
  for (const c of e.children) {
    if (c.type !== 'el') { continue; }
    const hit = pred(c);
    if (hit) { out.push(c); }
    if (!(hit && stopAtMatch)) { findAll(c, pred, stopAtMatch, out); }
  }
  return out;
}

export function findFirst(e: MElement, pred: (e: MElement) => boolean): MElement | undefined {
  for (const c of e.children) {
    if (c.type !== 'el') { continue; }
    if (pred(c)) { return c; }
    const r = findFirst(c, pred);
    if (r) { return r; }
  }
  return undefined;
}

/** Browser-like whitespace collapsing (no-break spaces survive). */
export const collapse = (s: string) => s.replace(/[ \t\n\r\f]+/g, ' ');

export function resolveUrl(href: string, base: string): string | undefined {
  const h = href.trim();
  if (!h) { return undefined; }
  try { return new URL(h, base || undefined).href; } catch { return undefined; }
}

/** ISO-ish date: keeps ISO strings as stated, converts other parseable dates to ISO. */
export function isoDate(s: string | undefined): string | undefined {
  const t = s?.trim();
  if (!t) { return undefined; }
  if (/^\d{4}-\d{2}(-\d{2})?([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(t)) { return t; }
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/* ------------------------------------------------------------------ visibility and boilerplate */

const DROP = new Set([
  'head', 'title', 'meta', 'link', 'base', 'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object',
  'embed', 'input', 'select', 'button', 'textarea', 'option', 'optgroup', 'datalist', 'audio', 'video', 'map', 'frameset',
  'noembed', 'noframes', 'param', 'source', 'track', 'math',
]);
const HIDDEN_CLASS = /(?:^|\s)(?:sr-only|visually-hidden|visuallyhidden|screen-reader-text|screen-reader-only|element-invisible)(?:\s|$)/i;
const HIDDEN_STYLE = /display:none|visibility:hidden|font-size:0(?:\.0+)?(?:px|em|rem|pt|%)?(?:;|!|$)|opacity:0(?:\.0+)?(?:;|!|$)|(?:left|top|right|text-indent|margin-left):-\d{4,}|clip:rect\(0(?:px)?,?0(?:px)?,?0|(?:width|height):0(?:px)?;(?:[^;]*;){0,8}overflow:hidden|transform:scale\(0\)/;

function isHidden(e: MElement): boolean {
  if ('hidden' in e.attrs) { return true; }
  if (e.attrs['aria-hidden']?.trim().toLowerCase() === 'true') { return true; }
  const style = e.attrs.style;
  if (style && HIDDEN_STYLE.test(style.toLowerCase().replace(/\s+/g, ''))) { return true; }
  const cls = e.attrs.class;
  if (cls && HIDDEN_CLASS.test(cls)) { return true; }
  return e.tag === 'dialog' && !('open' in e.attrs);
}

const BOILER = new Set(['nav', 'footer', 'aside', 'dialog']);
const BOILER_ROLES = new Set(['navigation', 'contentinfo', 'complementary', 'search', 'dialog', 'alertdialog', 'menu', 'menubar', 'toolbar']);
const NOISE_TAGS = new Set(['div', 'section', 'ul', 'ol', 'dl', 'table', 'form', 'aside', 'header', 'footer', 'span', 'p', 'figure', 'nav']);
/** Always boilerplate. */
const NOISE_STRONG = /(?:^|[\s_-])(?:cookies?|consent|gdpr|newsletter|advert\w*|sponsor\w*|share|sharing|social|breadcrumbs?|ad|ads|adsense|promo)(?:$|[\s_-])/i;
/** Boilerplate unless the name also says it is content (e.g. "has-sidebar main-content"). */
const NOISE_WEAK = /(?:^|[\s_-])(?:banner|popup|modal|subscribe|subscription|related|sidebar|comments?|disqus|widget|outbrain|taboola)(?:$|[\s_-])/i;
const POSITIVE = /(?:^|[\s_-])(?:article|content|main|post|entry|story|body|text|column)(?:$|[\s_-])/i;

function isBoilerplate(e: MElement, inMain: boolean): boolean {
  if (BOILER.has(e.tag)) { return true; }
  if (e.tag === 'header' && !inMain) { return true; }
  const role = e.attrs.role?.toLowerCase();
  if (role && (BOILER_ROLES.has(role) || (role === 'banner' && !inMain))) { return true; }
  if (!NOISE_TAGS.has(e.tag)) { return false; }
  const names = `${e.attrs.class ?? ''} ${e.attrs.id ?? ''}`.trim();
  if (!names) { return false; }
  return NOISE_STRONG.test(names) || (NOISE_WEAK.test(names) && !POSITIVE.test(names));
}

/** Removes non-rendered and hidden subtrees in place; returns how many visible-looking characters were hidden. */
function prune(e: MElement): number {
  let hidden = 0;
  const out: MNode[] = [];
  for (const c of e.children) {
    if (c.type === 'text') { out.push(c); continue; }
    if (DROP.has(c.tag)) { continue; }
    if (isHidden(c)) { hidden += collapse(textOf(c, (x) => DROP.has(x.tag))).trim().length; continue; }
    hidden += prune(c);
    out.push(c);
  }
  e.children = out;
  return hidden;
}

/* ------------------------------------------------------------------ main content */

interface Metrics { text: number; link: number }

function measure(e: MElement, inMain: boolean, m: Map<MElement, Metrics>, inLink = false): Metrics {
  let text = 0;
  let link = 0;
  const main = inMain || e.tag === 'article' || e.tag === 'main';
  const isLink = inLink || e.tag === 'a';
  for (const c of e.children) {
    if (c.type === 'text') {
      const len = collapse(c.text).trim().length;
      text += len;
      if (isLink) { link += len; }
      continue;
    }
    if (isBoilerplate(c, main)) { continue; }
    const r = measure(c, main, m, isLink);
    text += r.text;
    link += r.link;
  }
  const r = { text, link };
  m.set(e, r);
  return r;
}

const SCORE_TAGS = new Set(['p', 'pre', 'td', 'blockquote', 'dd', 'li', 'h2', 'h3']);
/** Elements that can be chosen as the main-content root by the density score. */
const CANDIDATES = new Set(['div', 'section', 'article', 'main', 'td', 'center', 'blockquote', 'form', 'font']);
/** Scoring only needs a paragraph's first few hundred characters; bounding it keeps nested paragraphs linear. */
const SCORE_TEXT = 2000;

/** Text of a subtree, stopping once `max` characters are collected. */
function boundedText(e: MElement, max: number): string {
  let s = '';
  const visit = (n: MNode): void => {
    if (n.type === 'text') { s += n.text.length > max ? n.text.slice(0, max) : n.text; return; }
    for (const c of n.children) { if (s.length >= max) { return; } visit(c); }
  };
  visit(e);
  return s;
}

/** Picks the element holding the main content: <article>, then <main>, then a Readability-like density winner. */
function selectMain(body: MElement): { root: MElement; inMain: boolean } {
  const m = new Map<MElement, Metrics>();
  const total = measure(body, false, m).text;
  const len = (e: MElement) => m.get(e)?.text ?? 0;
  const articles = findAll(body, (e) => e.tag === 'article' && m.has(e));
  if (articles.length) {
    const best = articles.reduce((a, b) => (len(b) > len(a) ? b : a));
    if (len(best) > 0 && len(best) >= total * 0.25) { return { root: best, inMain: true }; }
  }
  const main = findAll(body, (e) => (e.tag === 'main' || e.attrs.role === 'main') && m.has(e)).find((e) => len(e) > 0);
  if (main && len(main) >= total * 0.25) { return { root: main, inMain: true }; }

  const scores = new Map<MElement, number>();
  // Only containers may win: an inline <code> or <span> with long text is part of the content, not the content root.
  const add = (e: MElement | undefined, s: number) => { if (e && e !== body && CANDIDATES.has(e.tag)) { scores.set(e, (scores.get(e) ?? 0) + s); } };
  const walk = (e: MElement, parent: MElement | undefined, grand: MElement | undefined) => {
    let direct = '';
    for (const c of e.children) {
      if (c.type === 'text') { direct += c.text; continue; }
      if (!m.has(c)) { continue; }
      walk(c, e, parent);
    }
    const own = SCORE_TAGS.has(e.tag) ? boundedText(e, SCORE_TEXT) : direct;
    const t = collapse(own).trim();
    const met = m.get(e)!;
    if (t.length < 25 || met.link > met.text * 0.5) { return; }
    const s = 1 + (t.match(/,/g)?.length ?? 0) + Math.min(Math.floor(t.length / 100), 3);
    if (SCORE_TAGS.has(e.tag)) { add(parent, s); add(grand, s / 2); } else { add(e, s); add(parent, s / 2); }
  };
  walk(body, undefined, undefined);
  let best: MElement | undefined;
  let bestScore = 0;
  for (const [e, s] of scores) {
    const met = m.get(e)!;
    const score = s * (1 - (met.text ? met.link / met.text : 0));
    if (score > bestScore) { bestScore = score; best = e; }
  }
  if (best && len(best) >= total * 0.4) { return { root: best, inMain: false }; }
  return { root: body, inMain: false };
}

/* ------------------------------------------------------------------ Markdown rendering */

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'center', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html',
  'legend', 'li', 'listing', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'caption', 'ul', 'xmp', 'picture-block', '#root',
]);
/** Private-use placeholder for <br> so whitespace collapsing cannot eat the line break. */
const BR = '';

interface Ctx {
  base: string; links: DocLink[]; images: DocImage[]; inMain: boolean; seenImages: Set<string>;
  /** Link URLs already listed (links are unique and capped while rendering, not afterwards). */
  linkSeen: Set<string>;
  /** href → absolute URL; pages repeat the same hrefs many times and URL parsing is the costly part. */
  resolved: Map<string, string | undefined>;
}

/** Absolute http(s) URL of an href, or undefined for fragments, javascript:, mailto: and junk. */
function linkUrl(href: string, ctx: Ctx): string | undefined {
  const h = href.trim();
  if (!h || h.startsWith('#')) { return undefined; }
  if (ctx.resolved.has(h)) { return ctx.resolved.get(h); }
  const url = resolveUrl(h, ctx.base);
  const ok = url && /^https?:/i.test(url) ? url : undefined;
  if (ctx.resolved.size < 50_000) { ctx.resolved.set(h, ok); }
  return ok;
}

/** Turns an inline buffer into a finished paragraph. */
const BR_RE = new RegExp(` *${BR} *`, 'g');

function finishInline(s: string): string {
  return collapse(s).replace(BR_RE, '\n').replace(/ /g, ' ').trim();
}

/** Strips leading/trailing newlines with a loop (`\n+$` backtracks quadratically on long inner runs). */
function trimNewlines(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s.charCodeAt(a) === 10) { a++; }
  while (b > a && s.charCodeAt(b - 1) === 10) { b--; }
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

function renderBlocks(nodes: MNode[], ctx: Ctx, tight = false): string {
  const blocks: string[] = [];
  let inline = '';
  const flush = () => { const p = finishInline(inline); if (p) { blocks.push(p); } inline = ''; };
  for (const c of nodes) {
    if (c.type === 'text') { inline += c.text; continue; }
    if (isBoilerplate(c, ctx.inMain)) { continue; }
    if (BLOCK.has(c.tag) || (c.tag !== 'a' && hasBlockChild(c))) {
      flush();
      const b = trimNewlines(renderBlock(c, ctx));
      if (b.trim()) { blocks.push(b); }
    } else {
      inline += renderInline(c, ctx);
    }
  }
  flush();
  return blocks.join(tight ? '\n' : '\n\n');
}

const blockMemo = new WeakMap<MElement, boolean>();

/** Whether an inline element wraps block content (then it is rendered as a container). Memoised: keeps deep trees linear. */
function hasBlockChild(e: MElement): boolean {
  let r = blockMemo.get(e);
  if (r === undefined) {
    r = e.children.some((c) => c.type === 'el' && (BLOCK.has(c.tag) || (c.tag !== 'a' && hasBlockChild(c))));
    blockMemo.set(e, r);
  }
  return r;
}

function renderBlock(e: MElement, ctx: Ctx): string {
  const tag = e.tag;
  if (HEADINGS.has(tag)) {
    const t = finishInline(renderInlineChildren(e, ctx)).replace(/\n/g, ' ');
    return t ? `${'#'.repeat(Number(tag[1]))} ${t}` : '';
  }
  switch (tag) {
    case 'p': case 'legend': case 'caption': case 'dt': case 'summary': return finishInline(renderInlineChildren(e, ctx));
    case 'figcaption': { const t = finishInline(renderInlineChildren(e, ctx)); return t ? `_${t}_` : ''; }
    case 'hr': return '---';
    case 'pre': case 'xmp': case 'listing': return renderPre(e);
    case 'blockquote': {
      const inner = renderBlocks(e.children, ctx);
      return inner ? inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') : '';
    }
    case 'ul': case 'ol': case 'menu': case 'dir': return renderList(e, ctx, tag === 'ol');
    case 'dl': return renderDl(e, ctx);
    case 'table': return renderTable(e, ctx);
    case 'details': {
      const summary = e.children.find((c): c is MElement => c.type === 'el' && c.tag === 'summary');
      const head = summary ? finishInline(renderInlineChildren(summary, ctx)) : '';
      const body = renderBlocks(e.children.filter((c) => c !== summary), ctx);
      return [head ? `**${head}**` : '', body].filter(Boolean).join('\n\n');
    }
    case 'li': return indentItem('-', renderBlocks(e.children, ctx, true));
    case 'article': case 'main': {
      const was = ctx.inMain;
      ctx.inMain = true;
      try { return renderBlocks(e.children, ctx); } finally { ctx.inMain = was; }
    }
    default: return renderBlocks(e.children, ctx);
  }
}

function renderInlineChildren(e: MElement, ctx: Ctx): string {
  let s = '';
  for (const c of e.children) { s += c.type === 'text' ? c.text : renderInline(c, ctx); }
  return s;
}

/** Wraps inline content in a Markdown marker, keeping surrounding whitespace outside the marker. */
function wrap(inner: string, marker: string): string {
  const [lead, core, trail] = splitWs(inner);
  if (!core || (core.startsWith(marker) && core.endsWith(marker) && core.length > marker.length * 2)) { return inner; }
  return `${lead}${marker}${core}${marker}${trail}`;
}

/** [leading whitespace, core, trailing whitespace] in linear time (a regex would backtrack on huge runs). */
function splitWs(s: string): [string, string, string] {
  let a = 0;
  let b = s.length;
  while (a < b && isWs(s.charCodeAt(a))) { a++; }
  while (b > a && isWs(s.charCodeAt(b - 1))) { b--; }
  return [s.slice(0, a), s.slice(a, b), s.slice(b)];
}

function renderInline(e: MElement, ctx: Ctx): string {
  if (isBoilerplate(e, ctx.inMain)) { return ''; }
  switch (e.tag) {
    case 'br': return BR;
    case 'wbr': return '';
    case 'img': return renderImg(e, ctx);
    case 'picture': {
      const img = e.children.find((c): c is MElement => c.type === 'el' && c.tag === 'img');
      return img ? renderImg(img, ctx, e) : '';
    }
    case 'a': return renderLink(e, ctx);
    case 'strong': case 'b': return wrap(renderInlineChildren(e, ctx), '**');
    case 'em': case 'i': case 'cite': case 'dfn': return wrap(renderInlineChildren(e, ctx), '_');
    case 's': case 'del': case 'strike': return wrap(renderInlineChildren(e, ctx), '~~');
    case 'code': case 'kbd': case 'samp': case 'tt': case 'var': {
      const t = collapse(textOf(e));
      if (!t.trim()) { return t; }
      const ticks = longestRun(t, '`', 0) + 1;
      const fence = '`'.repeat(ticks);
      const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
      return `${fence}${pad}${t.trim()}${pad}${fence}`;
    }
    default:
      if (BLOCK.has(e.tag)) { return ` ${renderInlineChildren(e, ctx)} `; }
      return renderInlineChildren(e, ctx);
  }
}

const mdUrl = (u: string) => u.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20');

function addLink(ctx: Ctx, text: string, url: string): void {
  if (ctx.linkSeen.has(url) || ctx.linkSeen.size >= MAX_LINKS) { return; }
  ctx.linkSeen.add(url);
  ctx.links.push({ text: clipText(sanitizeText(collapse(text)).replace(/ /g, ' ').trim(), 120), url });
}

const clipText = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function renderLink(e: MElement, ctx: Ctx): string {
  const inner = renderInlineChildren(e, ctx);
  const url = linkUrl(attr(e, 'href'), ctx);
  if (!url) { return inner; }
  const label = collapse(textOf(e)).trim() || attr(e, 'aria-label') || attr(e, 'title') || imgAlt(e);
  addLink(ctx, label, url);
  const [lead, core, trail] = splitWs(inner);
  const text = core || label;
  if (!text) { return inner; }
  return `${lead}[${text}](${mdUrl(url)})${trail}`;
}

function imgAlt(e: MElement): string {
  const img = findFirst(e, (x) => x.tag === 'img');
  return img ? attr(img, 'alt').trim() : '';
}

/** Largest candidate of a srcset (by w, else x descriptor). */
export function pickSrcset(srcset: string): string | undefined {
  let best: string | undefined;
  let bestScore = -1;
  let i = 0;
  const s = srcset;
  while (i < s.length) {
    while (i < s.length && (isWs(s.charCodeAt(i)) || s[i] === ',')) { i++; }
    if (i >= s.length) { break; }
    let j = i;
    while (j < s.length && !isWs(s.charCodeAt(j))) { j++; }
    let url = s.slice(i, j);
    let desc = '';
    if (url.endsWith(',')) { url = url.replace(/,+$/, ''); } else {
      const k = s.indexOf(',', j);
      desc = s.slice(j, k < 0 ? s.length : k).trim();
      j = k < 0 ? s.length : k + 1;
    }
    i = j;
    if (!url) { continue; }
    const w = /^(\d+)w$/i.exec(desc);
    const x = /^(\d*\.?\d+)x$/i.exec(desc);
    const score = w ? Number(w[1]) : x ? Number(x[1]) * 1000 : 1;
    if (score > bestScore) { bestScore = score; best = url; }
  }
  return best;
}

/** Image URL from srcset / lazy-loading attributes / src; skips data: URIs and tracking pixels. */
export function imageOf(e: MElement, base: string, picture?: MElement): DocImage | undefined {
  const dim = (v: string) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : undefined; };
  const width = dim(attr(e, 'width'));
  const height = dim(attr(e, 'height'));
  if ((width !== undefined && width <= 2) || (height !== undefined && height <= 2)) { return undefined; }
  const candidates: Array<string | undefined> = [];
  for (const a of ['srcset', 'data-srcset']) { const v = attr(e, a); if (v) { candidates.push(pickSrcset(v)); } }
  if (picture) {
    for (const c of picture.children) { if (c.type === 'el' && c.tag === 'source' && c.attrs.srcset) { candidates.push(pickSrcset(c.attrs.srcset)); } }
  }
  for (const a of ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url', 'src']) { candidates.push(attr(e, a) || undefined); }
  for (const c of candidates) {
    if (!c || /^\s*data:/i.test(c)) { continue; }
    const url = resolveUrl(c, base);
    if (!url || !/^https?:/i.test(url)) { continue; }
    const img: DocImage = { url };
    const alt = collapse(attr(e, 'alt')).trim();
    if (alt) { img.alt = alt; }
    if (width) { img.width = width; }
    if (height) { img.height = height; }
    return img;
  }
  return undefined;
}

function renderImg(e: MElement, ctx: Ctx, picture?: MElement): string {
  const img = imageOf(e, ctx.base, picture);
  if (!img) { return ''; }
  if (!ctx.seenImages.has(img.url)) { ctx.seenImages.add(img.url); ctx.images.push(img); }
  return `![${(img.alt ?? '').replace(/[[\]]/g, '')}](${mdUrl(img.url)})`;
}

const LANG_RE = /(?:^|\s)(?:language|lang|highlight(?:-source)?|brush:?)-?([\w+#.-]+)/i;

function codeLang(...els: Array<MElement | undefined>): string {
  for (const e of els) {
    const cls = e?.attrs.class;
    if (!cls) { continue; }
    const m = LANG_RE.exec(cls);
    if (m && !/^(?:none|plaintext|text|nohighlight)$/i.test(m[1])) { return m[1].toLowerCase(); }
  }
  return '';
}

function preText(e: MNode): string {
  if (e.type === 'text') { return e.text; }
  if (e.tag === 'br') { return '\n'; }
  let s = '';
  for (const c of e.children) { s += preText(c); }
  return s;
}

function renderPre(e: MElement): string {
  const elems = e.children.filter((c): c is MElement => c.type === 'el');
  const code = elems.length === 1 && elems[0].tag === 'code' ? elems[0] : undefined;
  const lang = codeLang(code, e);
  const text = preText(e).replace(/^\r?\n/, '').trimEnd();
  if (!text) { return ''; }
  const ticks = longestRun(text, '`', 2) + 1;
  const fence = '`'.repeat(ticks);
  return `${fence}${lang}\n${text}\n${fence}`;
}

function indentItem(marker: string, body: string): string {
  if (!body.trim()) { return ''; }
  const pad = ' '.repeat(marker.length + 1);
  const lines = body.split('\n');
  return [`${marker} ${lines[0]}`, ...lines.slice(1).map((l) => (l ? pad + l : ''))].join('\n');
}

function renderList(e: MElement, ctx: Ctx, ordered: boolean): string {
  const reversed = ordered && 'reversed' in e.attrs;
  let n = ordered ? parseInt(attr(e, 'start'), 10) : 0;
  if (!Number.isFinite(n)) { n = 1; }
  const items: string[] = [];
  for (const c of e.children) {
    if (c.type === 'text') {
      const t = collapse(c.text).trim();
      if (t) { items.push(`- ${t}`); }
      continue;
    }
    if (isBoilerplate(c, ctx.inMain)) { continue; }
    if (c.tag === 'li') {
      const v = parseInt(attr(c, 'value'), 10);
      if (ordered && Number.isFinite(v)) { n = v; }
      const item = indentItem(ordered ? `${n}.` : '-', renderBlocks(c.children, ctx, true));
      if (ordered) { n += reversed ? -1 : 1; }
      if (item) { items.push(item); }
    } else if ((c.tag === 'ul' || c.tag === 'ol') && items.length) {
      const nested = renderBlock(c, ctx);
      if (nested) { items[items.length - 1] += `\n${nested.split('\n').map((l) => (l ? `  ${l}` : '')).join('\n')}`; }
    } else {
      const b = renderBlocks([c], ctx, true);
      if (b) { items.push(b); }
    }
  }
  return items.join('\n');
}

function renderDl(e: MElement, ctx: Ctx): string {
  const lines: string[] = [];
  let term: string | undefined;
  let lastWasDef = false;
  const kids: MElement[] = [];
  for (const c of e.children) {
    if (c.type !== 'el') { continue; }
    if (c.tag === 'div') { for (const g of c.children) { if (g.type === 'el') { kids.push(g); } } } else { kids.push(c); }
  }
  for (const c of kids) {
    if (c.tag === 'dt') {
      if (term !== undefined) { lines.push(`**${term}**`); }
      term = finishInline(renderInlineChildren(c, ctx)).replace(/\n/g, ' ');
      lastWasDef = false;
    } else if (c.tag === 'dd') {
      const def = renderBlocks(c.children, ctx, true).replace(/\n/g, ' ');
      if (term !== undefined) { lines.push(term ? `**${term}**: ${def}` : def); term = undefined; }
      else if (lastWasDef && lines.length) { lines[lines.length - 1] += `; ${def}`; }
      else { lines.push(def); }
      lastWasDef = true;
    }
  }
  if (term) { lines.push(`**${term}**`); }
  return lines.filter(Boolean).join('\n');
}

function renderTable(e: MElement, ctx: Ctx): string {
  const rows: MElement[] = [];
  let caption = '';
  const collectRows = (parent: MElement) => {
    for (const c of parent.children) {
      if (c.type !== 'el') { continue; }
      if (c.tag === 'tr') { rows.push(c); } else if (c.tag === 'thead' || c.tag === 'tbody' || c.tag === 'tfoot') { collectRows(c); }
      else if (c.tag === 'caption') { caption = finishInline(renderInlineChildren(c, ctx)); }
    }
  };
  collectRows(e);
  const cellsOf = (r: MElement) => r.children.filter((c): c is MElement => c.type === 'el' && (c.tag === 'td' || c.tag === 'th'));
  const role = attr(e, 'role').toLowerCase();
  const nested = rows.some((r) => cellsOf(r).some((c) => findFirst(c, (x) => x.tag === 'table')));
  const widest = rows.reduce((w, r) => Math.max(w, cellsOf(r).reduce((s, c) => s + span(c, 'colspan'), 0)), 0);
  if (!rows.length || nested || widest <= 1 || role === 'presentation' || role === 'none') {
    const parts = rows.flatMap((r) => cellsOf(r).map((c) => renderBlocks(c.children, ctx))).filter((s) => s.trim());
    if (!rows.length) { parts.push(renderBlocks(e.children.filter((c) => c.type === 'el' && c.tag !== 'caption'), ctx)); }
    return [caption, ...parts].filter((s) => s.trim()).join('\n\n');
  }
  const grid: string[][] = [];
  const pendingRows: number[] = [];
  for (const r of rows) {
    const out: string[] = [];
    let col = 0;
    const fillPending = () => {
      while (pendingRows[col] > 0) { pendingRows[col]--; out.push(''); col++; }
    };
    for (const c of cellsOf(r)) {
      fillPending();
      const text = renderBlocks(c.children, ctx, true).replace(/\|/g, '\\|').replace(/\n/g, '<br>').trim();
      const cs = span(c, 'colspan');
      const rs = span(c, 'rowspan');
      for (let k = 0; k < cs; k++) {
        out.push(k === 0 ? text : '');
        if (rs > 1) { pendingRows[col] = rs - 1; }
        col++;
      }
    }
    fillPending();
    grid.push(out);
  }
  const cols = grid.reduce((w, r) => Math.max(w, r.length), 0);
  const line = (r: string[]) => `| ${Array.from({ length: cols }, (_, k) => r[k] ?? '').join(' | ')} |`;
  const table = [line(grid[0]), `| ${Array(cols).fill('---').join(' | ')} |`, ...grid.slice(1).map(line)].join('\n');
  return caption ? `**${caption}**\n\n${table}` : table;
}

function span(c: MElement, name: string): number {
  const v = parseInt(attr(c, name), 10);
  return Number.isFinite(v) && v > 1 ? Math.min(v, 50) : 1;
}

/* ------------------------------------------------------------------ metadata */

interface Meta {
  title?: string; ogTitle?: string; h1?: string; description?: string; author?: string; published?: string;
  siteName?: string; canonical?: string; lang?: string; ogImage?: string;
}

function readMeta(root: MElement, base: string): Meta {
  const meta: Meta = {};
  const metas = new Map<string, string>();
  const ld: unknown[] = [];
  let time: string | undefined;
  const walk = (e: MElement, inSvg: boolean) => {
    for (const c of e.children) {
      if (c.type !== 'el') { continue; }
      const svg = inSvg || c.tag === 'svg';
      switch (c.tag) {
        case 'html': if (!meta.lang && c.attrs.lang) { meta.lang = c.attrs.lang.trim(); } break;
        case 'title': if (!svg && meta.title === undefined) { meta.title = collapse(textOf(c)).trim(); } break;
        case 'meta': {
          const key = (c.attrs.property || c.attrs.name || c.attrs.itemprop || '').trim().toLowerCase();
          const val = c.attrs.content?.trim();
          if (key && val && !metas.has(key)) { metas.set(key, val); }
          break;
        }
        case 'link':
          if (!meta.canonical && /(?:^|\s)canonical(?:\s|$)/i.test(c.attrs.rel ?? '') && c.attrs.href) { meta.canonical = resolveUrl(c.attrs.href, base); }
          break;
        case 'script':
          if (/ld\+json/i.test(c.attrs.type ?? '')) { try { ld.push(JSON.parse(textOf(c))); } catch { /* malformed JSON-LD is common; ignore it */ } }
          break;
        case 'time': if (!time && c.attrs.datetime) { time = c.attrs.datetime; } break;
        case 'h1': if (meta.h1 === undefined) { meta.h1 = collapse(textOf(c)).trim() || undefined; } break;
      }
      if (c.tag !== 'script' && c.tag !== 'style') { walk(c, svg); }
    }
  };
  walk(root, false);
  const fromLd: { published?: string; author?: string; headline?: string; site?: string } = {};
  const visit = (v: unknown, depth: number) => {
    if (depth > 6 || !v || typeof v !== 'object') { return; }
    if (Array.isArray(v)) { for (const x of v) { visit(x, depth + 1); } return; }
    const o = v as Record<string, unknown>;
    if (!fromLd.published && typeof o.datePublished === 'string') { fromLd.published = o.datePublished; }
    if (!fromLd.author && o.author) { fromLd.author = personName(o.author); }
    if (!fromLd.headline && typeof o.headline === 'string') { fromLd.headline = o.headline; }
    if (!fromLd.site && o.publisher) { fromLd.site = personName(o.publisher); }
    for (const x of Object.values(o)) { if (x && typeof x === 'object') { visit(x, depth + 1); } }
  };
  visit(ld, 0);
  const get = (...keys: string[]) => { for (const k of keys) { const v = metas.get(k); if (v) { return v; } } return undefined; };
  meta.ogTitle = get('og:title', 'twitter:title') ?? fromLd.headline;
  meta.description = get('description', 'og:description', 'twitter:description');
  meta.siteName = get('og:site_name', 'application-name') ?? fromLd.site;
  const articleAuthor = get('article:author');
  meta.author = get('author', 'dc.creator', 'parsely-author') ?? fromLd.author ?? (articleAuthor && !/^https?:/i.test(articleAuthor) ? articleAuthor : undefined);
  meta.published = isoDate(get('article:published_time', 'datepublished', 'date', 'dc.date', 'pubdate')) ?? isoDate(fromLd.published) ?? isoDate(time);
  if (!meta.canonical) { const og = get('og:url'); if (og) { meta.canonical = resolveUrl(og, base); } }
  const ogImage = get('og:image', 'og:image:url', 'twitter:image');
  if (ogImage) { meta.ogImage = resolveUrl(ogImage, base); }
  return meta;
}

function personName(v: unknown): string | undefined {
  if (typeof v === 'string') { return v.trim() || undefined; }
  if (Array.isArray(v)) { const names = v.map(personName).filter(Boolean); return names.length ? names.join(', ') : undefined; }
  if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') { return ((v as { name: string }).name).trim() || undefined; }
  return undefined;
}

/* ------------------------------------------------------------------ entry point */

const MAX_LINKS = 300;

/** Converts an HTML page to Markdown of its main content plus metadata, links, images and safety warnings. */
export function htmlToDoc(html: string, baseUrl: string): ExtractedDoc {
  const root = parseMarkup(html);
  const meta = readMeta(root, baseUrl);
  const baseEl = findFirst(root, (e) => e.tag === 'base' && !!e.attrs.href);
  const base = (baseEl && resolveUrl(baseEl.attrs.href, baseUrl)) || baseUrl;
  const body = findFirst(root, (e) => e.tag === 'body') ?? root;
  const hidden = prune(body);

  const { root: mainEl, inMain } = selectMain(body);
  const ctx: Ctx = { base, links: [], images: [], inMain, seenImages: new Set(), linkSeen: new Set(), resolved: new Map() };
  if (meta.ogImage) { ctx.images.push({ url: meta.ogImage }); ctx.seenImages.add(meta.ogImage); }
  const markdown = sanitizeText(trimNewlines(renderBlock(mainEl, ctx)));

  // Then the rest of the page (navigation, related links…), after the main content's own links.
  if (ctx.linkSeen.size < MAX_LINKS) {
    for (const a of findAll(body, (e) => e.tag === 'a' && !!e.attrs.href)) {
      const url = linkUrl(a.attrs.href, ctx);
      if (url && !ctx.linkSeen.has(url)) { addLink(ctx, collapse(textOf(a)).trim() || attr(a, 'aria-label') || attr(a, 'title') || imgAlt(a), url); }
      if (ctx.linkSeen.size >= MAX_LINKS) { break; }
    }
  }

  const doc: ExtractedDoc = { kind: 'html', markdown, links: ctx.links, images: ctx.images, warnings: [] };
  const title = meta.title || meta.ogTitle || meta.h1;
  if (title) { doc.title = sanitizeText(title); }
  if (meta.description) { doc.description = sanitizeText(meta.description); }
  if (meta.author) { doc.author = sanitizeText(meta.author); }
  if (meta.published) { doc.published = meta.published; }
  if (meta.siteName) { doc.siteName = sanitizeText(meta.siteName); }
  if (meta.canonical) { doc.canonicalUrl = meta.canonical; }
  if (meta.lang) { doc.lang = meta.lang; }
  if (hidden > 0) { doc.warnings.push(`Removed ${hidden} characters of hidden text`); }
  if (root.attrs[FLATTENED]) { doc.warnings.push(`Very large page: markup after the first ${MAX_ELEMENTS} elements was read as plain text`); }
  for (const e of detectInjection([doc.title, doc.description, markdown].filter(Boolean).join('\n'))) {
    doc.warnings.push(`Possible prompt injection: “${e}”`);
  }
  return doc;
}
