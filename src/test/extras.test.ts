import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { MAX_IMAGES, decodeDataUrl, screenshotBlock, validateImages } from '../core/attachments';
import { ocrImage } from '../core/ocr';
import { UsageTracker, dayKey } from '../core/usage';
import { withFileLock, lockCount } from '../core/locks';
import { createFsTools } from '../core/fstools';
import { tmpDir } from './helpers';

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ROOT = path.join(__dirname, '..', '..');

/* ---------------------------------------------------------------- attachments */

test('attachments: decode valid images, reject non-images, bad types and oversize data', () => {
  const d = decodeDataUrl(PNG_1x1);
  assert.equal(d.ext, 'png'); assert.ok(d.buf.length > 0);
  assert.throws(() => decodeDataUrl('data:text/html;base64,PGI+'), /not a base64 image/);
  assert.throws(() => decodeDataUrl('data:image/x-evil;base64,AAAA'), /unsupported image type/);
  assert.throws(() => decodeDataUrl(`data:image/png;base64,${Buffer.alloc(11 * 1024 * 1024).toString('base64')}`), /larger than 10 MB/);
});

test('attachments: validation caps count, sanitizes names, keeps only small data-URL thumbnails', () => {
  const many = Array.from({ length: MAX_IMAGES + 2 }, (_, i) => ({ name: `../../evil<${i}>.png`, mime: 'image/png', dataUrl: PNG_1x1, thumb: PNG_1x1 }));
  const r = validateImages([...many, { name: 'bad', dataUrl: 'nope' }, { name: 't', mime: 'image/png', dataUrl: PNG_1x1, thumb: 'javascript:alert(1)' }]);
  assert.equal(r.ok.length, MAX_IMAGES);
  assert.ok(r.ok.every((i) => !/[\\/<>]/.test(i.name)), 'names cannot contain path or HTML characters');
  assert.equal(r.errors.length, 4);
  assert.deepEqual(validateImages('nope'), { ok: [], errors: [] });
  assert.equal(validateImages([{ name: 't', mime: 'image/png', dataUrl: PNG_1x1, thumb: 'javascript:alert(1)' }]).ok[0].thumb, undefined);
});

test('attachments: the prompt tells the model it is OCR text and includes failures honestly', () => {
  const b = screenshotBlock([{ name: 'a.png', text: 'Error 42' }, { name: 'b"x.png', error: 'engine missing' }, { name: 'c.png', text: '  ' }]);
  assert.match(b, /extracted locally with OCR/);
  assert.match(b, /NOT available to you/);
  assert.match(b, /<screenshot name="a.png">\nError 42\n<\/screenshot>/);
  assert.match(b, /name="b'x.png">\n\(text could not be extracted: engine missing\)/);
  assert.match(b, /\(no readable text found in this image\)/);
  assert.equal(screenshotBlock([]), '');
});

test('ocr: reads text from a real screenshot with the Windows engine', { skip: process.platform !== 'win32' }, async () => {
  const dir = await tmpDir('ocr-');
  const png = path.join(dir, 'probe.png');
  const ps = `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap 700,90; $g=[System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::White); $f = New-Object System.Drawing.Font 'Segoe UI',18; $g.DrawString('Status orange means Degraded', $f, [System.Drawing.Brushes]::Black, 10, 20); $b.Save('${png}', [System.Drawing.Imaging.ImageFormat]::Png)`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps]);
  const text = await ocrImage(ROOT, await fs.readFile(png), 'png');
  assert.match(text, /Status orange means Degraded/);
});

test('ocr: a missing engine is reported clearly instead of crashing', async () => {
  await assert.rejects(ocrImage(ROOT, Buffer.from('x'), 'png', 5000, 'linux-without-tesseract'), /tesseract|not found/i);
});

/* ---------------------------------------------------------------- usage */

