import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { WebError } from '../core/web/types';
import { docxToDoc, pptxToDoc, xlsxToDoc } from '../core/web/extract/office';
import { pdfToDoc } from '../core/web/extract/pdf';
import { readZip } from '../core/web/extract/zip';

/* ------------------------------------------------------------------ PDF fixtures */

type PdfObj = string | Buffer;
const bin = (x: string | Buffer) => (typeof x === 'string' ? Buffer.from(x, 'latin1') : x);

/** "<< dict /Length n >> stream … endstream" with the exact byte length. */
function stream(dict: string, data: string | Buffer): Buffer {
  const d = bin(data);
  return Buffer.concat([bin(`<< ${dict} /Length ${d.length} >>\nstream\n`), d, bin('\nendstream')]);
}

/** Minimal PDF writer: objects numbered from 1, a classic xref table and trailer (optionally with wrong offsets). */
function buildPdf(objs: PdfObj[], o: { trailer?: string; brokenXref?: boolean } = {}): Buffer {
  const chunks: Buffer[] = [bin('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
  let len = chunks[0].length;
  const offs: number[] = [];
  objs.forEach((body, i) => {
    offs.push(len);
    const b = Buffer.concat([bin(`${i + 1} 0 obj\n`), bin(body), bin('\nendobj\n')]);
    chunks.push(b); len += b.length;
  });
  const rows = offs.map((x) => `${String(o.brokenXref ? 77 : x).padStart(10, '0')} 00000 n \n`).join('');
  chunks.push(bin(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${o.trailer ?? ''} >>\n`
    + `startxref\n${o.brokenXref ? 999999 : len}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

/**
 * Catalog (1), Pages (2), font F1 (3), then a Page + content stream per entry of `contents` (4, 5, 6, 7…);
 * `extra` objects follow, numbered from 4 + 2 × pages.
 */
function textPdf(contents: Array<string | Buffer>, o: { font?: string; extra?: PdfObj[]; flate?: boolean; resources?: string; trailer?: string; brokenXref?: boolean } = {}): Buffer {
  const pageIds = contents.map((_, i) => 4 + i * 2);
  const objs: PdfObj[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${contents.length} >>`,
    o.font ?? HELVETICA,
  ];
  contents.forEach((c, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> ${o.resources ?? ''} >> /Contents ${pageIds[i] + 1} 0 R >>`);
    objs.push(o.flate ? stream('/Filter /FlateDecode', zlib.deflateSync(bin(c))) : stream('', c));
  });
  objs.push(...(o.extra ?? []));
  return buildPdf(objs, o);
}

const esc = (s: string) => s.replace(/[\\()]/g, '\\$&');
/** One BT…ET block per line: [x, y, size, text]. */
const lines = (ls: Array<[number, number, number, string]>) => ls.map(([x, y, s, t]) => `BT /F1 ${s} Tf ${x} ${y} Td (${esc(t)}) Tj ET`).join('\n');

const REPORT = [
  'BT /F1 24 Tf 72 740 Td (Annual Report) Tj ET',
  'BT /F1 12 Tf 14 TL 72 700 Td (Hello World from the first paragraph of text.) Tj',
  '0 -14 Td [(Ker)-30(ning) -500 (gap) ( Caf\\351)] TJ',
  '(Third line) \' ET',
].join('\n');

function assertParseError(fn: () => unknown): void {
  assert.throws(fn, (e: unknown) => e instanceof WebError && e.code === 'parse');
}

/* ------------------------------------------------------------------ PDF tests */

test('pdf (a): uncompressed Tj/TJ/Td/\' with WinAnsi Helvetica, heading, metadata', () => {
  const info = '<< /Title <FEFF005200E900730075006D00E9> /Author (Jane Doe) /CreationDate (D:20240115103000+01\'00\') >>';
  const doc = pdfToDoc(textPdf([REPORT], { extra: [info], trailer: '/Info 6 0 R' }));
  assert.equal(doc.kind, 'pdf');
  assert.equal(doc.pages, 1);
  assert.match(doc.markdown, /^<!-- page 1 -->\n\n## Annual Report\n\n/);
  assert.match(doc.markdown, /Hello World from the first paragraph of text\. Kerning gap Café Third line/);
  assert.equal(doc.title, 'Résumé');
  assert.equal(doc.author, 'Jane Doe');
  assert.equal(doc.published, '2024-01-15T09:30:00Z');
  assert.deepEqual(doc.warnings, []);
});

test('pdf (b): FlateDecode content stream', () => {
  const doc = pdfToDoc(textPdf([REPORT], { flate: true }));
  assert.match(doc.markdown, /## Annual Report/);
  assert.match(doc.markdown, /Kerning gap Café/);
});

test('pdf (c): Type0 font with a ToUnicode CMap (bfchar + bfrange incl. array form)', () => {
  const cmap = [
    '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
    '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange',
    '2 beginbfchar', '<0001> <00E9>', '<0002> <0020>', 'endbfchar',
    '2 beginbfrange', '<0010> <0012> <03B1>', '<0020> <0021> [<0041> <D83DDE00>]', 'endbfrange',
    'endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end',
  ].join('\n');
  const font = '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+NotoSans /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>';
  const cid = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+NotoSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 600 /W [1 [500 300] 16 18 550] >>';
  const doc = pdfToDoc(textPdf(['BT /F1 12 Tf 72 700 Td <00010002001000110012000200200021> Tj <0002> Tj [<00010010> -600 <0011>] TJ 0 -14 Td <001000110012001000110012001000110012001000110012> Tj ET'], { font, extra: [cid, stream('', cmap)] }));
  assert.match(doc.markdown, /é αβγ A😀 éα β αβγαβγαβγαβγ/);
  assert.deepEqual(doc.warnings, []);
});

test('pdf (d): two pages, repeated footer with page numbers removed', () => {
  const page = (body: string, n: number) => lines([[72, 720, 12, body], [250, 30, 9, `ACME Confidential - Page ${n}`]]);
  const doc = pdfToDoc(textPdf([page('Alpha introduction text.', 1), page('Beta conclusion text.', 2)]));
  assert.equal(doc.pages, 2);
  assert.equal(doc.markdown, '<!-- page 1 -->\n\nAlpha introduction text.\n\n<!-- page 2 -->\n\nBeta conclusion text.');
});

test('pdf (e): objects inside an /ObjStm found through a predictor-encoded xref stream', () => {
  const content = stream('', lines([[72, 700, 12, 'Packed objects work']]));
  const packed = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    HELVETICA,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
  ];
  let body = ''; const pairs: string[] = [];
  packed.forEach((o, i) => { pairs.push(`${i + 1} ${body.length}`); body += `${o}\n`; });
  const headerTxt = `${pairs.join(' ')}\n`;
  const objStm = stream(`/Type /ObjStm /N 4 /First ${headerTxt.length} /Filter /FlateDecode`, zlib.deflateSync(bin(headerTxt + body)));

  const chunks: Buffer[] = [bin('%PDF-1.5\n')];
  let len = chunks[0].length;
  const at: number[] = [];
  for (const [n, o] of [[5, content], [6, objStm]] as Array<[number, Buffer]>) {
    at[n] = len;
    const b = Buffer.concat([bin(`${n} 0 obj\n`), o, bin('\nendobj\n')]);
    chunks.push(b); len += b.length;
  }
  at[7] = len;
  // W [1 2 2]: type, field 2, field 3; rows PNG-"Up"-predicted (Predictor 12, Columns 5).
  const rows: number[][] = [[0, 0, 0, 0xff, 0xff]];
  for (let i = 0; i < 4; i++) { rows.push([2, 0, 6, 0, i]); }
  for (const n of [5, 6, 7]) { rows.push([1, at[n] >> 8, at[n] & 0xff, 0, 0]); }
  const raw: number[] = [];
  rows.forEach((r, i) => { raw.push(2, ...r.map((v, k) => (v - (i ? rows[i - 1][k] : 0)) & 0xff)); });
  const xref = stream('/Type /XRef /Size 8 /W [1 2 2] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 5 >>', zlib.deflateSync(Buffer.from(raw)));
  chunks.push(bin('7 0 obj\n'), xref, bin(`\nendobj\nstartxref\n${at[7]}\n%%EOF\n`));
  const doc = pdfToDoc(Buffer.concat(chunks));
  assert.equal(doc.pages, 1);
  assert.match(doc.markdown, /Packed objects work/);
});

test('pdf (f): a word hyphenated across a line break is joined', () => {
  const doc = pdfToDoc(textPdf([lines([[72, 700, 12, 'Fast retrieval of infor-'], [72, 686, 12, 'mation is the goal']])]));
  assert.match(doc.markdown, /Fast retrieval of information is the goal/);
});

/* ---- (g) Standard security handler, computed here with the spec algorithms ---- */

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const md5 = (b: Buffer): Buffer => crypto.createHash('md5').update(b).digest();
function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
const xorKey = (k: Buffer, i: number) => Buffer.from(k.map((b) => b ^ i));

/** Algorithms 3, 2 and 5 (R3/R4, 128-bit) for an empty user password and the given owner password. */
function security(ownerPw: string, id0: Buffer, p: number): { o: Buffer; u: Buffer; key: Buffer } {
  let ok = md5(Buffer.concat([bin(ownerPw), PAD]).subarray(0, 32));
  for (let i = 0; i < 50; i++) { ok = md5(ok); }
  let o = rc4(ok, PAD);
  for (let i = 1; i <= 19; i++) { o = rc4(xorKey(ok, i), o); }
  const pb = Buffer.alloc(4); pb.writeInt32LE(p);
  let key: Buffer = md5(Buffer.concat([PAD, o, pb, id0]));
  for (let i = 0; i < 50; i++) { key = md5(key); }
  let u: Buffer = md5(Buffer.concat([PAD, id0]));
  for (let i = 0; i < 20; i++) { u = rc4(xorKey(key, i), u); }
  return { o, u: Buffer.concat([u, Buffer.alloc(16, 7)]), key };
}

function objKey(key: Buffer, num: number, aes: boolean): Buffer {
  return md5(Buffer.concat([key, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0]), bin(aes ? 'sAlT' : '')]));
}

function encryptedPdf(mode: 'rc4' | 'aes', o: { badU?: boolean } = {}): Buffer {
  const id0 = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  const p = -1084;
  const sec = security('owner-secret', id0, p);
  const enc = (num: number, data: Buffer) => {
    const k = objKey(sec.key, num, mode === 'aes');
    if (mode === 'rc4') { return rc4(k, data); }
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-128-cbc', k, iv);
    return Buffer.concat([iv, c.update(data), c.final()]);
  };
  const u = o.badU ? crypto.randomBytes(32) : sec.u;
  const encDict = mode === 'rc4'
    ? `<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${p} /O <${sec.o.toString('hex')}> /U <${u.toString('hex')}> >>`
    : `<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF /P ${p} /O <${sec.o.toString('hex')}> /U <${u.toString('hex')}> >>`;
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    HELVETICA,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    stream('', enc(5, bin(lines([[72, 700, 12, 'Owner password only (secret)']])))),
    `<< /Title <${enc(6, bin('Locked Title')).toString('hex')}> >>`,
    encDict,
  ], { trailer: `/Info 6 0 R /Encrypt 7 0 R /ID [<${id0.toString('hex')}> <${id0.toString('hex')}>]` });
}

