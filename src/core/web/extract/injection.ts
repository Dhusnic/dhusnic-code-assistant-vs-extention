/**
 * Prompt-injection defence for fetched web content.
 *
 * Web pages are untrusted data that end up in the model's context. Two things help: stripping characters a
 * human reader never sees (zero-width, bidi overrides, Unicode "tag" characters that can smuggle whole
 * instructions invisibly), and flagging text that reads like orders addressed to an AI agent so the agent
 * and the user are warned. Detection is a heuristic, never a guarantee; it errs towards few false alarms on
 * ordinary documentation.
 */

/** Zero-width, bidi controls, BOM, tag characters and C0/C1 controls other than \n and \t. */
const INVISIBLE = /[​-‏⁠-⁤﻿‪-‮⁦-⁩\u{E0000}-\u{E007F}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/** Removes invisible/control characters, normalises line ends and collapses runs of blank lines. */
export function sanitizeText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(/\n{4,}/g, '\n\n\n');
}

/** An AI system by name. Bare "agent"/"assistant"/"model" are left out: CI agents and voice assistants are everyday doc topics. */
const AI = String.raw`(?:ai|llm|chatbot|language\s+model|ai\s+(?:agent|assistant|model)|coding\s+agent|claude|chatgpt|copilot|gpt-?\d?)`;

/** Phrases that show a sentence is addressed to an AI system rather than to a human reader. */
const ADDRESSEE = new RegExp([
  String.raw`\bif\s+you\s+are\s+an?\s+(?:ai|llm|assistant|language\s+model|agent|bot|chatbot)\b`,
  String.raw`\b(?:dear|attention|note\s+to|hey|hello|hi)\s*,?\s+(?:the\s+|any\s+|all\s+)?(?:${AI}|assistant|agent|bot)s?\b`,
  String.raw`\b(?:to|for)\s+(?:the|any|all)\s+${AI}s?\b`,
  String.raw`\b(?:${AI}|assistant|agent)s?\s+(?:reading|processing|summari[sz]ing|browsing|parsing)\s+(?:this|these)\b`,
  String.raw`\b${AI}s?\s+(?:must|should|need\s+to|are\s+(?:required|instructed)\s+to|will\s+now)\b`,
  String.raw`\b${AI}\s*[:,]\s*(?:you\s+(?:must|should)\s+|please\s+|now\s+|immediately\s+)?(?:run|execute|send|ignore|download|fetch)\b`,
  String.raw`\byou,?\s+the\s+(?:${AI}|assistant|agent)\b`,
].join('|'), 'i');

/** Text after a "send the token" phrase that names a destination: the difference between exfiltration and API docs. */
const EXFIL_TARGET = /^[^.\n]{0,80}?\bto\s+(?:https?:\/\/|me\b|us\b|[\w.+-]+@[\w-]+\.|(?:this|the\s+following)\s+(?:url|address|endpoint|email|server|webhook)\b)/i;

interface Rule {
  re: RegExp;
  /** Only flag when an AI addressee appears near the match (keeps ordinary tutorials quiet). */
  addressed?: boolean;
  /** Extra condition on the match (text, match); an addressed context also satisfies it. */
  when?: (text: string, m: RegExpExecArray) => boolean;
}

