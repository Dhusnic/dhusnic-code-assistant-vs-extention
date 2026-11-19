import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { Agent, QUESTION_TOOL, buildSystemPrompt } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { ChatMessage, LlmFn, StreamResult } from '../core/llm';
import { formatAnswers, sanitizeAnswers, summarizeAnswers, validateQuestions } from '../core/questions';
import { SessionManager } from '../core/runtime';
import { SessionStore2 } from '../core/store';
import { recordingUi, tmpDir } from './helpers';

const Q = {
  questions: [
    { question: 'Which config format should I use?', header: 'Format', options: [{ label: 'YAML (Recommended)', description: 'Readable, comments' }, { label: 'JSON', description: 'No comments' }, { label: 'TOML' }] },
    { question: 'Which environments need a config?', header: 'Envs', multiSelect: true, options: ['dev', 'staging', 'prod'] },
  ],
};
const text = (content: string): StreamResult => ({ content, toolCalls: [] });
const ask = (args: object, id = 'Q1'): StreamResult => ({ content: '', toolCalls: [{ id, type: 'function', function: { name: QUESTION_TOOL, arguments: JSON.stringify(args) } }] });
const lastTool = (m: ChatMessage[]) => String([...m].reverse().find((x) => x.role === 'tool')?.content ?? '');

/* ---------------------------------------------------------------- pure model */

test('validate: accepts Claude-style questions, string options, header fallback, multiSelect', () => {
  const v = validateQuestions(Q);
  assert.equal(v.error, undefined);
  assert.equal(v.questions!.length, 2);
  assert.deepEqual(v.questions![1].options.map((o) => o.label), ['dev', 'staging', 'prod']);
  assert.equal(v.questions![1].multiSelect, true);
  assert.equal(v.questions![0].multiSelect, false);
  assert.equal(validateQuestions({ questions: [{ question: 'Use tabs or spaces?', options: ['Tabs', 'Spaces'] }] }).questions![0].header, 'Use tabs');
});

test('validate: rejects bad shapes with messages the model can act on; strips a model-supplied "Other"', () => {
  assert.match(validateQuestions({}).error!, /non-empty array/);
  assert.match(validateQuestions({ questions: Array(5).fill(Q.questions[0]) }).error!, /at most 4/);
  assert.match(validateQuestions({ questions: [{ question: '', options: ['a', 'b'] }] }).error!, /no text/);
  assert.match(validateQuestions({ questions: [{ question: 'x?', options: ['only'] }] }).error!, /2-4 options/);
  assert.match(validateQuestions({ questions: [{ question: 'x?', options: ['a', 'b', 'c', 'd', 'e'] }] }).error!, /2-4 options/);
  assert.match(validateQuestions({ questions: [{ question: 'x?', options: ['A', 'a'] }] }).error!, /duplicate/);
  assert.match(validateQuestions({ questions: [{ question: 'x?', options: ['A', 'Other'] }] }).error!, /2-4 options/, '"Other" is added automatically, not counted');
  assert.deepEqual(validateQuestions({ questions: [{ question: 'x?', options: ['A', 'B', 'Other'] }] }).questions![0].options.map((o) => o.label), ['A', 'B']);
});

test('answers: unknown labels dropped, single-choice enforced, Other text kept, empty answers removed', () => {
  const qs = validateQuestions(Q).questions!;
  const a = sanitizeAnswers(qs, { 0: { selected: ['JSON', 'TOML', 'Hacked'] }, 1: { selected: ['dev', 'prod', 'dev', 'nope'], other: '  qa  ' } });
  assert.deepEqual(a[0], { selected: ['JSON'] });
  assert.deepEqual(a[1], { selected: ['dev', 'prod'], other: 'qa' });
  assert.deepEqual(sanitizeAnswers(qs, { 0: { selected: ['JSON'], other: 'INI please' } })[0], { selected: [], other: 'INI please' }, 'single choice: Other wins over a radio');
  assert.deepEqual(sanitizeAnswers(qs, { 0: { selected: [] } }), {});
  assert.deepEqual(sanitizeAnswers(qs, 'garbage'), {});
});

