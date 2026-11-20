import { randomBytes } from 'crypto';
import { ToolCall } from './llm';

/**
 * Tool calls written as TEXT. When the gateway (e.g. vLLM serving Qwen, Hermes or Llama models) runs without a tool
 * parser, the model's tool calls arrive as markup in the reply instead of structured tool_calls. Without this, the
 * agent would show the markup as its final answer and stop. Supported:
 *  1. Hermes / Qwen2.5:  <tool_call>{"name": ..., "arguments": {...}}</tool_call>
 *  2. Qwen3-Coder XML:   <tool_call><function=name><parameter=p>value</parameter></function></tool_call>
 *  3. Llama 3.x:         <|python_tag|>{"name": ..., "parameters": {...}}     Mistral: [TOOL_CALLS] [{...}]
 *  4. A bare JSON call (or list of calls) that is the whole reply, optionally inside one ```json fence.
 * Markup inside a fenced code block is an example being shown, not a call, unless the fence is the whole reply.
 */

interface Found { start: number; end: number; calls: ToolCall[] }

/** Parameters whose value is text even when it looks like JSON (code being edited, commands, prompts). */
const TEXT_PARAMS = new Set(['old_string', 'new_string', 'content', 'command', 'pattern', 'prompt', 'plan', 'message', 'query', 'text', 'body', 'description', 'symbol', 'new_name', 'path', 'glob']);

let counter = 0;
const newId = (): string => `text_call_${++counter}_${randomBytes(4).toString('hex')}`;

/** Index just past the JSON value that starts at s[i] ('{' or '['), or -1 when it is not closed. */
function jsonEnd(s: string, i: number): number {
  const open = s[i];
  if (open !== '{' && open !== '[') { return -1; }
  let depth = 0, inStr = false, esc = false;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (inStr) {
      if (esc) { esc = false; } else if (c === '\\') { esc = true; } else if (c === '"') { inStr = false; }
      continue;
    }
    if (c === '"') { inStr = true; } else if (c === '{' || c === '[') { depth++; } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) { return k + 1; }
    }
  }
  return -1;
}

function tryJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