const RULES: Rule[] = [
  { re: /\b(?:ignore|disregard|forget|override|skip)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+)?(?:previous|prior|above|earlier|preceding|foregoing|original)\s+(?:instructions?|prompts?|rules|directions|directives|guidelines|context|messages)/gi },
  { re: /\b(?:disregard|ignore|forget|override|bypass)\b[^.\n]{0,60}\b(?:system\s+prompt|your\s+(?:instructions|guidelines|rules|programming))/gi },
  { re: /\b(?:reveal|print|output|repeat|show)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+prompt|hidden\s+instructions|initial\s+instructions)/gi },
  { re: /\byou\s+are\s+now\s+(?:(?:a|an)\s+(?:[\w-]+\s+){0,3}?(?:assistant|ai|model|agent|bot|chatbot)\b|(?:in\s+)?(?:dan|jailbroken|unrestricted|unfiltered|developer\s+mode|god\s+mode|dan\s+mode)\b)/gi },
  { re: /(?:^|[.!])[ \t]*(?:new|updated|revised|real|actual|system)[ \t]+instructions?[ \t]*:/gim },
  { re: /\bas\s+an?\s+(?:ai|artificial intelligence)\s+(?:assistant|model|agent|language model)\s*,?\s+you\s+(?:must|should|will|need|have|are)\b/gi },
  {
    re: /\b(?:do\s+not|don'?t|never)\s+(?:tell|inform|mention\s+(?:this\s+)?to|alert|notify|warn)\s+the\s+user\b/gi,
    // "Don't tell the user whether the password or the name was wrong" is standard security advice.
    when: (t, m) => !/^\s+(?:whether|which|if|why)\b/i.test(t.slice(m.index + m[0].length, m.index + m[0].length + 12)),
  },
  { re: /\b(?:run|execute)\s+(?:this|the\s+following)\s+(?:shell\s+)?(?:command|script|code)s?\b/gi, addressed: true },
  { re: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/gi, addressed: true },
  { re: /\b(?:curl|wget)\b[^\n]{0,200}(?:\$\(\s*(?:env|printenv|cat\s+~?\/?\.(?:ssh|aws|env))|\$\{?[A-Z_]*(?:TOKEN|SECRET|API_KEY|PASSWORD)\b|@~?\/?\.(?:ssh|aws|env)\b)/g },
  {
    re: /\b(?:send|post|upload|email|forward|leak|transmit|share)\s+(?:me\s+)?(?:the|your|all|any)\s+(?:user'?s?\s+)?(?:api[\s_-]?keys?|access\s+tokens?|tokens?|passwords?|credentials|secrets?|env(?:ironment)?(?:\s+variables)?|\.env|ssh\s+keys?|private\s+keys?|cookies)\b/gi,
    // API docs say "send the access token in the Authorization header"; only a named destination or the user's secrets are suspicious.
    when: (t, m) => /user'?s?\s/i.test(m[0]) || /^\S+\s+me\b/i.test(m[0]) || EXFIL_TARGET.test(t.slice(m.index + m[0].length, m.index + m[0].length + 140)),
  },
  { re: /\bexfiltrat(?:e|ing)\b/gi, addressed: true },
  { re: /<\|(?:im_start|im_end|system|endoftext|eot_id|start_header_id)\|>/gi },
  { re: /\[\/?INST\]|<<\/?SYS>>/g },
  { re: /^[ \t]*#{3}[ \t]*(?:system|instructions?)[ \t]*(?:prompt|message)?[ \t]*:|^[ \t]*#{3}[ \t]*system[ \t]+(?:prompt|message)[ \t]*$/gim },
  { re: /<\/?(?:system|web_content|tool_result|function_results|system_prompt|instructions)>/gi },
];

const MAX_EXCERPT = 160;
const MAX_FINDINGS = 5;

/** Returns up to five short excerpts of text that looks like instructions aimed at an AI agent. */
export function detectInjection(text: string): string[] {
  if (!text) { return []; }
  const found: Array<{ at: number; start: number; end: number; excerpt: string }> = [];
  const addressedNear = (at: number, len: number) => ADDRESSEE.test(text.slice(Math.max(0, at - 200), at + len + 200));
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let hits = 0;
    while ((m = rule.re.exec(text)) !== null && hits < 20) {
      if (m[0].length === 0) { rule.re.lastIndex++; continue; }
      hits++;
      if (rule.addressed && !addressedNear(m.index, m[0].length)) { continue; }
      if (rule.when && !rule.when(text, m) && !addressedNear(m.index, m[0].length)) { continue; }
      // Several rules often fire on one sentence: report it once.
      const at = m.index;
      const len = m[0].length;
      if (found.some((f) => at < f.end && at + len > f.start)) { continue; }
      found.push({ at, ...excerptAround(text, at, len) });
    }
  }
  return found.sort((a, b) => a.at - b.at).slice(0, MAX_FINDINGS).map((f) => f.excerpt);
}

/** The match plus some surrounding context on the same line, whitespace collapsed, ≤ 160 chars; `start`/`end` locate it in `text`. */
function excerptAround(text: string, at: number, len: number): { excerpt: string; start: number; end: number } {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  let lineEnd = text.indexOf('\n', at + len);
  if (lineEnd < 0) { lineEnd = text.length; }
  const room = Math.max(0, MAX_EXCERPT - len);
  const start = Math.max(lineStart, at - Math.floor(room / 3));
  const end = Math.min(lineEnd, at + len + room);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (s.length > MAX_EXCERPT) { s = `${s.slice(0, MAX_EXCERPT - 1)}…`; }
  return { excerpt: s, start, end };
}
