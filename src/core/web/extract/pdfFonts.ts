import { PDict, PName, PObj, PStr, PStream } from './pdfObjects';

/**
 * PDF fonts → Unicode: simple-font encodings with /Differences and Adobe glyph names, ToUnicode CMaps,
 * Type0/CID fonts, and glyph widths (needed to know where a run of text ends on the page).
 */

/* ------------------------------------------------------------------ encodings (code → Unicode) */

const ASCII = (() => { const a: string[] = []; for (let i = 0; i < 128; i++) { a[i] = i >= 32 && i < 127 ? String.fromCharCode(i) : ''; } return a; })();
/** ISO-8859-1 printable range; the C1 block 0x80–0x9F is left empty for the tables below to fill. */
const LATIN1 = Array.from({ length: 256 }, (_, i) => (i < 32 || (i >= 127 && i < 160) ? '' : String.fromCharCode(i)));

function table(base: string[], from: number, chars: string): string[] {
  const t = base.slice();
  [...chars].forEach((c, i) => { t[from + i] = c === '\u0000' ? '' : c; });
  return t;
}

const WIN_ANSI = table(LATIN1, 128, '€\u0000‚ƒ„…†‡ˆ‰Š‹Œ\u0000Ž\u0000\u0000‘’“”•–—˜™š›œ\u0000žŸ',
);
WIN_ANSI[0xa0] = ' '; WIN_ANSI[0xad] = '-';

