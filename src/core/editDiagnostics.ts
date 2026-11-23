/**
 * Reports the errors an edit introduced, right in the edit tool's result, so the model sees a broken edit at once
 * instead of only when it remembers to call get_diagnostics or when the end-of-turn checks run.
 *
 * The host implements EditDiagnostics (src/host/editDiagnostics.ts, on top of the editor's language servers) and
 * passes it through AgentDeps into ToolCtx. The edit tools in fstools.ts take a baseline of the file's errors just
 * before writing, and afterwards call reportNewErrors, which waits briefly for the language server to re-check the
 * file and appends only the errors that were not there before (compared by source and message, not line, since the
 * edit moves lines). Without a provider (unit tests, the eval runner) or with the setting off, nothing changes.
 * The wait is cheap and bounded: the host gives up after about two seconds, and an abort ends it at once.
 */

/** One error diagnostic: 1-based line, message, and the tool that reported it (e.g. "ts", "eslint"). */
export interface DiagEntry { line: number; message: string; source?: string }

/**
 * The errors a file had before an edit. known=false: the editor had no view of the file (not open, no diagnostics),
 * so any error after the edit may predate it.
 */
export interface DiagBaseline { known: boolean; errors: DiagEntry[] }

export interface EditDiagnostics {
  /** The file's current errors; undefined when the check is off or does not apply to this file. */
  baseline(absPath: string): DiagBaseline | undefined;
  /** Waits for the language server to re-check the file after a write, then returns its errors; undefined if aborted. */
  errorsAfterWrite(absPath: string, signal: AbortSignal): Promise<DiagEntry[] | undefined>;
}

export const MAX_REPORTED = 10;

const keyOf = (d: DiagEntry): string => `${d.source ?? ''}\u0000${d.message}`;

/** Errors in after that were not in before. Duplicates count: a second copy of an existing error is new. */
export function newErrors(before: DiagEntry[], after: DiagEntry[]): DiagEntry[] {
  const left = new Map<string, number>();
  for (const d of before) { left.set(keyOf(d), (left.get(keyOf(d)) ?? 0) + 1); }
  const out: DiagEntry[] = [];
  for (const d of after) {
    const n = left.get(keyOf(d)) ?? 0;
    if (n > 0) { left.set(keyOf(d), n - 1); } else { out.push(d); }
  }
  return out;
}

/** The lines appended to an edit result, in get_diagnostics' "path:line [Error] message" format. Empty when none. */
export function formatNewErrors(display: string, errors: DiagEntry[], known: boolean): string {
  if (!errors.length) { return ''; }
  const sorted = [...errors].sort((a, b) => a.line - b.line);
  const lines = sorted.slice(0, MAX_REPORTED).map((d) => `${display}:${d.line} [Error] ${d.message}${d.source ? ` (${d.source})` : ''}`);
  if (sorted.length > MAX_REPORTED) { lines.push(`...and ${sorted.length - MAX_REPORTED} more`); }
  const head = known ? 'New errors after this edit:' : 'Errors in the file after this edit (some may predate it):';
  return `\n${head}\n${lines.join('\n')}`;
}

/** Waits for the file's diagnostics after a write and formats the new errors; '' when none, unavailable or aborted. */
export async function reportNewErrors(probe: EditDiagnostics | undefined, abs: string, display: string,
  base: DiagBaseline | undefined, signal: AbortSignal): Promise<string> {
  if (!probe || !base || signal.aborted) { return ''; }
  try {
    const after = await probe.errorsAfterWrite(abs, signal);
    if (!after || signal.aborted) { return ''; }
    return formatNewErrors(display, base.known ? newErrors(base.errors, after) : after, base.known);
  } catch { return ''; }
}

/** The baseline, or undefined if the provider fails: a diagnostics problem must never block an edit. */
export function takeBaseline(probe: EditDiagnostics | undefined, abs: string, isNewFile = false): DiagBaseline | undefined {
  if (!probe) { return undefined; }
  try {
    const b = probe.baseline(abs);
    return b && isNewFile ? { known: true, errors: [] } : b;
  } catch { return undefined; }
}

export type SettleResult = 'settled' | 'unchanged' | 'timeout' | 'aborted';

export interface SettleOptions { firstMs: number; quietMs: number; maxMs: number; signal?: AbortSignal }

/**
 * Waits for a language server to re-check a file: for the first change (up to firstMs; none means 'unchanged'),
 * then until changes stop for quietMs, never longer than maxMs in all. Unlike settle.ts's waitForQuiet, the quiet
 * timer starts only after the first change, since a freshly written file takes a moment to be picked up at all.
 */
export function waitForRecheck(subscribe: (onChange: () => void) => { dispose(): void }, opts: SettleOptions): Promise<SettleResult> {
  return new Promise<SettleResult>((resolve) => {
    let done = false;
    let quiet: NodeJS.Timeout | undefined;
    let sub: { dispose(): void } | undefined;
    const finish = (r: SettleResult) => {
      if (done) { return; }
      done = true;
      clearTimeout(quiet); clearTimeout(first); clearTimeout(max);
      opts.signal?.removeEventListener('abort', onAbort);
      try { sub?.dispose(); } catch { /* ignore */ }
      resolve(r);
    };
    const onAbort = () => finish('aborted');
    const first = setTimeout(() => finish('unchanged'), opts.firstMs);
    const max = setTimeout(() => finish('timeout'), opts.maxMs);
    if (opts.signal?.aborted) { finish('aborted'); return; }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    sub = subscribe(() => {
      if (done) { return; }
      clearTimeout(first);
      clearTimeout(quiet);
      quiet = setTimeout(() => finish('settled'), opts.quietMs);
    });
    if (done) { try { sub.dispose(); } catch { /* ignore */ } }
  });
}