test('pdf (g): RC4 128-bit encryption with an empty user password is decrypted', () => {
  const doc = pdfToDoc(encryptedPdf('rc4'));
  assert.match(doc.markdown, /Owner password only \(secret\)/);
  assert.equal(doc.title, 'Locked Title');
  assert.deepEqual(doc.warnings, []);
});

test('pdf (g2): AESV2 encryption with an empty user password is decrypted', () => {
  const doc = pdfToDoc(encryptedPdf('aes'));
  assert.match(doc.markdown, /Owner password only \(secret\)/);
  assert.equal(doc.title, 'Locked Title');
});

test('pdf (g3): a real user password yields a warning and no text, not an exception', () => {
  const doc = pdfToDoc(encryptedPdf('rc4', { badU: true }));
  assert.equal(doc.markdown, '');
  assert.ok(doc.warnings.includes('This PDF is encrypted and its text could not be read'));
});

test('pdf (h): broken xref offsets and a wrong /Length still parse', () => {
  const good = textPdf([lines([[72, 700, 12, 'Recovered despite damage']])], { brokenXref: true });
  const s = good.toString('latin1').replace(/\/Length (\d+)/, '/Length 3');
  const doc = pdfToDoc(Buffer.from(s, 'latin1'));
  assert.match(doc.markdown, /Recovered despite damage/);
  // Truncated mid-file (no xref, no trailer): pages are still found by scanning.
  const cut = good.subarray(0, good.indexOf('xref'));
  assert.match(pdfToDoc(cut).markdown, /Recovered despite damage/);
  // An object with an unterminated string must not swallow the objects after it.
  const damaged = buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [5 0 R] /Count 1 >>',
    '<< /Broken (never closed >>',
    HELVETICA,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    stream('', lines([[72, 700, 12, 'Objects after the damage']])),
  ]);
  assert.match(pdfToDoc(damaged).markdown, /Objects after the damage/);
});

