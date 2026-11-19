/**
 * Claude-style clarifying questions: the agent asks 1-4 multiple-choice questions (single or multi-select, each with
 * an automatic "Other" free-text choice), the run pauses, and the answers come back as the tool result.
 */
export interface QuestionOption { label: string; description?: string }
export interface UserQuestion { question: string; header: string; options: QuestionOption[]; multiSelect: boolean }
export interface QuestionAnswer { selected: string[]; other?: string }
export type Answers = Record<number, QuestionAnswer>;

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const OTHER_LABEL = 'Other';
const MAX_OTHER_CHARS = 2000;

export function validateQuestions(raw: unknown): { questions?: UserQuestion[]; error?: string } {
  const list = (raw as { questions?: unknown })?.questions;
  if (!Array.isArray(list) || !list.length) { return { error: 'questions must be a non-empty array' }; }
  if (list.length > MAX_QUESTIONS) { return { error: `ask at most ${MAX_QUESTIONS} questions at a time` }; }
  const out: UserQuestion[] = [];
  for (const [i, q] of list.entries()) {
    const question = String(q?.question ?? '').trim();
    if (!question) { return { error: `question ${i + 1} has no text` }; }
    const opts = Array.isArray(q?.options) ? q.options : [];
    const options: QuestionOption[] = opts
      .map((o: any) => (typeof o === 'string' ? { label: o } : { label: String(o?.label ?? '').trim(), description: o?.description ? String(o.description).trim() : undefined }))
      .filter((o: QuestionOption) => o.label && o.label.toLowerCase() !== OTHER_LABEL.toLowerCase());
    const labels = new Set(options.map((o) => o.label.toLowerCase()));
    if (labels.size !== options.length) { return { error: `question ${i + 1} has duplicate option labels` }; }
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      return { error: `question ${i + 1} needs ${MIN_OPTIONS}-${MAX_OPTIONS} options (an "${OTHER_LABEL}" choice is added automatically)` };
    }
    const header = String(q?.header ?? '').trim() || question.split(/\s+/).slice(0, 2).join(' ');
    out.push({ question, header: header.slice(0, 16), options, multiSelect: q?.multiSelect === true || q?.multi_select === true });
  }
  return { questions: out };
}

/** Keeps only labels that exist (plus Other text); enforces single choice where required. */
export function sanitizeAnswers(questions: UserQuestion[], raw: unknown): Answers {
  const out: Answers = {};
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  questions.forEach((q, i) => {
    const a = src[i] ?? src[String(i)];
    if (!a) { return; }
    const valid = new Set(q.options.map((o) => o.label));
    let selected = (Array.isArray(a.selected) ? a.selected : []).map(String).filter((l: string) => valid.has(l));
    selected = [...new Set(selected)];
    const other = typeof a.other === 'string' ? a.other.trim().slice(0, MAX_OTHER_CHARS) : '';
    if (!q.multiSelect) { selected = other ? [] : selected.slice(0, 1); }
    if (selected.length || other) { out[i] = { selected, ...(other ? { other } : {}) }; }
  });
  return out;
}

/** The tool result the model sees. */
export function formatAnswers(questions: UserQuestion[], answers: Answers | null): string {
  if (!answers) {
    return 'The user dismissed the questions without answering. Continue with your best judgement and state the assumptions you make, or ask again more simply if you truly cannot proceed.';
  }
  const lines = questions.map((q, i) => {
    const a = answers[i];
    if (!a) { return `${i + 1}. ${q.question}\n   → (no answer — use your best judgement)`; }
    const parts = [...a.selected];
    if (a.other) { parts.push(`Other: "${a.other}"`); }
    return `${i + 1}. ${q.question}\n   → ${parts.join('; ')}`;
  });
  return `The user answered:\n${lines.join('\n')}\n\nContinue the task using these answers.`;
}

/** Short summary for the transcript after answering. */
export function summarizeAnswers(questions: UserQuestion[], answers: Answers | null): string {
  if (!answers) { return 'skipped'; }
  return questions.map((q, i) => {
    const a = answers[i];
    const v = a ? [...a.selected, ...(a.other ? [`“${a.other}”`] : [])].join(', ') : '—';
    return `${q.header}: ${v}`;
  }).join(' · ');
}