/** One {"name", "arguments"|"parameters"} object (also OpenAI's {"function": {...}} shape) → a call, or undefined. */
function toCall(obj: unknown, known: Set<string>): ToolCall | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { return undefined; }
  const o = obj as Record<string, any>;
  const fn = o.function && typeof o.function === 'object' ? o.function : o;
  const name = typeof fn.name === 'string' ? fn.name.trim() : '';
  if (!name || !known.has(name)) { return undefined; }
  let args: unknown = fn.arguments ?? fn.parameters ?? o.arguments ?? o.parameters ?? {};
  if (typeof args === 'string') { args = args.trim() ? tryJson(args) : {}; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) { return undefined; }
  return { id: newId(), type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** A parsed JSON value that is one call or a list of calls; all must be valid, or none count. */
function toCalls(value: unknown, known: Set<string>): ToolCall[] {
  const list = Array.isArray(value) ? value : [value];
  if (!list.length) { return []; }
  const calls = list.map((v) => toCall(v, known));
  return calls.every(Boolean) ? (calls as ToolCall[]) : [];
}

/** Qwen3-Coder parameter value: text, but numbers/booleans (and JSON for non-text parameters) are parsed. */
function paramValue(name: string, raw: string): unknown {
  const v = raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  const t = v.trim();
  if (/^(-?\d+(\.\d+)?|true|false|null)$/.test(t)) { return JSON.parse(t); }
  if (!TEXT_PARAMS.has(name) && /^[[{][\s\S]*[\]}]$/.test(t)) {
    const parsed = tryJson(t);
    if (parsed !== undefined) { return parsed; }
  }
  return v;
}

/** <function=name> <parameter=p>v</parameter> ... </function> → a call. */
function xmlCall(body: string, known: Set<string>): ToolCall | undefined {
  const m = /<function=([^>\s]+)\s*>([\s\S]*?)(?:<\/function>|$)/.exec(body);
  if (!m) { return undefined; }
  const name = m[1].trim();
  if (!known.has(name)) { return undefined; }
  const args: Record<string, unknown> = {};
  const re = /<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g;
  let p: RegExpExecArray | null;
  while ((p = re.exec(m[2]))) { args[p[1].trim()] = paramValue(p[1].trim(), p[2]); }
  return { id: newId(), type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** The inside of a <tool_call> block: JSON (Hermes) or XML (Qwen3-Coder). */
function blockCalls(inner: string, known: Set<string>): ToolCall[] {
  const t = inner.trim();
  if (t.startsWith('{') || t.startsWith('[')) { return toCalls(tryJson(t), known); }
  const calls: ToolCall[] = [];
  const re = /<function=[\s\S]*?(?:<\/function>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const c = xmlCall(m[0], known);
    if (c) { calls.push(c); }
    if (m[0].length === 0) { break; }
  }
  return calls;
}

/** [start, end) ranges of fenced code blocks (``` or ~~~). An unclosed fence runs to the end. */
function fencedRanges(s: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) { re.lastIndex++; }
  }
  return out;
}

/** Scans for tool-call markup outside fenced blocks. */
function scan(content: string, known: Set<string>): Found[] {
  const fences = fencedRanges(content);
  const inFence = (i: number) => fences.some(([a, b]) => i >= a && i < b);
  const found: Found[] = [];
  const add = (start: number, end: number, calls: ToolCall[]) => {
    if (!calls.length || inFence(start)) { return; }
    if (found.some((f) => start < f.end && end > f.start)) { return; }
    found.push({ start, end, calls });
  };

  // 1 + 2: <tool_call> ... </tool_call> (the last one may be unclosed when generation stopped at the end tag).
  const block = /<tool_call>([\s\S]*?)(?:<\/tool_call>|(?![\s\S]))/g;
  let m: RegExpExecArray | null;
  while ((m = block.exec(content))) {
    add(m.index, m.index + m[0].length, blockCalls(m[1], known));
    if (m[0].length === 0) { block.lastIndex++; }
  }
  // 2 without the wrapper: a bare <function=...> block.
  const fn = /<function=[^>\s]+\s*>[\s\S]*?<\/function>/g;
  while ((m = fn.exec(content))) {
    const c = xmlCall(m[0], known);
    if (c) { add(m.index, m.index + m[0].length, [c]); }
  }
  // 3: Llama <|python_tag|> (one or more JSON objects separated by ;) and Mistral [TOOL_CALLS].
  for (const tag of ['<|python_tag|>', '[TOOL_CALLS]']) {
    let from = 0;
    for (;;) {
      const at = content.indexOf(tag, from);
      if (at < 0) { break; }
      let i = at + tag.length;
      const calls: ToolCall[] = [];
      let end = i;
      for (;;) {
        while (i < content.length && /[\s;]/.test(content[i])) { i++; }
        const e = jsonEnd(content, i);
        if (e < 0) { break; }
        const got = toCalls(tryJson(content.slice(i, e)), known);
        if (!got.length) { break; }
        calls.push(...got);
        end = e; i = e;
      }
      add(at, end, calls);
      from = at + tag.length;
    }
  }
  return found;
}

export function parseTextToolCalls(content: string, known: string[]): { calls: ToolCall[]; rest: string } | undefined {
  try {
    if (!content || !known.length) { return undefined; }
    const names = new Set(known);
    const trimmed = content.trim();

    // A reply that is ONLY one fenced block: its contents are the reply (models sometimes fence their calls).
    const fenced = /^(```|~~~)[^\n]*\n([\s\S]*?)\n?[ \t]*\1$/.exec(trimmed);
    const whole = fenced && !/^[ \t]*(```|~~~)/m.test(fenced[2]) ? fenced : null;
    const body = whole ? whole[2].trim() : trimmed;

    // 4: the whole reply is a JSON call or list of calls.
    if (body.startsWith('{') || body.startsWith('[')) {
      if (jsonEnd(body, 0) === body.length) {
        const calls = toCalls(tryJson(body), names);
        if (calls.length) { return { calls, rest: '' }; }
      }
    }

    const found = scan(whole ? body : content, names).sort((a, b) => a.start - b.start);
    if (!found.length) { return undefined; }
    const src = whole ? body : content;
    let rest = '';
    let at = 0;
    for (const f of found) { rest += src.slice(at, f.start); at = f.end; }
    rest += src.slice(at);
    rest = rest.replace(/\n{3,}/g, '\n\n').trim();
    return { calls: found.flatMap((f) => f.calls), rest };
  } catch {
    return undefined;
  }
}