const MAC_ROMAN = table(ASCII, 128,
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄¤‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\u0000ÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ');

const STANDARD = (() => {
  const t = ASCII.slice(); t[0x27] = '’'; t[0x60] = '‘';
  const hi: Record<number, string> = {
    0xa1: '¡', 0xa2: '¢', 0xa3: '£', 0xa4: '⁄', 0xa5: '¥', 0xa6: 'ƒ', 0xa7: '§', 0xa8: '¤', 0xa9: "'", 0xaa: '“', 0xab: '«',
    0xac: '‹', 0xad: '›', 0xae: 'ﬁ', 0xaf: 'ﬂ', 0xb1: '–', 0xb2: '†', 0xb3: '‡', 0xb4: '·', 0xb6: '¶', 0xb7: '•', 0xb8: '‚',
    0xb9: '„', 0xba: '”', 0xbb: '»', 0xbc: '…', 0xbd: '‰', 0xbf: '¿', 0xc1: '`', 0xc2: '´', 0xc3: 'ˆ', 0xc4: '˜', 0xc5: '¯',
    0xc6: '˘', 0xc7: '˙', 0xc8: '¨', 0xca: '˚', 0xcb: '¸', 0xcd: '˝', 0xce: '˛', 0xcf: 'ˇ', 0xd0: '—', 0xe1: 'Æ', 0xe3: 'ª',
    0xe8: 'Ł', 0xe9: 'Ø', 0xea: 'Œ', 0xeb: 'º', 0xf1: 'æ', 0xf5: 'ı', 0xf8: 'ł', 0xf9: 'ø', 0xfa: 'œ', 0xfb: 'ß',
  };
  for (const [k, v] of Object.entries(hi)) { t[Number(k)] = v; }
  return t;
})();

/** PDFDocEncoding: used for text strings (titles, bookmarks) that are not UTF-16. */
export const PDF_DOC = (() => {
  const t = table(LATIN1, 0x80, '•†‡…—–ƒ⁄‹›−‰„“”‘’‚™ﬁﬂŁŒŠŸŽıłœšž\u0000€');
  [...'˘ˇˆ˙˝˛˚˜'].forEach((c, i) => { t[0x18 + i] = c; });
  for (const c of [9, 10, 13]) { t[c] = String.fromCharCode(c); }
  return t;
})();

const SYMBOL = (() => {
  const t = ASCII.slice();
  const up = 'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ'; const lo = 'αβχδεφγηιϕκλμνοπθρστυϖωξψζ';
  for (let i = 0; i < 26; i++) { t[0x41 + i] = up[i]; t[0x61 + i] = lo[i]; }
  Object.assign(t, { 0x22: '∀', 0x24: '∃', 0x27: '∋', 0x2a: '∗', 0x2d: '−', 0x40: '≅', 0x5c: '∴', 0x5e: '⊥', 0x60: '', 0x7e: '∼',
    0xa3: '≤', 0xa5: '∞', 0xb1: '±', 0xb3: '≥', 0xb4: '×', 0xb6: '∂', 0xb7: '•', 0xb8: '÷', 0xb9: '≠', 0xba: '≡', 0xbb: '≈',
    0xbc: '…', 0xc5: '⊕', 0xc6: '∅', 0xc7: '∩', 0xc8: '∪', 0xce: '∈', 0xd1: '∇', 0xd5: '∏', 0xd6: '√', 0xd7: '⋅', 0xe5: '∑',
    0xf2: '∫', 0xae: '→', 0xac: '←', 0xad: '↑', 0xaf: '↓', 0xab: '↔', 0xde: '⇒', 0xdc: '⇐', 0xdb: '⇔', 0xb0: '°' });
  return t;
})();

const ENCODINGS: Record<string, string[]> = {
  WinAnsiEncoding: WIN_ANSI, MacRomanEncoding: MAC_ROMAN, StandardEncoding: STANDARD, PDFDocEncoding: PDF_DOC,
};

/* ------------------------------------------------------------------ glyph names */

const GLYPHS = new Map<string, string>();
((pairs: string) => {
  for (const p of pairs.trim().split(/\s+/)) {
    const i = p.indexOf(':');
    GLYPHS.set(p.slice(0, i), p.slice(i + 1).split(',').map((h) => String.fromCodePoint(parseInt(h, 16))).join(''));
  }
})(`
space:20 exclam:21 quotedbl:22 numbersign:23 dollar:24 percent:25 ampersand:26 quotesingle:27 quoteright:2019
parenleft:28 parenright:29 asterisk:2A plus:2B comma:2C hyphen:2D period:2E slash:2F zero:30 one:31 two:32 three:33
four:34 five:35 six:36 seven:37 eight:38 nine:39 colon:3A semicolon:3B less:3C equal:3D greater:3E question:3F at:40
bracketleft:5B backslash:5C bracketright:5D asciicircum:5E underscore:5F grave:60 quoteleft:2018 braceleft:7B bar:7C
braceright:7D asciitilde:7E nbspace:A0 nonbreakingspace:A0 exclamdown:A1 cent:A2 sterling:A3 currency:A4 yen:A5
brokenbar:A6 section:A7 dieresis:A8 copyright:A9 ordfeminine:AA guillemotleft:AB guillemetleft:AB logicalnot:AC
sfthyphen:AD softhyphen:AD registered:AE macron:AF degree:B0 plusminus:B1 twosuperior:B2 threesuperior:B3 acute:B4
mu:B5 mu1:B5 paragraph:B6 periodcentered:B7 middot:B7 cedilla:B8 onesuperior:B9 ordmasculine:BA guillemotright:BB
guillemetright:BB onequarter:BC onehalf:BD threequarters:BE questiondown:BF AE:C6 Eth:D0 multiply:D7 Oslash:D8
Thorn:DE germandbls:DF ae:E6 eth:F0 divide:F7 oslash:F8 thorn:FE dotlessi:131 dotlessj:237 IJ:132 ij:133 Ldot:13F
ldot:140 Lslash:141 lslash:142 napostrophe:149 Eng:14A eng:14B OE:152 oe:153 florin:192 kgreenlandic:138 longs:17F
Dcroat:110 dcroat:111 Dslash:110 Hbar:126 hbar:127 Tbar:166 tbar:167 circumflex:2C6 caron:2C7 breve:2D8 dotaccent:2D9
ring:2DA ogonek:2DB tilde:2DC hungarumlaut:2DD figuredash:2012 endash:2013 emdash:2014 horizontalbar:2015
quotereversed:201B quotesinglbase:201A quotedblleft:201C quotedblright:201D quotedblbase:201E dagger:2020
daggerdbl:2021 bullet:2022 onedotenleader:2024 twodotenleader:2025 ellipsis:2026 perthousand:2030 minute:2032
second:2033 guilsinglleft:2039 guilsinglright:203A exclamdbl:203C fraction:2044 Euro:20AC euro:20AC trademark:2122
afii61289:2113 afii61352:2116 estimated:212E aleph:2135 weierstrass:2118 Ifraktur:2111 Rfraktur:211C
minus:2212 infinity:221E lessequal:2264 greaterequal:2265 notequal:2260 approxequal:2248 partialdiff:2202
summation:2211 product:220F radical:221A integral:222B element:2208 notelement:2209 suchthat:220B intersection:2229
union:222A logicaland:2227 logicalor:2228 universal:2200 existential:2203 emptyset:2205 gradient:2207
proportional:221D therefore:2234 similar:223C congruent:2245 equivalence:2261 propersubset:2282 propersuperset:2283
notsubset:2284 reflexsubset:2286 reflexsuperset:2287 circleplus:2295 circlemultiply:2297 perpendicular:22A5
dotmath:22C5 angle:2220 angleleft:2329 angleright:232A lozenge:25CA asteriskmath:2217 orthogonal:221F
arrowleft:2190 arrowup:2191 arrowright:2192 arrowdown:2193 arrowboth:2194 arrowupdn:2195 arrowdblleft:21D0
arrowdblup:21D1 arrowdblright:21D2 arrowdbldown:21D3 arrowdblboth:21D4 carriagereturn:21B5 checkmark:2713
club:2663 diamond:2666 heart:2665 spade:2660 filledbox:25A0 H22073:25A1 triagup:25B2 triagdn:25BC triagrt:25BA
triaglf:25C4 circle:25CB H18533:25CF H18543:25AA H18551:25AB openbullet:25E6 blackcircle:25CF smileface:263A
ff:66,66 fi:66,69 fl:66,6C ffi:66,66,69 ffl:66,66,6C st:73,74 cwm:200C zerowidthspace:200B
theta1:3D1 phi1:3D5 omega1:3D6 Upsilon1:3D2 sigma1:3C2 Omegagreek:3A9 Deltagreek:394 mugreek:3BC
`);
['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi',
  'Rho', '', 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega'].forEach((n, i) => {
  if (!n) { return; }
  GLYPHS.set(n, String.fromCharCode(0x391 + i));
  GLYPHS.set(n.toLowerCase(), String.fromCharCode(0x3b1 + i));
});