test('pdf: link annotations become links; a stream /F file spec is not taken for a filter', () => {
  const annot = '<< /Type /Annot /Subtype /Link /Rect [72 690 200 712] /A << /S /URI /URI (https://example.com/paper) >> >>';
  const objs: PdfObj[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    HELVETICA,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>',
    stream('/F (external.dat)', lines([[72, 700, 12, 'See the paper online']])),
    annot,
  ];
  const doc = pdfToDoc(buildPdf(objs));
  assert.match(doc.markdown, /See the paper online/);
  assert.deepEqual(doc.links, [{ text: 'https://example.com/paper', url: 'https://example.com/paper' }]);
});

test('pdf (i): garbage input throws WebError "parse"', () => {
  assertParseError(() => pdfToDoc(Buffer.from('<html>definitely not a pdf</html>')));
  assertParseError(() => pdfToDoc(crypto.randomBytes(4096)));
  assertParseError(() => pdfToDoc(Buffer.from('%PDF-1.4\n%%EOF\n')));
});

test('pdf (j): images only → scanned-PDF warning and no text', () => {
  const img = stream('/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode', crypto.randomBytes(64));
  const doc = pdfToDoc(textPdf(['q 200 0 0 100 72 600 cm /Im1 Do Q'], { resources: '/XObject << /Im1 6 0 R >>', extra: [img] }));
  assert.equal(doc.pages, 1);
  assert.equal(doc.markdown, '');
  assert.ok(doc.warnings.includes('No text layer: this looks like a scanned PDF (OCR it instead)'));
});

