/**
 * Gateway and model health for the sidebar's Status line.
 *
 * Listing /models only proves the gateway is up: a gateway whose model backend is stuck still lists its models in
 * milliseconds while every chat request hangs. So the model is probed too, with the smallest possible chat
 * completion (one token, tiny prompt, short timeout), and the Status line has three states: Online (the model
 * answered, with its latency), "Gateway up · model not responding", and Offline (the model list failed).
 *
 * The probe costs a model request, so it runs at most every PROBE_INTERVAL_MS per model, when the user presses
 * refresh, and never while one is already running. The decisions live here (pure, unit tested); the host only
 * schedules them and supplies the LLM function.
 */
import { LlmConfig, LlmFn, isStallError } from './llm';

export const PROBE_INTERVAL_MS = 5 * 60_000;
export const PROBE_TIMEOUT_MS = 20_000;

export interface ProbeResult { ok: boolean; ms: number; at: number; model: string; error?: string }
export interface ProbeState { inFlight: boolean; last?: ProbeResult }

/**
 * Whether to probe `model` now: never while a probe runs or when probing is off (intervalMs <= 0); otherwise when
 * forced (refresh button), when the model changed or was never probed, or when the last probe is intervalMs old.
 */
export function shouldProbe(state: ProbeState, model: string, now: number, opts: { force?: boolean; intervalMs?: number } = {}): boolean {
  const interval = opts.intervalMs ?? PROBE_INTERVAL_MS;
  if (state.inFlight || interval <= 0 || !model) { return false; }
  if (opts.force || !state.last || state.last.model !== model) { return true; }
  return now - state.last.at >= interval;
}

/**
 * Sends a one-token chat completion to `cfg.model`. Resolves (never rejects) with whether the model answered within
 * timeoutMs. Pass the bare streaming call, not the retrying one: a probe that retries a stall defeats its purpose.
 */
export async function probeModel(llm: LlmFn, cfg: LlmConfig, opts: { timeoutMs?: number; now?: () => number } = {}): Promise<ProbeResult> {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const t0 = now();
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  // Standard fields only: the probe must not fail on sampling extras the gateway may reject.
  const probeCfg: LlmConfig = { ...cfg, maxTokens: 1, temperature: 0, sampling: undefined, idleTimeoutMs: timeoutMs };
  try {
    await llm(probeCfg, [{ role: 'user', content: 'ping' }], [], () => {}, ac.signal);
    return { ok: true, ms: now() - t0, at: now(), model: cfg.model };
  } catch (e: any) {
    const error = timedOut || isStallError(e) ? `no answer within ${Math.round(timeoutMs / 1000)} s` : (e?.message ?? String(e));
    return { ok: false, ms: now() - t0, at: now(), model: cfg.model, error };
  } finally {
    clearTimeout(timer);
  }
}

export type HealthState = 'checking' | 'online' | 'degraded' | 'offline';
/** What the sidebar shows. `ok` is the gateway (model list); `state` and `label` include the model probe. */
export interface HealthView { ok?: boolean; ms?: number; error?: string; at?: number; state: HealthState; label: string; modelError?: string }

/**
 * Combines the model-list check and the probe of the selected model into one Status line. With probing off
 * (`probing` false) the model list is all there is to go on, so a working gateway reads Online as it used to.
 */
export function healthView(gateway: { ok?: boolean; ms?: number; error?: string; at?: number }, probe: ProbeState, model: string, probing = true): HealthView {
  const base = { ...gateway };
  if (gateway.ok === undefined) { return { ...base, state: 'checking', label: 'checking…' }; }
  if (!gateway.ok) { return { ...base, state: 'offline', label: 'Offline' }; }
  const last = probe.last?.model === model ? probe.last : undefined;
  if (!last && !probing) { return { ...base, state: 'online', label: `Online · ${gateway.ms} ms` }; }
  if (!last) {
    return { ...base, state: 'online', label: probe.inFlight ? 'Gateway up · checking model…' : `Gateway up · ${gateway.ms} ms` };
  }
  if (last.ok) { return { ...base, state: 'online', label: `Online · ${last.ms} ms` }; }
  return { ...base, state: 'degraded', label: 'Gateway up · model not responding', modelError: last.error };
}