const ACCENTS: Record<string, string> = {
  acute: '́', grave: '̀', circumflex: '̂', tilde: '̃', dieresis: '̈', ring: '̊', cedilla: '̧',
  caron: '̌', macron: '̄', breve: '̆', ogonek: '̨', dotaccent: '̇', hungarumlaut: '̋', commaaccent: '̦',
};

/** Adobe glyph name → Unicode (AGL subset + uniXXXX/uXXXXX + accented-letter composition). '' when unknown. */
export function glyphToUnicode(name: string, depth = 0): string {
  const hit = GLYPHS.get(name);
  if (hit !== undefined) { return hit; }
  if (depth > 3 || !name || name === '.notdef') { return ''; }
  const dot = name.indexOf('.');
  if (dot > 0) { return glyphToUnicode(name.slice(0, dot), depth + 1); }
  if (name.includes('_')) { return name.split('_').map((p) => glyphToUnicode(p, depth + 1)).join(''); }
  let m = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(name);
  if (m) {
    const units = m[1].match(/.{4}/g)!.map((h) => parseInt(h, 16));
    return String.fromCharCode(...units);
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) { const cp = parseInt(m[1], 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; }
  if (/^[A-Za-z]$/.test(name)) { return name; }
  m = /^([A-Za-z])([a-z]+)$/.exec(name);
  if (m && ACCENTS[m[2]]) {
    for (const mark of m[2] === 'commaaccent' ? ['̦', '̧'] : [ACCENTS[m[2]]]) {
      const c = (m[1] + mark).normalize('NFC');
      if ([...c].length === 1) { return c; }
    }
  }
  if (name === 'Idotaccent') { return 'İ'; }
  return '';
}

/* ------------------------------------------------------------------ CMaps */

interface CodeRange { len: number; lo: number[]; hi: number[] }

export interface CMap {
  ranges: CodeRange[];
  /** (code * 8 + byteLength) → Unicode. */
  uni: Map<number, string>;
  /** (code * 8 + byteLength) → CID (only for embedded encoding CMaps). */
  cid: Map<number, number>;
  name?: string;
}

const MAX_CMAP_ENTRIES = 200_000;

/** Parses a ToUnicode or embedded encoding CMap (codespace, bfchar/bfrange, cidchar/cidrange). */
export function parseCMap(data: Buffer): CMap {
  const s = data.toString('latin1');
  const cm: CMap = { ranges: [], uni: new Map(), cid: new Map() };
  const re = /<([0-9A-Fa-f\s]*)>|\[|\]|\/([^\s/[\]<>()]+)|\(((?:\\.|[^\\)])*)\)|([^\s[\]<>/()]+)/g;
  type T = { hex?: Buffer; name?: string; kw?: string; arr?: '[' | ']' };
  const toks: T[] = [];
  for (let m; (m = re.exec(s));) {
    if (m[1] !== undefined) { toks.push({ hex: Buffer.from(m[1].replace(/\s+/g, '').padEnd(Math.ceil(m[1].replace(/\s+/g, '').length / 2) * 2, '0'), 'hex') }); }
    else if (m[0] === '[' || m[0] === ']') { toks.push({ arr: m[0] }); }
    else if (m[2] !== undefined) { toks.push({ name: m[2] }); }
    else if (m[3] !== undefined) { toks.push({ hex: Buffer.from(m[3].replace(/\\(.)/g, '$1'), 'latin1') }); }
    else { toks.push({ kw: m[4] }); }
  }
  let mode = '';
  let entries = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kw) {
      if (t.kw.startsWith('begin')) { mode = t.kw.slice(5); } else if (t.kw.startsWith('end')) { mode = ''; }
      continue;
    }
    if (t.name && toks[i + 1]?.kw === 'usecmap') { cm.name = t.name; continue; }
    if (!t.hex || entries > MAX_CMAP_ENTRIES) { continue; }
    if (mode === 'codespacerange' && toks[i + 1]?.hex) {
      const lo = t.hex; const hi = toks[++i].hex!;
      if (lo.length >= 1 && lo.length <= 4) { cm.ranges.push({ len: lo.length, lo: [...lo], hi: [...hi.subarray(0, lo.length)] }); }
    } else if (mode === 'bfchar') {
      const dst = toks[++i];
      if (!dst) { break; }
      const v = dst.hex ? utf16(dst.hex) : dst.name ? glyphToUnicode(dst.name) : '';
      cm.uni.set(key(t.hex), v); entries++;
    } else if (mode === 'bfrange') {
      const hiT = toks[++i]; const dst = toks[++i];
      if (!hiT?.hex || !dst) { break; }
      const lo = int(t.hex); const hi = int(hiT.hex); const len = t.hex.length;
      if (hi < lo || hi - lo > 65535) { if (dst.arr === '[') { while (i < toks.length && toks[i].arr !== ']') { i++; } } continue; }
      if (dst.arr === '[') {
        for (let c = lo; c <= hi && toks[i + 1] && toks[i + 1].arr !== ']'; c++) {
          const d = toks[++i];
          cm.uni.set(c * 8 + len, d.hex ? utf16(d.hex) : d.name ? glyphToUnicode(d.name) : ''); entries++;
        }
        while (i < toks.length && toks[i].arr !== ']') { i++; }
      } else if (dst.hex) {
        const base = dst.hex;
        for (let c = lo; c <= hi; c++) {
          const b = Buffer.from(base);
          // Increment the last code unit (bfrange destinations only vary in their last byte(s)).
          if (b.length >= 2) { b.writeUInt16BE((b.readUInt16BE(b.length - 2) + (c - lo)) & 0xffff, b.length - 2); } else if (b.length === 1) { b[0] += c - lo; }
          cm.uni.set(c * 8 + len, utf16(b)); entries++;
        }
      }
    } else if (mode === 'cidrange') {
      const hiT = toks[++i]; const kw = toks[++i];
      const cid = kw?.kw !== undefined ? Number(kw.kw) : NaN;
      if (!hiT?.hex || Number.isNaN(cid)) { continue; }
      const lo = int(t.hex); const hi = Math.min(int(hiT.hex), lo + 65535);
      for (let c = lo; c <= hi; c++) { cm.cid.set(c * 8 + t.hex.length, cid + c - lo); entries++; }
    } else if (mode === 'cidchar') {
      const kw = toks[++i];
      const cid = kw?.kw !== undefined ? Number(kw.kw) : NaN;
      if (!Number.isNaN(cid)) { cm.cid.set(key(t.hex), cid); entries++; }
    }
  }
  return cm;
}

