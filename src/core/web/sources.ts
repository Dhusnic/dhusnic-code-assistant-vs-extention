import * as fs from 'fs/promises';
import * as path from 'path';
import { classifyUrlKind, normalizeUrlForSources } from './sourceKinds';
import { Credibility, SourceKind } from './types';

/**
 * Every page, paper, package or advisory the agents of one session looked at, numbered once, so answers can cite
 * [n] consistently, the user can audit what was read (/sources), and research reports end with a real bibliography.
 */

export interface SourceRecord {
  id: number;
  url: string;
  title: string;
  kind: SourceKind;
  credibility: Credibility;
  /** How it was found: web_fetch, web_search, paper_search… */
  via: string;
  firstSeen: number;
  lastSeen: number;
  /** Set once the content was actually read (not just listed in search results). */
  readAt?: number;
  sha256?: string;
  published?: string;
}

export const CREDIBILITY: Record<SourceKind, Credibility> = {
  'official-docs': 'high', standard: 'high', academic: 'high', government: 'high', 'security-advisory': 'high',
  'code-repo': 'medium', 'package-registry': 'medium', reference: 'medium', vendor: 'medium', news: 'medium',
  forum: 'low', blog: 'low', unknown: 'low',
};

export const KIND_LABEL: Record<SourceKind, string> = {
  'official-docs': 'official docs', standard: 'standard', academic: 'peer-reviewed / academic', government: 'government',
  'security-advisory': 'security advisory', 'code-repo': 'code repository', 'package-registry': 'package registry',
  reference: 'reference', vendor: 'vendor', news: 'news', forum: 'forum', blog: 'blog', unknown: 'unclassified',
};

const MAX_SOURCES = 2000;

export class SourceRegistry {
  private byUrl = new Map<string, SourceRecord>();
  private next = 1;
  private saveTimer?: NodeJS.Timeout;

  constructor(private file?: string) {}

  /** Loads a saved registry; a missing or damaged file starts empty. */
  static async load(file: string): Promise<SourceRegistry> {
    const r = new SourceRegistry(file);
    await r.restore();
    return r;
  }

  /**
   * Reads the saved file back in, keeping the saved numbers so earlier citations stay valid. Sources added before the
   * file was read keep theirs when the URL is new, and are renumbered after the saved ones only on a clash.
   */
  async restore(): Promise<void> {
    if (!this.file) { return; }
    let saved: SourceRecord[] = [];
    try { saved = (JSON.parse(await fs.readFile(this.file, 'utf8')) as { sources?: SourceRecord[] }).sources ?? []; } catch { return; }
    const fresh = [...this.byUrl.values()];
    this.byUrl.clear();
    this.next = 1;
    for (const s of saved) {
      if (!s || typeof s.url !== 'string' || !Number.isInteger(s.id) || !CREDIBILITY[s.kind]) { continue; }
      this.byUrl.set(normalizeUrlForSources(s.url), s);
      this.next = Math.max(this.next, s.id + 1);
    }
    const taken = new Set([...this.byUrl.values()].map((s) => s.id));
    for (const s of fresh) {
      const key = normalizeUrlForSources(s.url);
      const old = this.byUrl.get(key);
      if (old) { Object.assign(old, { lastSeen: s.lastSeen, readAt: s.readAt ?? old.readAt, sha256: s.sha256 ?? old.sha256 }); continue; }
      if (taken.has(s.id)) { s.id = this.next++; } else { this.next = Math.max(this.next, s.id + 1); }
      taken.add(s.id);
      this.byUrl.set(key, s);
    }
  }

  /** Registers (or refreshes) a source and returns its stable number. */
  add(input: { url: string; title?: string; via: string; kind?: SourceKind; read?: boolean; sha256?: string; published?: string }): SourceRecord {
    const key = normalizeUrlForSources(input.url);
    const now = Date.now();
    let rec = this.byUrl.get(key);
    if (!rec) {
      if (this.byUrl.size >= MAX_SOURCES) { this.evictOldestUnread(); }
      const kind = input.kind ?? classifyUrlKind(input.url);
      rec = { id: this.next++, url: input.url, title: cleanTitle(input.title, input.url), kind, credibility: CREDIBILITY[kind], via: input.via, firstSeen: now, lastSeen: now };
      this.byUrl.set(key, rec);
    }
    rec.lastSeen = now;
    if (input.title && (rec.title === hostTitle(rec.url) || !rec.title)) { rec.title = cleanTitle(input.title, input.url); }
    if (input.read) { rec.readAt = now; }
    if (input.sha256) { rec.sha256 = input.sha256; }
    if (input.published && !rec.published) { rec.published = input.published; }
    this.saveSoon();
    return rec;
  }

  get(id: number): SourceRecord | undefined { return [...this.byUrl.values()].find((s) => s.id === id); }
  find(url: string): SourceRecord | undefined { return this.byUrl.get(normalizeUrlForSources(url)); }
  list(): SourceRecord[] { return [...this.byUrl.values()].sort((a, b) => a.id - b.id); }
  get size(): number { return this.byUrl.size; }

  /** A Markdown bibliography: read sources first, then ones only seen in search results. */
  toMarkdown(opts: { onlyRead?: boolean } = {}): string {
    const all = this.list();
    const read = all.filter((s) => s.readAt);
    const seen = opts.onlyRead ? [] : all.filter((s) => !s.readAt);
    if (!read.length && !seen.length) { return 'No web sources have been used in this session yet.'; }
    const line = (s: SourceRecord) => `[${s.id}] ${s.title} — ${s.url} · ${KIND_LABEL[s.kind]} (${s.credibility} credibility)${s.published ? ` · published ${s.published}` : ''}${s.readAt ? ` · read ${new Date(s.readAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}`;
    return [
      read.length ? `Read (${read.length}):\n${read.map(line).join('\n')}` : '',
      seen.length ? `Seen in results only (${seen.length}):\n${seen.map(line).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
  }

  private evictOldestUnread(): void {
    const victim = [...this.byUrl.entries()].filter(([, s]) => !s.readAt).sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0]
      ?? [...this.byUrl.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
    if (victim) { this.byUrl.delete(victim[0]); }
  }

  private saveSoon(): void {
    if (!this.file || this.saveTimer) { return; }
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.save(); }, 1000);
    this.saveTimer.unref?.();
  }

  async save(): Promise<void> {
    if (!this.file) { return; }
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ v: 1, sources: this.list() }));
      await fs.rename(tmp, this.file).catch(async () => { await fs.writeFile(this.file!, JSON.stringify({ v: 1, sources: this.list() })); await fs.rm(tmp, { force: true }); });
    } catch { /* sources are a convenience; never fail a tool over them */ }
  }
}

function hostTitle(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function cleanTitle(title: string | undefined, url: string): string {
  const t = (title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return t || hostTitle(url);
}
