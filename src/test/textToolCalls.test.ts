import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseTextToolCalls } from '../core/textToolCalls';

const KNOWN = ['read_file', 'edit_file', 'multi_edit', 'run_command', 'grep'];
const args = (r: ReturnType<typeof parseTextToolCalls>, i = 0) => JSON.parse(r!.calls[i].function.arguments);
const names = (r: ReturnType<typeof parseTextToolCalls>) => r!.calls.map((c) => c.function.name);

test('no markup → undefined', () => {
  assert.equal(parseTextToolCalls('The function adds two numbers.', KNOWN), undefined);
  assert.equal(parseTextToolCalls('', KNOWN), undefined);
  assert.equal(parseTextToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>', []), undefined);
});

test('Hermes / Qwen2.5 JSON in <tool_call>, several in a row, ids and JSON-string arguments', () => {
  const r = parseTextToolCalls('<tool_call>\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n</tool_call>\n<tool_call>\n{"name": "grep", "parameters": {"pattern": "foo"}}\n</tool_call>', KNOWN);
  assert.deepEqual(names(r), ['read_file', 'grep']);
  assert.deepEqual(args(r, 0), { path: 'a.ts' });
  assert.deepEqual(args(r, 1), { pattern: 'foo' });
  assert.match(r!.calls[0].id, /^text_call_\d+_[0-9a-f]+$/);
  assert.notEqual(r!.calls[0].id, r!.calls[1].id);
  assert.equal(r!.calls[0].type, 'function');
  assert.equal(r!.rest, '');
});

test('arguments given as a JSON string', () => {
  const r = parseTextToolCalls('<tool_call>{"name": "read_file", "arguments": "{\\"path\\": \\"b.ts\\"}"}</tool_call>', KNOWN);
  assert.deepEqual(args(r), { path: 'b.ts' });
});

test('an unclosed final <tool_call> (generation stopped at the end tag) still counts', () => {
  const r = parseTextToolCalls('Reading it.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "c.ts"}}', KNOWN);
  assert.deepEqual(args(r), { path: 'c.ts' });
  assert.equal(r!.rest, 'Reading it.');
});

test('Qwen3-Coder XML with number/array coercion and exact multi-line text values', () => {
  const content = [
    'I will fix it.',
    '<tool_call>',
    '<function=edit_file>',
    '<parameter=path>',
    'src/a.ts',
    '</parameter>',
    '<parameter=old_string>',
    'function add(a, b) {',
    '  return a - b;',
    '}',
    '</parameter>',
    '<parameter=new_string>',
    '{ "kept": "as text" }',
    '</parameter>',
    '</function>',
    '</tool_call>',
    '<tool_call>',
    '<function=read_file>',
    '<parameter=path>',
    'b.ts',
    '</parameter>',
    '<parameter=start_line>',
    '10',
    '</parameter>',
    '</function>',
    '</tool_call>',
    '<tool_call>',
    '<function=multi_edit>',
    '<parameter=path>',
    'c.ts',
    '</parameter>',
    '<parameter=edits>',
    '[{"old_string": "x", "new_string": "y"}]',
    '</parameter>',
    '</function>',
    '</tool_call>',
  ].join('\n');
  const r = parseTextToolCalls(content, KNOWN);
  assert.deepEqual(names(r), ['edit_file', 'read_file', 'multi_edit']);
  assert.deepEqual(args(r, 0), { path: 'src/a.ts', old_string: 'function add(a, b) {\n  return a - b;\n}', new_string: '{ "kept": "as text" }' });
  assert.deepEqual(args(r, 1), { path: 'b.ts', start_line: 10 });
  assert.deepEqual(args(r, 2), { path: 'c.ts', edits: [{ old_string: 'x', new_string: 'y' }] });
  assert.equal(r!.rest, 'I will fix it.');
});

test('Qwen3-Coder <function=...> without the <tool_call> wrapper', () => {
  const r = parseTextToolCalls('<function=run_command>\n<parameter=command>\nnpm test\n</parameter>\n</function>', KNOWN);
  assert.deepEqual(args(r), { command: 'npm test' });
});

test('Llama <|python_tag|> and Mistral [TOOL_CALLS]', () => {
  const l = parseTextToolCalls('<|python_tag|>{"name": "read_file", "parameters": {"path": "a.ts"}}', KNOWN);
  assert.deepEqual(args(l), { path: 'a.ts' });
  const l2 = parseTextToolCalls('<|python_tag|>{"name": "read_file", "parameters": {"path": "a"}}; {"name": "grep", "parameters": {"pattern": "p"}}', KNOWN);
  assert.deepEqual(names(l2), ['read_file', 'grep']);
  const m = parseTextToolCalls('[TOOL_CALLS] [{"name": "grep", "arguments": {"pattern": "x"}}, {"name": "read_file", "arguments": {"path": "y"}}]', KNOWN);
  assert.deepEqual(names(m), ['grep', 'read_file']);
});

test('a bare JSON call (or list) that is the whole reply, also inside one ```json fence', () => {
  assert.deepEqual(args(parseTextToolCalls('{"name": "read_file", "arguments": {"path": "a.ts"}}', KNOWN)), { path: 'a.ts' });
  const fenced = parseTextToolCalls('```json\n[{"name": "read_file", "arguments": {"path": "a"}}, {"name": "grep", "arguments": {"pattern": "b"}}]\n```', KNOWN);
  assert.deepEqual(names(fenced), ['read_file', 'grep']);
  assert.equal(fenced!.rest, '');
  // OpenAI's own shape written as text.
  assert.deepEqual(args(parseTextToolCalls('{"type": "function", "function": {"name": "grep", "arguments": "{\\"pattern\\": \\"q\\"}"}}', KNOWN)), { pattern: 'q' });
  // JSON that is not a call is just an answer.
  assert.equal(parseTextToolCalls('{"name": "Alice", "age": 3}', KNOWN), undefined);
  assert.equal(parseTextToolCalls('{"result": 42}', KNOWN), undefined);
});

test('mixed prose and calls: rest keeps only the prose', () => {
  const r = parseTextToolCalls('First I will look at the file.\n\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n</tool_call>\n\nThen I will search.', KNOWN);
  assert.equal(r!.calls.length, 1);
  assert.equal(r!.rest, 'First I will look at the file.\n\nThen I will search.');
});

test('unknown tools and malformed JSON are ignored, never thrown', () => {
  assert.equal(parseTextToolCalls('<tool_call>{"name": "delete_everything", "arguments": {}}</tool_call>', KNOWN), undefined);
  assert.equal(parseTextToolCalls('<tool_call>{"name": "read_file", "arguments": {"path": </tool_call>', KNOWN), undefined);
  assert.equal(parseTextToolCalls('<|python_tag|>{not json', KNOWN), undefined);
  assert.equal(parseTextToolCalls('<function=nope>\n<parameter=x>\n1\n</parameter>\n</function>', KNOWN), undefined);
  // A known call next to an unknown one: only the known one counts, the unknown markup stays as text.
  const r = parseTextToolCalls('<tool_call>{"name": "rm_rf", "arguments": {}}</tool_call>\n<tool_call>{"name": "grep", "arguments": {"pattern": "a"}}</tool_call>', KNOWN);
  assert.deepEqual(names(r), ['grep']);
  assert.match(r!.rest, /rm_rf/);
  // A JSON list with one bad entry is not a list of calls.
  assert.equal(parseTextToolCalls('[{"name": "grep", "arguments": {"pattern": "a"}}, {"name": "nope", "arguments": {}}]', KNOWN), undefined);
});

test('markup shown inside an explanatory fenced block is not a call', () => {
  const explain = 'Your model should emit calls like this:\n\n```xml\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n</tool_call>\n```\n\nThat is the Hermes format.';
  assert.equal(parseTextToolCalls(explain, KNOWN), undefined);
  const qwen = 'Example:\n```\n<function=run_command>\n<parameter=command>\nls\n</parameter>\n</function>\n```\nDone.';
  assert.equal(parseTextToolCalls(qwen, KNOWN), undefined);
  // Two fences around prose are not "one fenced reply".
  assert.equal(parseTextToolCalls('```json\n{"name": "grep", "arguments": {"pattern": "a"}}\n```\nand\n```json\n{"x": 1}\n```', KNOWN), undefined);
  // But a call after the explanation, outside the fence, still counts.
  const r = parseTextToolCalls(`${explain}\n<tool_call>{"name": "grep", "arguments": {"pattern": "z"}}</tool_call>`, KNOWN);
  assert.deepEqual(names(r), ['grep']);
});