function int(b: Buffer): number { let v = 0; for (const x of b) { v = v * 256 + x; } return v; }
function key(b: Buffer): number { return int(b) * 8 + b.length; }

/** UTF-16BE → string (lone surrogates are kept; they are rare and harmless). */
export function utf16(b: Buffer): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) { s += String.fromCharCode((b[i] << 8) | b[i + 1]); }
  return s;
}

/* ------------------------------------------------------------------ fonts */

/** Helvetica and Times-Roman widths for codes 32–126 (standard-14 fonts usually come without /Widths). */
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556,
  556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const TIMES = [250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500,
  500, 278, 278, 564, 564, 564, 444, 921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556,
  611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500,
  500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541];

export interface Glyph {
  text: string;
  /** Advance in text space (glyph width / 1000 for normal fonts), before font size and spacing. */
  width: number;
  /** Single-byte code 32: word spacing (Tw) applies. */
  space: boolean;
}

export interface FontEnv {
  resolve(o: PObj | undefined): PObj | undefined;
  /** Decoded stream data, or null when it cannot be decoded. */
  decode(s: PStream): Buffer | null;
}

const LIGATURES: Record<string, string> = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };

/** Turns string operands of Tj/TJ into glyphs. */
export class PdfFont {
  /** Set once some text could not be mapped to Unicode (callers warn once). */
  unmapped = false;
  private composite = false;
  private ranges: CodeRange[] = [];
  private toUni?: CMap;
  private enc: string[] = STANDARD;
  private diffs = new Map<number, string>();
  private widths = new Map<number, number>();
  private dw = 1000;
  private std: number[] | null = HELV;
  private fixedWidth = 0;
  private scale = 0.001;
  private cidMap?: CMap;
  /** Type0 font whose codes are Unicode (UCS-2/UTF-16 CMaps) or Identity without ToUnicode (try codes as Unicode). */
  private codesAreUnicode: 'no' | 'yes' | 'maybe' = 'no';