test('pdf: Form XObject text is read and inline images are skipped', () => {
  const form = stream('/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >>',
    lines([[72, 600, 12, 'Inside the form']]));
  const content = Buffer.concat([
    bin(`${lines([[72, 700, 12, 'Before the image']])}\nq 10 0 0 10 72 650 cm BI /W 4 /H 1 /BPC 8 /CS /G ID `),
    Buffer.from([0x45, 0x49, 0x0a, 0x00, 0xff]), // the bytes "EI" inside the image data must not end it
    bin(' EI Q\n/Fm1 Do\n'),
  ]);
  const doc = pdfToDoc(textPdf([content], { resources: '/XObject << /Fm1 6 0 R >>', extra: [form] }));
  assert.match(doc.markdown, /Before the image/);
  assert.match(doc.markdown, /Inside the form/);
});

test('pdf: two-column layout reads the left column before the right one', () => {
  const ls: Array<[number, number, number, string]> = [];
  for (let i = 0; i < 8; i++) {
    ls.push([72, 700 - i * 14, 10, `Left column line ${i + 1} text`]);
    ls.push([330, 700 - i * 14, 10, `Right column line ${i + 1} text`]);
  }
  const md = pdfToDoc(textPdf([lines(ls)])).markdown;
  assert.ok(md.indexOf('Left column line 8') < md.indexOf('Right column line 1'), md);
  assert.ok(!/Left column line 1 text Right/.test(md));
});

/* ------------------------------------------------------------------ ZIP fixtures */

