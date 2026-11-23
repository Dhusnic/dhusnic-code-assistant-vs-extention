import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Tool, fnSpec } from './tool';
import { resolveReadable } from './fstools';

/**
 * view_image: lets the agent look at a local image, e.g. a page or slide the document skills rendered to check layout.
 * The image goes to the configured vision model (through the same LLM gateway as everything else); without one it
 * falls back to offline OCR, which still catches overflowing or missing text. Readable places: the workspace, skill
 * folders, and the renderer's own temp folders (<tmp>/infraon-render-*), never arbitrary files elsewhere.
 */
export const VIEW_IMAGE_TOOL = 'view_image';
export const RENDER_DIR_PREFIX = 'infraon-render-';
const MAX_BYTES = 8 * 1024 * 1024;
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

export interface ImageViewDeps {
  /** The vision model, when one is configured (looked up per call: settings can change). */
  vision?: () => ((dataUrl: string, question: string, signal: AbortSignal) => Promise<string>) | undefined;
  ocr?: (buf: Buffer, ext: string) => Promise<string>;
  tmpDir?: string;
}

const DEFAULT_QUESTION = 'Describe this rendered page or slide for someone checking its layout: list all visible text, and point out any '
  + 'overflowing or clipped text, overlapping elements, empty placeholders, unreadable contrast, misaligned or cramped areas.';

export function createImageViewTool(deps: ImageViewDeps): Tool {
  const tmp = path.resolve(deps.tmpDir ?? os.tmpdir());
  return {
    kind: 'read',
    spec: fnSpec(VIEW_IMAGE_TOOL,
      'Look at a local image file (PNG, JPEG, GIF, WebP, BMP): a vision model describes it, or OCR reads its text when no vision model is configured. '
      + 'Use it to check rendered document pages and slides. Give `question` to focus the description (e.g. "Is any text cut off?").',
      { path: { type: 'string', description: 'Image path: in the workspace, a skill folder, or a render folder printed by a skill script.' }, question: { type: 'string' } },
      ['path']),
    describe: (a) => `View image ${a.path}`,
    async run(a, ctx) {
      const raw = String(a.path ?? '');
      let abs: string;
      try { abs = resolveReadable(ctx, raw); } catch (e) {
        const cand = path.resolve(raw);
        const rel = path.relative(tmp, cand);
        const first = rel.split(/[\\/]/)[0] ?? '';
        if (!path.isAbsolute(raw) || rel.startsWith('..') || path.isAbsolute(rel) || !first.startsWith(RENDER_DIR_PREFIX)) { throw e; }
        abs = cand;
      }
      const ext = path.extname(abs).toLowerCase();
      const mime = MIME[ext];
      if (!mime) { return `ERROR: ${path.basename(abs)} is not a supported image (use PNG, JPEG, GIF, WebP or BMP; render PDFs to images first).`; }
      const stat = await fs.stat(abs);
      if (stat.size > MAX_BYTES) { return `ERROR: the image is ${(stat.size / 1048576).toFixed(1)} MB; render it at a lower resolution (at most 8 MB).`; }
      const buf = await fs.readFile(abs);
      const head = `Image: ${path.basename(abs)} (${(buf.length / 1024).toFixed(0)} KB)`;
      const vision = deps.vision?.();
      if (vision) {
        try {
          const answer = await vision(`data:${mime};base64,${buf.toString('base64')}`, String(a.question ?? '').trim() || DEFAULT_QUESTION, ctx.signal);
          return `${head}\n${answer}`;
        } catch (e: any) {
          if (!deps.ocr) { return `ERROR: the vision model could not read the image: ${e.message ?? e}`; }
        }
      }
      if (deps.ocr) {
        const text = (await deps.ocr(buf, ext.slice(1))).trim();
        return `${head}\nNo vision model is configured, so only the text was read (OCR); layout problems other than missing or cut-off text cannot be seen.\n${text ? `Text found:\n${text.slice(0, 12000)}` : 'OCR found no text.'}`;
      }
      return `ERROR: no vision model or OCR engine is available to look at images. Ask the user to check ${abs} themselves, or set a vision model (setting infraonAssistant.modelRouting, "vision").`;
    },
  };
}