test('format: the model gets every answer clearly, and a clear instruction when skipped', () => {
  const qs = validateQuestions(Q).questions!;
  const t = formatAnswers(qs, { 0: { selected: ['YAML (Recommended)'] }, 1: { selected: ['dev'], other: 'qa' } });
  assert.match(t, /1\. Which config format should I use\?\n {3}→ YAML \(Recommended\)/);
  assert.match(t, /2\. Which environments need a config\?\n {3}→ dev; Other: "qa"/);
  assert.match(t, /Continue the task using these answers/);
  assert.match(formatAnswers(qs, { 0: { selected: ['JSON'] } }), /→ \(no answer — use your best judgement\)/);
  assert.match(formatAnswers(qs, null), /dismissed the questions/);
  assert.equal(summarizeAnswers(qs, { 0: { selected: ['JSON'] } }), 'Format: JSON · Envs: —');
});

/* ---------------------------------------------------------------- agent */

function agentWith(script: Array<StreamResult | ((m: ChatMessage[]) => StreamResult)>, subagent = false) {
  let i = 0; const calls: ChatMessage[][] = []; const offered: string[][] = [];
  const llm: LlmFn = async (_c, msgs, tools) => { calls.push(msgs); offered.push(tools.map((t) => t.function.name)); const s = script[Math.min(i++, script.length - 1)]; return typeof s === 'function' ? s(msgs) : s; };
  const agent = new Agent({ root: '.', llm, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => createFsTools(), subagent });
  return { agent, calls, offered };
}
const OPTS = { mode: 'ask', effort: 'medium', model: 'm' } as const;

test('agent: offered to the main agent in every mode, never to sub-agents; the prompt says when to ask', () => {
  for (const mode of ['ask', 'auto', 'plan'] as const) {
    const a = agentWith([text('x')]); void a.agent.send('q', { ...OPTS, mode }, recordingUi());
  }
  const main = agentWith([text('x')]);
  return main.agent.send('q', OPTS, recordingUi()).then(async () => {
    assert.ok(main.offered[0].includes(QUESTION_TOOL));
    const sub = agentWith([text('x')], true);
    await sub.agent.send('q', OPTS, recordingUi());
    assert.ok(!sub.offered[0].includes(QUESTION_TOOL));
    assert.match(buildSystemPrompt('ask', 'medium', '/w', ''), /call ask_user_question with clear multiple-choice options instead of guessing/);
    assert.match(buildSystemPrompt('ask', 'medium', '/w', ''), /Never ask about things you can find out yourself/);
  });
});

test('agent: pauses until answered, then continues the SAME task with the answers', async () => {
  const a = agentWith([ask(Q), (m) => text(`creating config: ${lastTool(m).includes('→ YAML') ? 'yaml' : '?'}`)]);
  const ui = recordingUi();
  let seen: any;
  ui.askUser = async (_id, qs) => { seen = qs; return { 0: { selected: ['YAML (Recommended)'] }, 1: { selected: ['dev', 'prod'] } }; };
  await a.agent.send('add a config file', OPTS, ui);
  assert.equal(seen.length, 2);
  assert.equal(a.agent.turnCount, 1, 'no new user turn was needed');
  assert.equal(a.agent.history.at(-1)!.content, 'creating config: yaml');
  assert.match(lastTool(a.agent.history), /→ dev; prod/);
});

test('agent: skipping tells the model to proceed with assumptions; invalid questions come back as fixable errors', async () => {
  const a = agentWith([ask(Q), text('assuming yaml')]);
  const ui = recordingUi(); ui.askUser = async () => null;
  await a.agent.send('go', OPTS, ui);
  assert.match(lastTool(a.agent.history), /dismissed the questions/);
  const b = agentWith([ask({ questions: [{ question: 'x?', options: ['one'] }] }), text('ok')]);
  const ui2 = recordingUi(); ui2.askUser = async () => { throw new Error('should not be shown'); };
  await b.agent.send('go', OPTS, ui2);
  assert.match(lastTool(b.agent.history), /ERROR: question 1 needs 2-4 options.*call ask_user_question again/);
});

test('agent: sub-agents and clients without question support get a clear fallback', async () => {
  const s = agentWith([ask(Q), text('assumed')], true);
  await s.agent.send('go', OPTS, recordingUi());
  assert.match(lastTool(s.agent.history), /sub-agents cannot ask the user/);
  const n = agentWith([ask(Q), text('assumed')]);
  await n.agent.send('go', OPTS, recordingUi());
  assert.match(lastTool(n.agent.history), /not supported here/);
});

test('agent: stopping while a question is open does not hang and leaves a valid history', async () => {
  const a = agentWith([ask(Q, 'QQ'), text('never')]);
  const ui = recordingUi(); ui.askUser = () => new Promise(() => {});
  setTimeout(() => a.agent.cancel(), 20);
  await a.agent.send('go', OPTS, ui);
  assert.equal(a.agent.history.at(-1)!.tool_call_id, 'QQ');
  assert.ok(ui.events.includes('info:Cancelled.'));
});

