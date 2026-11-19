/** Screenshot/image attachments: validation and how OCR'd text is handed to a text-only model. */
export interface ImageInput { name: string; mime: string; dataUrl: string; thumb?: string }
const MAX_THUMB_CHARS = 200_000;
export interface OcrOutcome { name: string; text?: string; error?: string }

export const MAX_IMAGES = 6;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIME_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/bmp': 'bmp', 'image/gif': 'gif', 'image/tiff': 'tiff', 'image/webp': 'webp' };

export function decodeDataUrl(dataUrl: string): { mime: string; ext: string; buf: Buffer } {
  const m = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) { throw new Error('not a base64 image data URL'); }
  const ext = MIME_EXT[m[1].toLowerCase()];
  if (!ext) { throw new Error(`unsupported image type ${m[1]}`); }
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) { throw new Error('empty image'); }
  if (buf.length > MAX_IMAGE_BYTES) { throw new Error(`image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`); }
  return { mime: m[1].toLowerCase(), ext, buf };
}

export function validateImages(images: unknown): { ok: ImageInput[]; errors: string[] } {
  const ok: ImageInput[] = [];
  const errors: string[] = [];
  if (!Array.isArray(images)) { return { ok, errors }; }
  for (const raw of images) {
    const img = raw as Partial<ImageInput>;
    const name = String(img?.name ?? 'image').replace(/[^\w.\- ]/g, '_').slice(0, 80) || 'image';
    if (ok.length >= MAX_IMAGES) { errors.push(`${name}: only ${MAX_IMAGES} images per message`); continue; }
    try { decodeDataUrl(String(img?.dataUrl ?? '')); const thumb = typeof img?.thumb === 'string' && img.thumb.startsWith('data:image/') && img.thumb.length < MAX_THUMB_CHARS ? img.thumb : undefined;
      ok.push({ name, mime: String(img?.mime ?? ''), dataUrl: String(img?.dataUrl), ...(thumb ? { thumb } : {}) }); } catch (e: any) { errors.push(`${name}: ${e.message}`); }
  }
  return { ok, errors };
}

/** Text appended to the prompt. The model is told plainly that this is OCR text, not the picture itself. */
export function screenshotBlock(results: OcrOutcome[]): string {
  if (!results.length) { return ''; }
  const blocks = results.map((r) => {
    const body = r.error ? `(text could not be extracted: ${r.error})` : (r.text?.trim() || '(no readable text found in this image)');
    return `<screenshot name="${r.name.replace(/"/g, "'")}">\n${body}\n</screenshot>`;
  });
  return `\n\nAttached screenshot${results.length > 1 ? 's' : ''} — the text below was extracted locally with OCR. Layout, colours and graphics are NOT available to you; if they matter, ask the user to describe them.\n${blocks.join('\n')}`;
}