  constructor(dict: PDict, env: FontEnv) {
    const r = <T extends PObj>(o: PObj | undefined) => env.resolve(o) as T | undefined;
    const subtype = nameOf(r(dict.get('Subtype')));
    const baseFont = (nameOf(r(dict.get('BaseFont'))) ?? '').replace(/^[A-Z]{6}\+/, '');
    const tu = r(dict.get('ToUnicode'));
    if (tu instanceof PStream) { const d = env.decode(tu); if (d) { this.toUni = parseCMap(d); } }
    if (/Courier/i.test(baseFont)) { this.std = null; this.fixedWidth = 600; } else if (/Times|Roman|Serif/i.test(baseFont)) { this.std = TIMES; }

    if (subtype === 'Type0') {
      this.composite = true;
      const enc = r(dict.get('Encoding'));
      const encName = nameOf(enc) ?? '';
      if (enc instanceof PStream) {
        const d = env.decode(enc);
        if (d) { this.cidMap = parseCMap(d); this.ranges = this.cidMap.ranges; }
      }
      if (!this.ranges.length && this.toUni?.ranges.length && !/^Identity/.test(encName)) { this.ranges = this.toUni.ranges; }
      if (!this.ranges.length) { this.ranges = [{ len: 2, lo: [0, 0], hi: [255, 255] }]; }
      if (/UCS2|UTF16/.test(encName)) { this.codesAreUnicode = 'yes'; } else if (!this.toUni) { this.codesAreUnicode = 'maybe'; }
      const descs = r<PObj[]>(dict.get('DescendantFonts'));
      const desc = Array.isArray(descs) ? r<PDict>(descs[0]) : undefined;
      if (desc instanceof PDict) {
        const dw = r(desc.get('DW'));
        if (typeof dw === 'number') { this.dw = dw; }
        const w = r<PObj[]>(desc.get('W'));
        if (Array.isArray(w)) { this.readW(w, env); }
      }
      this.std = null;
      return;
    }

    if (subtype === 'Type3') {
      const fm = r<PObj[]>(dict.get('FontMatrix'));
      if (Array.isArray(fm) && typeof fm[0] === 'number') { this.scale = Math.abs(fm[0]) || 0.001; }
    }
    const isSymbol = /^Symbol/.test(baseFont);
    this.enc = isSymbol ? SYMBOL : subtype === 'TrueType' ? WIN_ANSI : STANDARD;
    const enc = r(dict.get('Encoding'));
    const encName = nameOf(enc);
    if (encName && ENCODINGS[encName]) { this.enc = ENCODINGS[encName]; }
    if (enc instanceof PDict) {
      const base = nameOf(r(enc.get('BaseEncoding')));
      if (base && ENCODINGS[base]) { this.enc = ENCODINGS[base]; }
      const diffs = r<PObj[]>(enc.get('Differences'));
      if (Array.isArray(diffs)) {
        let code = 0;
        for (const d of diffs) {
          const v = r(d);
          if (typeof v === 'number') { code = v; } else if (v instanceof PName) { this.diffs.set(code++, v.name); }
        }
      }
    }
    const first = r(dict.get('FirstChar'));
    const widths = r<PObj[]>(dict.get('Widths'));
    if (Array.isArray(widths)) {
      const f = typeof first === 'number' ? first : 0;
      widths.forEach((w, i) => { const v = r(w); if (typeof v === 'number') { this.widths.set(f + i, v); } });
      this.std = null;
    }
    const fd = r<PDict>(dict.get('FontDescriptor'));
    const mw = fd instanceof PDict ? r(fd.get('MissingWidth')) : undefined;
    this.dw = typeof mw === 'number' && mw > 0 ? mw : this.fixedWidth || (this.std === TIMES ? 500 : 556);
    if (subtype === 'Type3' && !Array.isArray(widths)) { this.dw = 0; }
  }