/* ---------------------------------------------------------------- runtime */

async function managed(script: Array<StreamResult | ((m: ChatMessage[]) => StreamResult)>) {
  let i = 0;
  const llm: LlmFn = async (_c, msgs) => { const s = script[Math.min(i++, script.length - 1)]; return typeof s === 'function' ? s(msgs) : s; };
  const mgr = new SessionManager({
    store: new SessionStore2(await tmpDir('q-store-')), defaults: () => ({ mode: 'ask', effort: 'medium', model: 'm' }),
    createAgent: () => new Agent({ root: '.', llm, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }), tools: () => createFsTools() }),
  });
  return mgr;
}

test('runtime: the agent shows as waiting for your answer; the card and its outcome are part of the transcript', async () => {
  const mgr = await managed([ask(Q, 'R1'), (m) => text(lastTool(m).includes('Other: "INI"') ? 'using INI' : 'other')]);
  const s = mgr.newSession();
  const run = mgr.send(s.id, 'a1', 'add config');
  const rt = mgr.agent(s.id, 'a1');
  for (let i = 0; i < 300 && rt.status !== 'waiting'; i++) { await new Promise((r) => setTimeout(r, 10)); }
  assert.equal(rt.status, 'waiting');
  assert.match(rt.activity, /Waiting for your answer: Which config format/);
  assert.equal(mgr.resolveApproval(s.id, 'a1', 'R1', true), false, 'an approval reply cannot answer a question');
  assert.equal(mgr.resolveQuestion(s.id, 'a1', 'R1', { 0: { selected: [], other: 'INI' }, 1: { selected: ['prod'] } }), true);
  assert.equal(mgr.resolveQuestion(s.id, 'a1', 'R1', {}), false, 'already answered');
  await run;
  assert.equal(rt.agent.history.at(-1)!.content, 'using INI');
  const q = rt.log.find((e) => e.type === 'question')!;
  assert.equal(q.questions.length, 2);
  assert.equal(rt.log.find((e) => e.type === 'approvalDone')!.label, 'answered — Format: “INI” · Envs: prod');
});

test('runtime: an empty submission counts as skipped; stopping resolves the open question', async () => {
  const mgr = await managed([ask(Q, 'S1'), text('ok')]);
  const s = mgr.newSession();
  const run = mgr.send(s.id, 'a1', 'go');
  const rt = mgr.agent(s.id, 'a1');
  for (let i = 0; i < 300 && rt.status !== 'waiting'; i++) { await new Promise((r) => setTimeout(r, 10)); }
  mgr.resolveQuestion(s.id, 'a1', 'S1', { 0: { selected: ['bogus'] } });
  await run;
  assert.equal(rt.log.find((e) => e.type === 'approvalDone')!.label, 'skipped');

  const mgr2 = await managed([ask(Q, 'S2'), text('never')]);
  const s2 = mgr2.newSession();
  const run2 = mgr2.send(s2.id, 'a1', 'go');
  const rt2 = mgr2.agent(s2.id, 'a1');
  for (let i = 0; i < 300 && rt2.status !== 'waiting'; i++) { await new Promise((r) => setTimeout(r, 10)); }
  mgr2.stop(s2.id, 'a1');
  await run2;
  assert.equal(rt2.status, 'idle');
  assert.ok(rt2.log.some((e) => e.type === 'approvalDone' && e.label === 'cancelled'));
});

/* ---------------------------------------------------------------- UI contract */

test('UI: question card with single/multi select, Other free text, Submit/Skip, keyboard, and the host wiring', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'session.js'), 'utf8');
  assert.match(js, /case 'question': questionCard\(m\); break;/);
  assert.match(js, /const type = q\.multiSelect \? 'checkbox' : 'radio';/);
  assert.match(js, /value="__other"[\s\S]*class="otext"/);
  assert.match(js, /post\(\{ type: 'answer', id: m\.id, answers \}\)/);
  assert.match(js, /data-qa="skip"/);
  assert.ok(js.includes(String.raw`/\(recommended\)\s*$/i`), 'a "(Recommended)" option is highlighted');
  assert.match(js, /if \(n >= 1 && n <= boxes\.length\)/, 'number keys pick options');
  const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'host', 'sessionPanel.ts'), 'utf8');
  assert.match(panel, /case 'answer': mgr\.resolveQuestion\(/);
});
