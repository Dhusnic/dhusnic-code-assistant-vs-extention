import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Offline research memory: the text of every page, paper and document the agents read is kept locally and can be
 * searched again (BM25) without the network — useful for follow-up questions, offline mode, and reproducing a report.
 */

export interface LibraryDoc { url: string; title: string; text: string; fetchedAt: number; kind: string }
export interface LibraryHit { url: string; title: string; score: number; snippet: string; fetchedAt: number; kind: string }

const MAX_DOC_CHARS = 200_000;
const MAX_DOCS = 3000;
const K1 = 1.2, B = 0.75;
const STOP = new Set('a an and are as at be but by for from has have he her his how i if in into is it its of on or our she that the their them they this to was we were what when where which who why will with you your not can do does did than then there these those so such also may might use using used'.split(' '));

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().normalize('NFKD').matchAll(/[\p{L}\p{N}][\p{L}\p{N}_+#.-]*/gu)) {
    const t = m[0].replace(/[.-]+$/, '');
    if (t.length < 2 || t.length > 40 || STOP.has(t)) { continue; }
    out.push(t);
  }
  return out;
}

interface Indexed { doc: LibraryDoc; len: number; tf: Map<string, number> }

export class WebLibrary {
  private docs = new Map<string, LibraryDoc>();
  private index?: { items: Indexed[]; df: Map<string, number>; avg: number };
  private loaded?: Promise<void>;
  private saveTimer?: NodeJS.Timeout;
  private dirty = false;

  constructor(private file?: string) {}

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.file) { return; }
      let raw = '';
      try { raw = await fs.readFile(this.file, 'utf8'); } catch { return; }
      for (const line of raw.split('\n')) {
        if (!line.trim()) { continue; }
        try {
          const d = JSON.parse(line) as LibraryDoc;
          if (typeof d.url === 'string' && typeof d.text === 'string') { this.docs.set(d.url, d); }
        } catch { /* a damaged line loses one document, not the library */ }
      }
    })();
    return this.loaded;
  }

  /** Stores (or replaces) the readable text of a URL. */
  async add(doc: LibraryDoc): Promise<void> {
    await this.load();
    if (!doc.text.trim()) { return; }
    this.docs.delete(doc.url);
    this.docs.set(doc.url, { ...doc, text: doc.text.slice(0, MAX_DOC_CHARS), title: doc.title.slice(0, 300) });
    while (this.docs.size > MAX_DOCS) { this.docs.delete(this.docs.keys().next().value as string); }
    this.index = undefined;
    this.dirty = true;
    this.saveSoon();
  }

  async size(): Promise<number> { await this.load(); return this.docs.size; }

  async get(url: string): Promise<LibraryDoc | undefined> { await this.load(); return this.docs.get(url); }

  async search(query: string, limit = 8): Promise<LibraryHit[]> {
    await this.load();
    const terms = [...new Set(tokenize(query))];
    if (!terms.length || !this.docs.size) { return []; }
    const idx = this.buildIndex();
    const n = idx.items.length;
    const scored: Array<{ it: Indexed; score: number }> = [];
    for (const it of idx.items) {
      let score = 0;
      for (const t of terms) {
        const f = it.tf.get(t);
        if (!f) { continue; }
        const df = idx.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (it.len / idx.avg))));
      }
      const title = it.doc.title.toLowerCase();
      score += terms.filter((t) => title.includes(t)).length * 0.8;
      if (score > 0) { scored.push({ it, score }); }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 30))).map(({ it, score }) => ({
      url: it.doc.url, title: it.doc.title, kind: it.doc.kind, fetchedAt: it.doc.fetchedAt, score: Math.round(score * 100) / 100,
      snippet: snippet(it.doc.text, terms),
    }));
  }

  private buildIndex() {
    if (this.index) { return this.index; }
    const df = new Map<string, number>();
    const items: Indexed[] = [];
    let total = 0;
    for (const doc of this.docs.values()) {
      const toks = tokenize(`${doc.title} ${doc.text}`);
      const tf = new Map<string, number>();
      for (const t of toks) { tf.set(t, (tf.get(t) ?? 0) + 1); }
      for (const t of tf.keys()) { df.set(t, (df.get(t) ?? 0) + 1); }
      items.push({ doc, len: toks.length, tf });
      total += toks.length;
    }
    this.index = { items, df, avg: Math.max(1, total / Math.max(1, items.length)) };
    return this.index;
  }

  async clear(): Promise<void> {
    await this.load();
    this.docs.clear();
    this.index = undefined;
    this.dirty = true;
    await this.flush();
  }

  private saveSoon(): void {
    if (!this.file || this.saveTimer) { return; }
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.flush(); }, 1500);
    this.saveTimer.unref?.();
  }

  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.file || !this.dirty) { return; }
    this.dirty = false;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, [...this.docs.values()].map((d) => JSON.stringify(d)).join('\n'));
      await fs.rename(tmp, this.file).catch(async () => { await fs.copyFile(tmp, this.file!); await fs.rm(tmp, { force: true }); });
    } catch { this.dirty = true; }
  }
}

/** The ~300 characters around the densest cluster of query terms. */
export function snippet(text: string, terms: string[], width = 300): string {
  const lower = text.toLowerCase();
  let best = 0, bestScore = -1;
  const positions: number[] = [];
  for (const t of terms) {
    let i = lower.indexOf(t);
    for (let n = 0; i >= 0 && n < 50; n++) { positions.push(i); i = lower.indexOf(t, i + t.length); }
  }
  positions.sort((a, b) => a - b);
  for (const p of positions) {
    const score = positions.filter((q) => q >= p && q < p + width).length;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  const start = Math.max(0, best - 60);
  const s = text.slice(start, start + width).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${s}${start + width < text.length ? '…' : ''}`;
}
