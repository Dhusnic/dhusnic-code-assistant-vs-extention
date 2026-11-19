/**
 * Per-task model routing: cheap background work (sub-agents, completions, summaries, commit messages)
 * can use a smaller model than the one selected for the main conversation.
 */
export interface RoutingConfig { subagent?: string; completion?: string; vision?: string; summary?: string; commit?: string }
export type ModelTask = 'main' | 'subagent' | 'completion' | 'vision' | 'summary' | 'commit';
export interface RouteFallback { task: ModelTask; configured: string; used: string; reason: string }
export interface RouteContext { selected: string; available?: string[]; onFallback?: (f: RouteFallback) => void }
export interface RouteDecision { task: ModelTask; model: string; source: 'selected' | 'configured' | 'fallback'; configured?: string; reason?: string }
export interface RouteDescription extends RouteDecision { label: string }

export const MODEL_TASKS: ModelTask[] = ['main', 'subagent', 'completion', 'vision', 'summary', 'commit'];
const TASK_LABELS: Record<ModelTask, string> = {
  main: 'Main conversation', subagent: 'Sub-agents', completion: 'Inline completions',
  vision: 'Images', summary: 'Summaries', commit: 'Commit messages',
};

// `minilm` and friends are embedding models despite the "mini" in the name.
const NON_CHAT_RE = /embed|rerank|re-rank|guard|shield|moderation|minilm|mxbai|nomic|colbert|sentence|(^|[^a-z0-9])(bge|e5|tts|whisper|clip)($|[^a-z0-9])/i;
const VISION_RE = /vision|llava|(^|[^a-z])vl($|[^a-z])/i;
// Whole words only: "gemini" must not count as "mini". Earlier words are preferred.
const FAST_WORDS = ['lite', 'mini', 'small', 'haiku', 'flash', 'fast', 'turbo'];

const words = (model: string): string[] => model.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const isChat = (model: string): boolean => !!model.trim() && !NON_CHAT_RE.test(model);

function fastRank(model: string): number {
  const w = words(model);
  const i = FAST_WORDS.findIndex((f) => w.includes(f));
  return i < 0 ? Number.POSITIVE_INFINITY : i;
}

/** Best first and independent of the order the server listed the models in. */
const preferred = (list: string[]): string[] => [...list].sort((a, b) => {
  const ra = fastRank(a); const rb = fastRank(b);
  return ra === rb ? a.length - b.length || a.localeCompare(b) : ra < rb ? -1 : 1;
});

function find(available: string[], model: string): string | undefined {
  const m = model.toLowerCase();
  return available.find((a) => a === model) ?? available.find((a) => a.toLowerCase() === m);
}

/** Decides the model for a task, explaining any fallback. */
export function resolveRoute(task: ModelTask, config: RoutingConfig | undefined, ctx: { selected: string; available?: string[] }): RouteDecision {
  const configured = task === 'main' ? '' : (config?.[task] ?? '').trim();
  if (!configured) { return { task, model: ctx.selected, source: 'selected' }; }
  const available = ctx.available ?? [];
  if (!available.length) { return { task, model: configured, source: 'configured', configured }; }
  const match = find(available, configured);
  if (match) { return { task, model: match, source: 'configured', configured }; }
  return { task, model: ctx.selected, source: 'fallback', configured, reason: `Model "${configured}" for ${TASK_LABELS[task].toLowerCase()} is not available; using "${ctx.selected}".` };
}

/** The model to use. A configured model missing from a non-empty `available` list falls back to `selected` and calls `onFallback`. */
export function routeModel(task: ModelTask, config: RoutingConfig | undefined, ctx: RouteContext): string {
  const d = resolveRoute(task, config, ctx);
  if (d.source === 'fallback') { ctx.onFallback?.({ task, configured: d.configured ?? '', used: d.model, reason: d.reason ?? '' }); }
  return d.model;
}

/** Suggests a routing from model names. Tasks with no suitable model are left out, so they use the selected model. */
export function inferRouting(available: string[]): RoutingConfig {
  const chat = [...new Set(available)].filter(isChat);
  const out: RoutingConfig = {};
  const fast = preferred(chat.filter((m) => !VISION_RE.test(m) && Number.isFinite(fastRank(m))));
  if (fast.length) { out.subagent = fast[0]; out.completion = fast[0]; out.summary = fast[0]; out.commit = fast[0]; }
  const vision = preferred(chat.filter((m) => VISION_RE.test(m)));
  if (vision.length) { out.vision = vision[0]; }
  return out;
}

/** One row per task for a settings or status view. */
export function describeRouting(config: RoutingConfig | undefined, ctx: { selected: string; available?: string[] }): RouteDescription[] {
  return MODEL_TASKS.map((task) => ({ ...resolveRoute(task, config, ctx), label: TASK_LABELS[task] }));
}