  private readW(w: PObj[], env: FontEnv): void {
    for (let i = 0; i < w.length && this.widths.size < 100_000;) {
      const a = env.resolve(w[i]); const b = env.resolve(w[i + 1]);
      if (typeof a !== 'number') { i++; continue; }
      if (Array.isArray(b)) {
        b.forEach((x, k) => { const v = env.resolve(x); if (typeof v === 'number') { this.widths.set(a + k, v); } });
        i += 2;
      } else {
        const c = env.resolve(w[i + 2]);
        if (typeof b === 'number' && typeof c === 'number') { for (let k = a; k <= b && k - a < 65536; k++) { this.widths.set(k, c); } }
        i += 3;
      }
    }
  }

  decode(bytes: Buffer): Glyph[] {
    return this.composite ? this.decodeComposite(bytes) : this.decodeSimple(bytes);
  }

  private decodeSimple(bytes: Buffer): Glyph[] {
    const out: Glyph[] = [];
    for (const code of bytes) {
      let text = this.toUni?.uni.get(code * 8 + 1) ?? this.toUni?.uni.get(code * 8 + 2);
      if (text === undefined) {
        const dn = this.diffs.get(code);
        text = dn !== undefined ? glyphToUnicode(dn) : this.enc[code] ?? '';
        if (dn !== undefined && !text && /^(g|cid|glyph|index)?\d+$|^[A-Za-z]{1,2}\d+$/.test(dn)) { this.unmapped = true; }
      }
      let w = this.widths.get(code);
      if (w === undefined) { w = this.std && code >= 32 && code <= 126 ? this.std[code - 32] : this.dw; }
      out.push({ text: lig(text), width: w * this.scale, space: code === 32 });
    }
    return out;
  }

