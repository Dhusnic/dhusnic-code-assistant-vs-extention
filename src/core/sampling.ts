/**
 * Sampling parameters per model family.
 *
 * Open-weight models are tuned and evaluated with specific sampling settings, and some misbehave far from them:
 * Qwen3-Coder, for instance, can fall into repetition loops at very low temperatures. So the sampling sent with a
 * request is chosen by the model id, not by the effort level (effort only sets output tokens, rounds and the hint).
 *
 * Precedence, highest first:
 *   1. explicit user values: the `infraonAssistant.sampling` object, then an explicitly set `infraonAssistant.temperature`
 *      (the host passes both in `user`; a `null` in the object removes the profile's value for that field)
 *   2. the first profile in PROFILES whose pattern matches the model id (case-insensitive, whole-word match)
 *   3. DEFAULT_SAMPLING (temperature 0.2, nothing else, i.e. the gateway's own defaults)
 *
 * `top_p` and `presence_penalty` are standard OpenAI fields. `top_k` and `repetition_penalty` are not, though vLLM,
 * llama.cpp, SGLang and LiteLLM accept them; withSamplingFallback() retries a request once without them when the
 * gateway rejects them, and stops sending them to that gateway and model from then on.
 *
 * No vscode import: the host reads the settings and passes them in.
 */
import type { LlmFn } from './llm';

/** The sampling fields sent besides temperature. They live in LlmConfig.sampling. */
export interface SamplingExtras { top_p?: number; top_k?: number; repetition_penalty?: number; presence_penalty?: number }
export interface SamplingParams extends SamplingExtras { temperature?: number }
/** User overrides: a number sets the field, `null` removes the profile's value, absent keeps it. */
export type SamplingOverride = { [K in keyof SamplingParams]?: number | null };

export interface SamplingProfile { name: string; pattern: RegExp; params: SamplingParams }

/** Fields that only some OpenAI-compatible servers accept. */
export const NON_STANDARD_FIELDS: (keyof SamplingExtras)[] = ['top_k', 'repetition_penalty'];

export const DEFAULT_TEMPERATURE = 0.2;
/** Unknown models: a conservative low temperature and the gateway's defaults for everything else. */
export const DEFAULT_SAMPLING: SamplingProfile = { name: 'default', pattern: /$^/, params: { temperature: DEFAULT_TEMPERATURE } };

/** `body` as a whole word in a model id ("Qwen/Qwen3-Coder-30B", "qwen3-coder:30b", "hosted_vllm/qwen3-coder"). */
const word = (body: string) => new RegExp(`(?:^|[^a-z0-9])(?:${body})(?![a-z0-9])`, 'i');

/**
 * First match wins, so more specific ids come first (e.g. "DeepSeek-R1-Distill-Qwen-32B" is an R1 model, not Qwen).
 * Values are the vendors' published recommendations (model cards / generation_config.json); where there is none we
 * trust for agentic coding, the profile keeps the conservative default and is listed only to document the choice.
 */
export const PROFILES: SamplingProfile[] = [
  // DeepSeek-R1 model card: temperature 0.5-0.7 (0.6 recommended), top_p 0.95. Covers the R1 distills too.
  { name: 'deepseek-r1', pattern: word('deepseek[-_]?r1'), params: { temperature: 0.6, top_p: 0.95 } },
  // QwQ-32B model card: temperature 0.6, top_p 0.95, top_k 20-40; it warns that greedy decoding causes repetition.
  { name: 'qwq', pattern: word('qwq'), params: { temperature: 0.6, top_p: 0.95, top_k: 40 } },
  // Qwen3-Coder model card ("Best Practices"): temperature 0.7, top_p 0.8, top_k 20, repetition_penalty 1.05.
  { name: 'qwen3-coder', pattern: word('qwen3[-_ ]?coder'), params: { temperature: 0.7, top_p: 0.8, top_k: 20, repetition_penalty: 1.05 } },
  // Qwen3 thinking models (Qwen3-*-Thinking-2507): temperature 0.6, top_p 0.95, top_k 20; no greedy decoding.
  { name: 'qwen3-thinking', pattern: /(?:^|[^a-z0-9])qwen3(?![a-z0-9]).*thinking/i, params: { temperature: 0.6, top_p: 0.95, top_k: 20 } },
  // Qwen3 instruct / non-thinking mode (model cards): temperature 0.7, top_p 0.8, top_k 20.
  { name: 'qwen3', pattern: word('qwen3'), params: { temperature: 0.7, top_p: 0.8, top_k: 20 } },
  // Qwen2.5 and Qwen2.5-Coder Instruct generation_config.json: temperature 0.7, top_p 0.8, top_k 20, repetition_penalty 1.05.
  { name: 'qwen2.5', pattern: word('qwen2\\.5(?:[-_ ]?coder)?'), params: { temperature: 0.7, top_p: 0.8, top_k: 20, repetition_penalty: 1.05 } },
  // DeepSeek-V3 / deepseek-chat: DeepSeek documents that API temperature 1.0 maps to a model temperature of 0.3.
  { name: 'deepseek-v3', pattern: word('deepseek[-_]?(?:v3|chat)'), params: { temperature: 0.3 } },
  // DeepSeek-Coder (V1/V2): no published sampling recommendation; keep the conservative default.
  { name: 'deepseek-coder', pattern: word('deepseek[-_]?coder'), params: { temperature: DEFAULT_TEMPERATURE } },
  // gpt-oss model card / harmony guide: temperature 1.0, top_p 1.0.
  { name: 'gpt-oss', pattern: word('gpt[-_]?oss'), params: { temperature: 1.0, top_p: 1.0 } },
  // Kimi K2 model card: recommended temperature 0.6.
  { name: 'kimi-k2', pattern: word('kimi[-_]?k2'), params: { temperature: 0.6 } },
  // GLM-4.5 / 4.6 (Z.ai): evaluated at temperature 1.0, top_p 0.95, and top_k 40 for code tasks. Older GLMs: default.
  { name: 'glm-4.5+', pattern: word('glm[-_]?4\\.[5-9]'), params: { temperature: 1.0, top_p: 0.95, top_k: 40 } },
  // Magistral (Mistral's reasoning model) model card: temperature 0.7, top_p 0.95.
  { name: 'magistral', pattern: word('magistral'), params: { temperature: 0.7, top_p: 0.95 } },
  // Mistral Small 3 / Devstral model cards recommend a low temperature (0.15); Codestral and Mixtral follow suit.
  { name: 'mistral', pattern: word('mistral|codestral|devstral|ministral|mixtral'), params: { temperature: 0.15 } },
  // Llama 3.x ships temperature 0.6 / top_p 0.9 as a general chat default, not a coding recommendation, and has
  // no low-temperature failure mode, so it keeps the conservative default.
  { name: 'llama', pattern: word('llama'), params: { temperature: DEFAULT_TEMPERATURE } },
];

