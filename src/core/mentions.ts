import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveSafe } from './fstools';

export interface Mention { raw: string; path: string; start?: number; end?: number }
export interface Expanded { text: string; files: string[]; missing: string[] }

const MENTION_RE = /(^|[\s(])@([\w./\\-]+(?::\d+(?:-\d+)?)?)/g;
const PER_FILE_MAX = 20000;
const TOTAL_MAX = 60000;

/** Finds `@path` and `@path:10-20` mentions (not e-mail addresses). */
export function extractMentions(text: string): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    let raw = m[2].replace(/[.,;:!?)]+$/, '');
    if (!raw || seen.has(raw)) { continue; }
    seen.add(raw);
    const range = /^(.*):(\d+)(?:-(\d+))?$/.exec(raw);
    out.push(range
      ? { raw, path: range[1], start: Number(range[2]), end: range[3] ? Number(range[3]) : Number(range[2]) }
      : { raw, path: raw });
  }
  return out;
}

/** Appends the contents of mentioned files to the prompt. Unreadable/outside-workspace mentions are reported, not sent. */
export async function expandMentions(text: string, root: string): Promise<Expanded> {
  const files: string[] = [];
  const missing: string[] = [];
  const blocks: string[] = [];
  let total = 0;
  for (const m of extractMentions(text)) {
    try {
      const abs = resolveSafe(root, m.path);
      const stat = await fs.stat(abs);
      if (!stat.isFile()) { throw new Error('not a file'); }
      let body = await fs.readFile(abs, 'utf8');
      let range = '';
      if (m.start !== undefined) {
        const lines = body.split('\n');
        body = lines.slice(m.start - 1, m.end).join('\n');
        range = ` lines="${m.start}-${m.end}"`;
      }
      if (body.length > PER_FILE_MAX) { body = `${body.slice(0, PER_FILE_MAX)}\n...[truncated]`; }
      if (total + body.length > TOTAL_MAX) { missing.push(`${m.path} (context budget reached)`); continue; }
      total += body.length;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      blocks.push(`<file path="${rel}"${range}>\n${body}\n</file>`);
      files.push(rel);
    } catch { missing.push(m.path); }
  }
  return { text: blocks.length ? `${text}\n\nAttached files:\n${blocks.join('\n')}` : text, files, missing };
}

export { filterFiles } from './glob';

/** Returns the in-progress @token ending at the caret, if any. */
export function activeMention(textBeforeCaret: string): { query: string; start: number } | undefined {
  const m = /(^|\s)@([^\s@]*)$/.exec(textBeforeCaret);
  return m ? { query: m[2], start: textBeforeCaret.length - m[2].length - 1 } : undefined;
}