  private decodeComposite(bytes: Buffer): Glyph[] {
    const out: Glyph[] = [];
    const codes: Array<{ code: number; len: number }> = [];
    for (let i = 0; i < bytes.length;) {
      const len = this.codeLength(bytes, i);
      let code = 0;
      for (let k = 0; k < len; k++) { code = code * 256 + (bytes[i + k] ?? 0); }
      codes.push({ code, len }); i += len;
    }
    // Without a ToUnicode map, Identity codes are usually glyph ids, not Unicode: accept them only when the
    // whole string looks like real text.
    let asUnicode = this.codesAreUnicode === 'yes';
    if (this.codesAreUnicode === 'maybe') {
      asUnicode = codes.every(({ code }) => plausible(code));
      if (!asUnicode) { this.unmapped = true; }
    }
    for (const { code, len } of codes) {
      let text = this.toUni?.uni.get(code * 8 + len);
      if (text === undefined) {
        if (asUnicode) { text = String.fromCharCode(code); } else { text = ''; if (code !== 0) { this.unmapped ||= !this.toUni; } }
      }
      const cid = this.cidMap?.cid.get(code * 8 + len) ?? code;
      const w = this.widths.get(cid) ?? this.dw;
      out.push({ text: lig(text), width: w * this.scale, space: len === 1 && code === 32 });
    }
    return out;
  }

  private codeLength(b: Buffer, i: number): number {
    for (let len = 1; len <= 4 && i + len <= b.length; len++) {
      for (const r of this.ranges) {
        if (r.len !== len) { continue; }
        let ok = true;
        for (let k = 0; k < len && ok; k++) { ok = b[i + k] >= r.lo[k] && b[i + k] <= r.hi[k]; }
        if (ok) { return len; }
      }
    }
    return Math.min(this.ranges[0]?.len ?? 1, b.length - i) || 1;
  }
}

function plausible(code: number): boolean {
  return (code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code < 0xd800) || (code >= 0xf900 && code < 0xfff0) || code === 0x0a || code === 0x09;
}

function lig(s: string): string {
  if (!s) { return s; }
  if (s.length === 1) { return LIGATURES[s] ?? (s === '\u0000' ? '' : s); }
  return s.replace(/[ﬀ-ﬆ\u0000]/g, (c) => LIGATURES[c] ?? '');
}

export function nameOf(o: PObj | undefined): string | undefined { return o instanceof PName ? o.name : undefined; }

/** Decodes a PDF text string (title, author…): UTF-16BE/LE with BOM, UTF-8 with BOM, else PDFDocEncoding. */
export function textString(o: PObj | undefined): string {
  if (!(o instanceof PStr)) { return ''; }
  const b = o.bytes;
  let s: string;
  if (b[0] === 0xfe && b[1] === 0xff) { s = utf16(b.subarray(2)); }
  else if (b[0] === 0xff && b[1] === 0xfe) { s = b.subarray(2).toString('utf16le'); }
  else if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) { s = b.subarray(3).toString('utf8'); }
  else { s = [...b].map((c) => PDF_DOC[c] ?? '').join(''); }
  // UTF-16 text strings may embed language escapes (U+001B … U+001B).
  return s.replace(/\u001b[^\u001b]*\u001b/g, '').replace(/\u0000/g, '').trim();
}