/** The profile for a model id: the first matching entry of PROFILES, else DEFAULT_SAMPLING. */
export function profileFor(model: string): SamplingProfile {
  return PROFILES.find((p) => p.pattern.test(model)) ?? DEFAULT_SAMPLING;
}

const RANGES: Record<keyof SamplingParams, (n: number) => boolean> = {
  temperature: (n) => n >= 0 && n <= 2,
  top_p: (n) => n > 0 && n <= 1,
  top_k: (n) => Number.isInteger(n) && n >= -1,
  repetition_penalty: (n) => n > 0 && n <= 2,
  presence_penalty: (n) => n >= -2 && n <= 2,
};

/** Keeps only known fields with sane values (numbers in range, or null to clear). Anything else is ignored. */
export function sanitizeOverride(v: unknown): SamplingOverride {
  const out: SamplingOverride = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) { return out; }
  for (const [k, ok] of Object.entries(RANGES) as [keyof SamplingParams, (n: number) => boolean][]) {
    const x = (v as Record<string, unknown>)[k];
    if (x === null) { out[k] = null; } else if (typeof x === 'number' && Number.isFinite(x) && ok(x)) { out[k] = x; }
  }
  return out;
}

export interface ResolvedSampling { temperature: number; sampling: SamplingExtras }

/** Explicit user values > model profile > default. Always yields a temperature (LlmConfig requires one). */
export function resolveSampling(model: string, user: SamplingOverride = {}): ResolvedSampling {
  const profile = profileFor(model);
  const merged: SamplingOverride = { ...profile.params };
  for (const [k, x] of Object.entries(sanitizeOverride(user)) as [keyof SamplingParams, number | null][]) {
    if (x === null) { delete merged[k]; } else { merged[k] = x; }
  }
  const { temperature, ...rest } = merged;
  const sampling: SamplingExtras = {};
  for (const [k, x] of Object.entries(rest) as [keyof SamplingExtras, number | null | undefined][]) {
    if (typeof x === 'number') { sampling[k] = x; }
  }
  return { temperature: typeof temperature === 'number' ? temperature : DEFAULT_TEMPERATURE, sampling };
}

/** The request-body fields for `sampling`: only the defined, finite ones. */
export function samplingBody(sampling: SamplingExtras | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(sampling ?? {})) {
    if (typeof x === 'number' && Number.isFinite(x)) { out[k] = x; }
  }
  return out;
}

export const withoutNonStandard = (s: SamplingExtras | undefined): SamplingExtras | undefined => {
  if (!s) { return s; }
  const out = { ...s };
  for (const k of NON_STANDARD_FIELDS) { delete out[k]; }
  return out;
};

const hasNonStandard = (s: SamplingExtras | undefined) => !!s && NON_STANDARD_FIELDS.some((k) => s[k] !== undefined);

/** A 400/422 from the gateway that complains about a request field it does not know or support. */
export function isUnsupportedParamError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  if (!/LLM HTTP (400|422)\b/.test(m)) { return false; }
  return /top_k|repetition_penalty|extra_forbidden|extra (fields|inputs|parameters?)|(unknown|unsupported|unrecognized|unexpected|not (permitted|allowed|supported))[^\n]{0,60}(param|field|argument|key|input|propert)/i.test(m)
    || /(param|field|argument|key|input|propert)[^\n]{0,60}(unknown|unsupported|unrecognized|unexpected|not (permitted|allowed|supported))/i.test(m);
}

/**
 * When the gateway rejects the non-standard sampling fields, retries once without them and remembers the
 * gateway and model so later requests leave them out from the start. Other errors pass through unchanged.
 */
export function withSamplingFallback(fn: LlmFn): LlmFn {
  const rejects = new Set<string>();
  return async (cfg, messages, tools, onToken, signal) => {
    const key = `${cfg.baseUrl}\n${cfg.model}`;
    if (rejects.has(key) && hasNonStandard(cfg.sampling)) { return fn({ ...cfg, sampling: withoutNonStandard(cfg.sampling) }, messages, tools, onToken, signal); }
    try {
      return await fn(cfg, messages, tools, onToken, signal);
    } catch (e) {
      if (signal.aborted || !hasNonStandard(cfg.sampling) || !isUnsupportedParamError(e)) { throw e; }
      rejects.add(key);
      return fn({ ...cfg, sampling: withoutNonStandard(cfg.sampling) }, messages, tools, onToken, signal);
    }
  };
}