test('usage: real gateway numbers are summed per day and per session; estimates when missing; failures counted', async () => {
  let saved: any;
  const now = new Date('2026-11-19T10:00:00');
  const u = new UsageTracker({}, (d) => { saved = d; }, () => now);
  const llm = u.wrap(async () => ({ content: 'hello', toolCalls: [], usage: { prompt: 100, completion: 20 } }), 's1');
  await llm({} as any, [{ role: 'user', content: 'x' }], [], () => {}, new AbortController().signal);
  await llm({} as any, [{ role: 'user', content: 'x' }], [], () => {}, new AbortController().signal);
  const noUsage = u.wrap(async () => ({ content: 'x'.repeat(35), toolCalls: [] }), 's2');
  await noUsage({} as any, [{ role: 'user', content: 'y'.repeat(70) }], [], () => {}, new AbortController().signal);
  const failing = u.wrap(async () => { throw new Error('502'); }, 's1');
  await assert.rejects(failing({} as any, [], [], () => {}, new AbortController().signal));
  const cancelled = u.wrap(async () => { throw new Error('Cancelled'); }, 's1');
  await assert.rejects(cancelled({} as any, [], [], () => {}, new AbortController().signal));

  const s = u.summary();
  assert.equal(s.today.requests, 4, 'cancellations are not counted as requests');
  assert.equal(s.today.errors, 1);
  assert.equal(s.today.estimated, 1);
  assert.equal(s.today.prompt, 200 + Math.ceil((70 + 16) / 3.5));
  assert.equal(s.today.completion, 40 + 10);
  assert.deepEqual(u.session('s1'), { prompt: 200, completion: 40, requests: 2 });
  assert.equal(s.days.length, 7);
  assert.equal(s.days[6].day, dayKey(now));
  assert.ok(saved[dayKey(now)]);
});

test('usage: old days are pruned and the 7-day window sums correctly', () => {
  const now = new Date('2026-11-19T10:00:00');
  const data: any = { '2026-09-01': { requests: 9, prompt: 9, completion: 9, errors: 0, estimated: 0 }, '2026-11-15': { requests: 2, prompt: 10, completion: 5, errors: 0, estimated: 0 } };
  const u = new UsageTracker(data, () => {}, () => now);
  u.record('s', { prompt: 1, completion: 1 }, [], '');
  assert.equal(data['2026-09-01'], undefined);
  assert.equal(u.summary().week.requests, 3);
});

/* ---------------------------------------------------------------- locks */

test('locks: work on the same key is serialized, different keys run in parallel, nothing leaks', async () => {
  const order: string[] = [];
  const slow = (tag: string, ms: number) => withFileLock('/same/file', async () => { order.push(`${tag}+`); await new Promise((r) => setTimeout(r, ms)); order.push(`${tag}-`); });
  await Promise.all([slow('a', 30), slow('b', 5), slow('c', 1)]);
  assert.deepEqual(order, ['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
  let overlap = false; let inA = false;
  await Promise.all([
    withFileLock('/x', async () => { inA = true; await new Promise((r) => setTimeout(r, 20)); inA = false; }),
    withFileLock('/y', async () => { await new Promise((r) => setTimeout(r, 5)); overlap = inA; }),
  ]);
  assert.equal(overlap, true);
  await assert.rejects(withFileLock('/z', async () => { throw new Error('boom'); }), /boom/);
  await withFileLock('/z', async () => undefined);
  assert.equal(lockCount(), 0);
});

test('locks: parallel agents editing the same file never lose each other\'s changes', async () => {
  const root = await tmpDir('lock-');
  const lines = Array.from({ length: 20 }, (_, i) => `<<item-${i}>>`);
  await fs.writeFile(path.join(root, 'shared.txt'), lines.join('\n'));
  const edit = createFsTools().find((t) => t.spec.function.name === 'edit_file')!;
  // The slow snapshot widens the read→write window, so without the lock most of these edits would be lost.
  const ctx = { root, signal: new AbortController().signal, snapshot: async () => { await new Promise((r) => setTimeout(r, 2)); } };
  await Promise.all(lines.map((l) => edit.run({ path: 'shared.txt', old_string: l, new_string: `${l}-edited` }, ctx)));
  const out = await fs.readFile(path.join(root, 'shared.txt'), 'utf8');
  for (const l of lines) { assert.ok(out.includes(`${l}-edited`), `${l} edit was lost`); }
});
