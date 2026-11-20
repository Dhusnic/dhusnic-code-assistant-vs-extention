/**
 * Waits until a stream of change events goes quiet. Used to let a language server finish
 * updating diagnostics after a file changed, before the agent reads them.
 */
export type QuietResult = 'quiet' | 'timeout' | 'aborted';

export interface QuietOptions { quietMs: number; maxMs: number; signal?: AbortSignal }

export function waitForQuiet(subscribe: (onChange: () => void) => { dispose(): void }, opts: QuietOptions): Promise<QuietResult> {
  return new Promise<QuietResult>((resolve) => {
    let done = false;
    let quiet: NodeJS.Timeout | undefined;
    let sub: { dispose(): void } | undefined;
    const finish = (r: QuietResult) => {
      if (done) { return; }
      done = true;
      clearTimeout(quiet);
      clearTimeout(max);
      opts.signal?.removeEventListener('abort', onAbort);
      try { sub?.dispose(); } catch { /* ignore */ }
      resolve(r);
    };
    const arm = () => { clearTimeout(quiet); quiet = setTimeout(() => finish('quiet'), opts.quietMs); };
    const onAbort = () => finish('aborted');
    const max = setTimeout(() => finish('timeout'), opts.maxMs);
    if (opts.signal?.aborted) { finish('aborted'); return; }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    sub = subscribe(() => { if (!done) { arm(); } });
    if (done) { try { sub.dispose(); } catch { /* ignore */ } return; }
    arm();
  });
}