const crc32 = (() => {
  const native = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32;
  if (native) { return (b: Buffer) => native(b) >>> 0; }
  const t = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return c >>> 0; });
  return (b: Buffer) => { let c = 0xffffffff; for (const x of b) { c = t[(c ^ x) & 255] ^ (c >>> 8); } return (c ^ 0xffffffff) >>> 0; };
})();

interface ZipEntry { name: string; data: string | Buffer; store?: boolean; declaredSize?: number; encrypted?: boolean }

/** ZIP writer; `zip64` writes ZIP64 extra fields and end records, `prefix` prepends bytes without fixing offsets (like a self-extractor). */
function buildZip(entries: ZipEntry[], o: { zip64?: boolean; prefix?: Buffer } = {}): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = [];
  const u64 = (v: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(v % 0x100000000, 0); b.writeUInt32LE(Math.floor(v / 0x100000000), 4); return b; };
  const MAX32 = 0xffffffff;
  let off = 0;
  for (const e of entries) {
    const data = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data;
    const comp = e.store ? data : zlib.deflateRawSync(data);
    const name = Buffer.from(e.name, 'utf8');
    const size = e.declaredSize ?? data.length;
    const flags = 0x800 | (e.encrypted ? 1 : 0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(e.store ? 0 : 8, 8);
    lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(name.length, 26);
    const extra = o.zip64 ? Buffer.concat([Buffer.from([1, 0, 24, 0]), u64(size), u64(comp.length), u64(off)]) : Buffer.alloc(0);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(45, 4); ch.writeUInt16LE(45, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(e.store ? 0 : 8, 10);
    ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(o.zip64 ? MAX32 : comp.length, 20); ch.writeUInt32LE(o.zip64 ? MAX32 : size, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(extra.length, 30); ch.writeUInt32LE(o.zip64 ? MAX32 : off, 42);
    locals.push(lh, name, comp); central.push(ch, name, extra);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const tail: Buffer[] = [];
  if (o.zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0); u64(44).copy(rec, 4); rec.writeUInt16LE(45, 12); rec.writeUInt16LE(45, 14);
    u64(entries.length).copy(rec, 24); u64(entries.length).copy(rec, 32); u64(cd.length).copy(rec, 40); u64(off).copy(rec, 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0); u64(off + cd.length).copy(loc, 8); loc.writeUInt32LE(1, 16);
    tail.push(rec, loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(o.zip64 ? 0xffff : entries.length, 8); eocd.writeUInt16LE(o.zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(o.zip64 ? MAX32 : cd.length, 12); eocd.writeUInt32LE(o.zip64 ? MAX32 : off, 16);
  return Buffer.concat([o.prefix ?? Buffer.alloc(0), ...locals, cd, ...tail, eocd]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_HL = `${NS_REL}/hyperlink`;
const rels = (rs: Array<[string, string, string, boolean?]>) => `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
  rs.map(([id, type, target, ext]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"${ext ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
const core = (title: string) => `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${title}</dc:title><dc:creator>Ann Author</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2024-03-01T10:00:00Z</dcterms:created></cp:coreProperties>`;

/* ------------------------------------------------------------------ ZIP tests */

test('zip: stored and deflated entries, names normalised, directories skipped', () => {
  const big = 'x'.repeat(5000);
  const files = readZip(buildZip([
    { name: 'dir/', data: '', store: true },
    { name: 'dir/a.txt', data: 'stored text', store: true },
    { name: 'dir\\b.txt', data: big },
    { name: '/abs/ünï.xml', data: '<x/>' },
  ]));
  assert.deepEqual([...files.keys()], ['dir/a.txt', 'dir/b.txt', 'abs/ünï.xml']);
  assert.equal(files.get('dir/a.txt')!.toString(), 'stored text');
  assert.equal(files.get('dir/b.txt')!.toString(), big);
});

test('zip: ZIP64 records and a self-extractor prefix are handled', () => {
  const entries: ZipEntry[] = [{ name: 'a.txt', data: 'alpha', store: true }, { name: 'b.txt', data: 'beta '.repeat(100) }];
  const prefix = Buffer.from('MZ fake self-extractor stub '.repeat(10));
  for (const opts of [{ zip64: true }, { prefix }, { zip64: true, prefix }]) {
    const files = readZip(buildZip(entries, opts));
    assert.equal(files.get('a.txt')?.toString(), 'alpha', JSON.stringify(Object.keys(opts)));
    assert.equal(files.get('b.txt')?.toString(), 'beta '.repeat(100));
  }
});

test('zip: not a ZIP → parse; encrypted entry → unsupported', () => {
  assertParseError(() => readZip(Buffer.from('PK but not really')));
  assert.throws(() => readZip(buildZip([{ name: 'secret.txt', data: 'x', store: true, encrypted: true }])),
    (e: unknown) => e instanceof WebError && e.code === 'unsupported');
});

test('zip: bomb limits (total size, lying sizes, compression ratio, entry count) → too_large', () => {
  const tooLarge = (e: unknown) => e instanceof WebError && e.code === 'too_large';
  const zeros = Buffer.alloc(4 * 1024 * 1024);
  assert.throws(() => readZip(buildZip([{ name: 'z.bin', data: zeros }]), { maxTotalBytes: 1024 * 1024 }), tooLarge);
  // The central directory claims 10 bytes; the stream inflates to megabytes.
  assert.throws(() => readZip(buildZip([{ name: 'z.bin', data: zeros, declaredSize: 10 }]), { maxTotalBytes: 1024 * 1024 }), tooLarge);
  assert.throws(() => readZip(buildZip([{ name: 'z.bin', data: 'tiny', declaredSize: 50 * 1024 * 1024 }])), tooLarge);
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.txt`, data: 'x', store: true }));
  assert.throws(() => readZip(buildZip(many), { maxEntries: 20 }), tooLarge);
  assert.equal(readZip(buildZip(many)).size, 30);
});

/* ------------------------------------------------------------------ docx */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const wp = (text: string, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const num = (id: number, lvl: number) => `<w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${id}"/></w:numPr>`;
const tc = (t: string) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${wp(t)}</w:tc>`;

function docxFixture(): Buffer {
  const body = [
    wp('Project Plan', '<w:pStyle w:val="Title"/>'),
    wp('Goals &amp; Scope', '<w:pStyle w:val="Heading2"/>'),
    '<w:p><w:r><w:t xml:space="preserve">Read the </w:t></w:r><w:hyperlink r:id="rId5" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>spec</w:t></w:r></w:hyperlink>'
      + '<w:r><w:t xml:space="preserve"> first.</w:t></w:r><w:r><w:tab/><w:t>Tabbed</w:t><w:br/><w:t>Next line</w:t></w:r></w:p>',
    wp('First bullet', num(1, 0)), wp('Nested bullet', num(1, 1)), wp('Second bullet', num(1, 0)),
    wp('Step one', num(2, 0)), wp('Step two', num(2, 0)),
    `<w:tbl><w:tblPr/><w:tr>${tc('Name')}${tc('Qty')}</w:tr><w:tr>${tc('Bolt|M4')}${tc('12')}</w:tr></w:tbl>`,
    '<w:p><w:del w:id="1" w:author="x"><w:r><w:delText>removed</w:delText></w:r></w:del><w:r><w:t>Kept &#x2014; &lt;ok&gt;</w:t></w:r></w:p>',
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>',
  ].join('\n');
  const numbering = `${XML}<w:numbering ${W}>
    <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
    <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  return buildZip([
    { name: '[Content_Types].xml', data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    { name: 'word/document.xml', data: `${XML}<w:document ${W}><w:body>${body}</w:body></w:document>` },
    { name: 'word/_rels/document.xml.rels', data: rels([['rId5', REL_HL, 'https://example.com/spec', true], ['rId9', REL_HL, 'http://example.org/extra', true], ['rId1', `${NS_REL}/styles`, 'styles.xml']]) },
    { name: 'word/numbering.xml', data: numbering, store: true },
    { name: 'docProps/core.xml', data: core('Plan Title') },
  ]);
}

test('docx: headings, paragraph text, bullet and numbered lists, table, hyperlink, core properties', () => {
  const doc = docxToDoc(docxFixture());
  assert.equal(doc.kind, 'docx');
  assert.equal(doc.title, 'Plan Title');
  assert.equal(doc.author, 'Ann Author');
  assert.equal(doc.published, '2024-03-01T10:00:00Z');
  assert.equal(doc.markdown, [
    '# Project Plan',
    '## Goals & Scope',
    'Read the [spec](https://example.com/spec) first.\tTabbed\nNext line',
    '- First bullet\n  - Nested bullet\n- Second bullet\n1. Step one\n2. Step two',
    '| Name | Qty |\n| --- | --- |\n| Bolt\\|M4 | 12 |',
    'Kept — <ok>',
  ].join('\n\n'));
  assert.deepEqual(doc.links, [{ text: 'spec', url: 'https://example.com/spec' }, { text: 'http://example.org/extra', url: 'http://example.org/extra' }]);
  assert.deepEqual(doc.images, []);
});

test('docx: a ZIP without word/document.xml is a parse error', () => {
  assertParseError(() => docxToDoc(buildZip([{ name: 'xl/workbook.xml', data: '<workbook/>' }])));
});

/* ------------------------------------------------------------------ xlsx */

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function xlsxFixture(): Buffer {
  const sheet1 = `${XML}<worksheet ${S}><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>3</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>45306</v></c><c r="D2"><v>9.99</v></c></row>
    <row r="4"><c r="A4" t="inlineStr"><is><t>Gadget</t></is></c><c r="B4" s="2"><v>45306.5</v></c><c r="C4" t="b"><v>1</v></c><c r="D4" t="e"><v>#DIV/0!</v></c></row>
    <row r="5"><c r="A5" t="str"><f>A1&amp;"x"</f><v>Itemx</v></c><c r="D5"><f>D2*3</f><v>29.970000000000002</v></c></row>
  </sheetData></worksheet>`;
  const sheet2 = `${XML}<worksheet ${S}><sheetData><row r="1"><c r="A1" t="s"><v>4</v></c></row></sheetData>
    <hyperlinks><hyperlink ref="A1" r:id="rId1"/></hyperlinks></worksheet>`;
  return buildZip([
    { name: 'xl/workbook.xml', data: `${XML}<workbook ${S}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: rels([['rId1', `${NS_REL}/worksheet`, 'worksheets/sheet1.xml'], ['rId2', `${NS_REL}/worksheet`, '/xl/worksheets/sheet2.xml']]) },
    { name: 'xl/sharedStrings.xml', data: `${XML}<sst ${S} count="5" uniqueCount="5"><si><t>Item</t></si><si><t>Date</t></si><si><r><t>Wid</t></r><r><rPr><b/></rPr><t>get</t></r><rPh><t>ignored</t></rPh></si><si><t>Price</t></si><si><t>Hello &amp; welcome</t></si></sst>` },
    { name: 'xl/styles.xml', data: `${XML}<styleSheet ${S}><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>` },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1 },
    { name: 'xl/worksheets/sheet2.xml', data: sheet2 },
    { name: 'xl/worksheets/_rels/sheet2.xml.rels', data: rels([['rId1', REL_HL, 'https://example.com/sheet', true]]) },
  ]);
}

test('xlsx: two sheets, shared/inline strings, numbers, dates, booleans, errors, column gaps, hyperlinks', () => {
  const doc = xlsxToDoc(xlsxFixture());
  assert.equal(doc.kind, 'xlsx');
  assert.equal(doc.pages, 2);
  assert.equal(doc.markdown, [
    '## Data',
    '| Item | Date |  | Price |\n| --- | --- | --- | --- |\n| Widget | 2024-01-15 |  | 9.99 |\n| Gadget | 2024-01-15T12:00:00 | TRUE | #DIV/0! |\n| Itemx |  |  | 29.97 |',
    '## Notes',
    '| Hello & welcome |\n| --- |',
  ].join('\n\n'));
  assert.deepEqual(doc.links, [{ text: 'Hello & welcome', url: 'https://example.com/sheet' }]);
});

test('xlsx: large sheets are capped with a note', () => {
  const rows = Array.from({ length: 600 }, (_, r) => `<row r="${r + 1}">${Array.from({ length: 60 }, (_, c) => `<c><v>${r * 100 + c}</v></c>`).join('')}</row>`).join('');
  const doc = xlsxToDoc(buildZip([
    { name: 'xl/workbook.xml', data: `<workbook ${S}><sheets><sheet name="Big" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: rels([['rId1', `${NS_REL}/worksheet`, 'worksheets/sheet1.xml']]) },
    { name: 'xl/worksheets/sheet1.xml', data: `<worksheet ${S}><sheetData>${rows}</sheetData></worksheet>` },
  ]));
  const tableLines = doc.markdown.split('\n').filter((l) => l.startsWith('|'));
  assert.equal(tableLines.length, 501);
  assert.equal(tableLines[0].split(' | ').length, 50);
  assert.match(doc.markdown, /_Showing first 500 of 600 rows and first 50 of 60 columns\._$/);
});

/* ------------------------------------------------------------------ pptx */

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const sp = (ph: string, paras: string) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`;
const ap = (t: string, ppr = '') => `<a:p>${ppr}<a:r><a:rPr lang="en-US"/><a:t>${t}</a:t></a:r></a:p>`;
const slide = (shapes: string) => `${XML}<p:sld ${P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`;

function pptxFixture(): Buffer {
  const intro = slide([
    sp('<p:ph type="title"/>', ap('Intro')),
    sp('<p:ph idx="1"/>', ap('Point A') + ap('Sub point', '<a:pPr lvl="1"/>')
      + '<a:p><a:r><a:rPr><a:hlinkClick r:id="rId7"/></a:rPr><a:t>Docs</a:t></a:r></a:p>'),
    sp('<p:ph type="sldNum" idx="12"/>', ap('1')),
  ].join(''));
  const details = slide([
    sp('<p:ph type="ctrTitle"/>', ap('Details')),
    sp('', ap('Plain text box')),
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="t"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><a:graphic><a:graphicData><a:tbl>'
      + '<a:tr><a:tc><a:txBody>' + ap('K') + '</a:txBody></a:tc><a:tc><a:txBody>' + ap('V') + '</a:txBody></a:tc></a:tr>'
      + '<a:tr><a:tc><a:txBody>' + ap('x') + '</a:txBody></a:tc><a:tc><a:txBody>' + ap('1') + '</a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>',
  ].join(''));
  const notes = `${XML}<p:notes ${P}><p:cSld><p:spTree>${sp('<p:ph type="sldImg"/>', '')}${sp('<p:ph type="body" idx="1"/>', ap('Remember to') + ap('smile'))}</p:spTree></p:cSld></p:notes>`;
  return buildZip([
    { name: 'ppt/presentation.xml', data: `${XML}<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: rels([['rId2', `${NS_REL}/slide`, 'slides/slide1.xml'], ['rId3', `${NS_REL}/slide`, 'slides/slide2.xml']]) },
    { name: 'ppt/slides/slide2.xml', data: intro },
    { name: 'ppt/slides/_rels/slide2.xml.rels', data: rels([['rId7', REL_HL, 'https://example.com/docs', true], ['rId2', `${NS_REL}/notesSlide`, '../notesSlides/notesSlide1.xml']]) },
    { name: 'ppt/slides/slide1.xml', data: details },
    { name: 'ppt/notesSlides/notesSlide1.xml', data: notes },
  ]);
}

test('pptx: slide order from sldIdLst, titles, bullets, tables, links, speaker notes', () => {
  const doc = pptxToDoc(pptxFixture());
  assert.equal(doc.kind, 'pptx');
  assert.equal(doc.pages, 2);
  assert.equal(doc.title, 'Intro');
  assert.equal(doc.markdown, [
    '<!-- page 1 -->',
    '## Intro',
    '- Point A\n  - Sub point\n- [Docs](https://example.com/docs)',
    '> Notes: Remember to\n> smile',
    '<!-- page 2 -->',
    '## Details',
    'Plain text box',
    '| K | V |\n| --- | --- |\n| x | 1 |',
  ].join('\n\n'));
  assert.deepEqual(doc.links, [{ text: 'Docs', url: 'https://example.com/docs' }]);
});
