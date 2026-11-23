import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { Agent } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { stripUiFields } from '../core/llm';
import { transcriptFromHistory } from '../core/runtime';
import { historyToUi } from '../core/sessions';
import { call, fakeLlm, recordingUi, text, tmpDir } from './helpers';

/* Message history: Up/Down recall in the composer (the real block of media/session.js, run against fakes), the time
 * stamp on messages the user typed, and how a saved history is replayed (typed messages vs. automatic notes). */
const ROOT = fs.existsSync(path.join(__dirname, '..', '..', 'media', 'session.js')) ? path.join(__dirname, '..', '..') : process.cwd();
const JS = fs.readFileSync(path.join(ROOT, 'media', 'session.js'), 'utf8');

function composer(stored: Record<string, unknown> = {}, sessionId = 's1') {
  const start = JS.indexOf('/* ---------- input history');
  const end = JS.indexOf('  function send()');
  assert.ok(start > 0 && end > start, 'input history block found in session.js');
  let saved: Record<string, unknown> = { ...stored };
  const input = {
    value: '', selectionStart: 0, selectionEnd: 0,
    setSelectionRange(a: number, b: number) { this.selectionStart = a; this.selectionEnd = b; },
  };
  const env = {
    vscode: { getState: () => saved, setState: (s: Record<string, unknown>) => { saved = s; } },
    state: { sessionId, viewingSub: false },
    input, hidePopup: () => undefined, autosize: () => undefined,
  };
  const body = `${JS.slice(start, end)}\nreturn { pushHistory, saveHistory, seedHistory, recall, caretOnFirstLine, caretOnLastLine, list: () => sentHistory };`;
  const api = new Function(...Object.keys(env), body)(...Object.values(env));
  /** Types text into the box with the caret at the end (as the 'input' event would leave it). */
  const type = (v: string) => { input.value = v; input.selectionStart = input.selectionEnd = v.length; };
  /** Presses Up or Down the way the keydown handler does: only from the first / last line. */
  const key = (k: 'up' | 'down') => (k === 'up' ? api.caretOnFirstLine() && api.recall(true) : api.caretOnLastLine() && api.recall(false));
  return { api, input, type, key, saved: () => saved, env };
}

test('input history: Up walks back through sent messages, Down returns to the draft', () => {
  const c = composer();
  c.api.seedHistory([{ type: 'userMsg', text: 'first' }, { type: 'assistantText', text: 'x' }, { type: 'userMsg', text: 'second' }]);
  c.api.pushHistory('/compact');
  c.type('half typed');
  assert.equal(c.key('up'), true); assert.equal(c.input.value, '/compact');
  assert.equal(c.key('up'), true); assert.equal(c.input.value, 'second');
  assert.equal(c.key('up'), true); assert.equal(c.input.value, 'first');
  assert.equal(c.key('up'), false, 'the oldest message is the end'); assert.equal(c.input.value, 'first');
  assert.equal(c.key('down'), true); assert.equal(c.input.value, 'second');
  assert.equal(c.key('down'), true); assert.equal(c.input.value, '/compact');
  assert.equal(c.key('down'), true); assert.equal(c.input.value, 'half typed', 'back to what was being typed');
  assert.equal(c.key('down'), false);
});

test('input history: arrows move inside a multi-line message instead of recalling', () => {
  const c = composer();
  c.api.pushHistory('old');
  c.type('line one\nline two');                 // caret at the end: on the last line, not the first
  assert.equal(c.key('up'), false, 'Up from the second line moves the caret, it does not recall');
  c.input.selectionStart = c.input.selectionEnd = 3;   // now on the first line
  assert.equal(c.key('up'), true);
  assert.equal(c.input.value, 'old');
  assert.equal(c.input.selectionStart, 0, 'caret at the start so the next Up keeps going back');
});

test('input history: kept per session in the webview state, skips repeats, and a new session starts clean', () => {
  const c = composer();
  c.api.seedHistory([]);
  c.api.pushHistory('a'); c.api.pushHistory('a'); c.api.pushHistory('b'); c.api.saveHistory();
  assert.deepEqual(c.saved(), { sessionId: 's1', inputHistory: ['a', 'b'] });

  // The panel reloads: the saved history wins over the transcript (it also has slash commands, which are not in it).
  const again = composer({ sessionId: 's1', inputHistory: ['a', '/compact', 'b'] });
  again.api.seedHistory([{ type: 'userMsg', text: 'a' }, { type: 'userMsg', text: 'b' }]);
  assert.deepEqual(again.api.list(), ['a', '/compact', 'b']);

  // Another session's saved history is not used; this one is seeded from its transcript (notifications excluded).
  const other = composer({ sessionId: 'old', inputHistory: ['secret'] }, 's2');
  other.api.seedHistory([{ type: 'userMsg', text: 'hello' }, { type: 'userMsg', text: '🔔 agent done', notification: [] }]);
  assert.deepEqual(other.api.list(), ['hello']);
  assert.deepEqual(other.saved(), { sessionId: 's2', inputHistory: ['hello'] });
});

test('input history: a sub-agent view does not replace the session history', () => {
  const c = composer({ sessionId: 's1', inputHistory: ['mine'] });
  c.env.state.viewingSub = true;
  c.api.seedHistory([{ type: 'userMsg', text: 'the sub-agent task prompt' }]);
  assert.deepEqual(c.api.list(), []);
  c.env.state.viewingSub = false;
  c.api.seedHistory([]);
  assert.deepEqual(c.api.list(), ['mine']);
});

test('stripUiFields: the display text and the time stamp never reach the model', () => {
  const out = stripUiFields([{ role: 'user', content: 'expanded', display: 'typed', at: 123 }]);
  assert.deepEqual(out, [{ role: 'user', content: 'expanded' }]);
});

test('historyToUi: typed messages keep their time; mid-turn ones are marked; automatic ones become notes', () => {
  const items = historyToUi([
    { role: 'user', content: 'fix it', at: 1000 },
    { role: 'assistant', content: 'working' },
    { role: 'user', content: 'queued text', display: 'also this', at: 2000 },
    { role: 'user', content: 'checks failed…', display: 'Checks failed: test' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'legacy message without a time' },
  ], [0, 5]);
  assert.deepEqual(items, [
    { type: 'user', text: 'fix it', turn: 0, at: 1000 },
    { type: 'assistant', text: 'working' },
    { type: 'user', text: 'also this', turn: 0, at: 2000, mid: true },
    { type: 'note', text: 'Checks failed: test' },
    { type: 'assistant', text: 'done' },
    { type: 'user', text: 'legacy message without a time', turn: 1 },
  ]);
});

test('Agent: a sent message is time-stamped, and a replay carries times, notes and tool kinds', async () => {
  const root = await tmpDir('hist-');
  const llm = fakeLlm([call('write_file', { path: 'a.txt', content: 'x' }, 'w1'), call('read_file', { path: 'a.txt' }, 'r1'), text('done')]);
  const agent = new Agent({ root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => createFsTools() });
  const before = Date.now();
  await agent.send('make a file', { mode: 'auto', effort: 'low', model: 'm' }, recordingUi());
  const sent = agent.history.find((m) => m.role === 'user')!;
  assert.ok(sent.at! >= before && sent.at! <= Date.now());

  const events = transcriptFromHistory(agent);
  assert.deepEqual(events[0], { type: 'userMsg', text: 'make a file', turn: 0, files: [], at: sent.at });
  const kinds = Object.fromEntries(events.filter((e) => e.type === 'toolStart').map((e) => [e.name, e.kind]));
  assert.deepEqual(kinds, { write_file: 'edit', read_file: 'read' });
});
