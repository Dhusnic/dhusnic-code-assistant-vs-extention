import * as assert from 'node:assert/strict';
import { callTool, lastOfRole, reply } from '../harness';
import { SessionDriver } from '../harness';
import { Flow, FlowContext } from '../types';

const BEFORE = 'export const value = 1;\n';
const AFTER = 'export const value = 2;\n';

/* ------------------------------------------------------------ plan mode */

interface PlanCase { name: string; button: string; modeAfter: string; result: RegExp; content: string; applies: boolean }

const PLAN_CASES: PlanCase[] = [
  { name: 'plan-approved-switches-mode-and-implements', button: 'Approve & edit automatically', modeAfter: 'Edit automatically', result: /approved the plan/, content: AFTER, applies: true },
  { name: 'plan-keep-planning-stays-read-only', button: 'Keep planning', modeAfter: 'Plan mode', result: /did not approve the plan/, content: BEFORE, applies: false },
];

/* ------------------------------------------------------------ clarifying questions */

const QUESTION = {
  questions: [{
    question: 'Which indentation should I use?', header: 'Indent',
    options: [{ label: 'Tabs', description: 'One tab per level' }, { label: 'Spaces', description: 'Two spaces per level' }],
  }],
};

interface QuestionCase { name: string; answer(s: SessionDriver): Promise<void>; result: RegExp; summary: string }

const submit = (s: SessionDriver) => s.click('.approve.question:not(.done) [data-qa="submit"]');
const QUESTION_CASES: QuestionCase[] = [
  {
    name: 'question-card-submits-the-selected-option',
    async answer(s) { await s.check('.approve.question:not(.done) .opt input[value="Spaces"]', true); await submit(s); },
    result: /The user answered:[\s\S]*Spaces/, summary: 'Indent: Spaces',
  },
  {
    name: 'question-card-submits-a-typed-answer',
    async answer(s) { await s.input('.approve.question:not(.done) .otext', 'Three spaces please'); await submit(s); },
    result: /Other: "Three spaces please"/, summary: 'Three spaces please',
  },
  {
    name: 'question-card-can-be-skipped',
    async answer(s) { await s.click('.approve.question:not(.done) [data-qa="skip"]'); },
    result: /dismissed the questions/, summary: 'skipped',
  },
];

/* ------------------------------------------------------------ flows */

const todos = (statuses: string[]) => ({
  todos: ['Read the code', 'Change the code', 'Run the tests'].map((content, i) => ({ content, activeForm: `Doing: ${content}`, status: statuses[i] })),
});

async function expectQuestionCard(t: FlowContext, s: SessionDriver): Promise<void> {
  await s.waitFor('.approve.question:not(.done) .qtext', { text: 'Which indentation should I use?' });
  await s.waitFor('.approve.question:not(.done) .opt', { count: 3 });
  assert.equal((await s.query('.approve.question:not(.done) [data-qa="submit"]')).disabled, true, 'Submit needs an answer first');
  await t.shot('question-card');
}

export const flows: Flow[] = [
  ...PLAN_CASES.map((c): Flow => ({
    name: c.name,
    async run(t) {
      const file = t.fixture('planned.ts', BEFORE);
      const s = await t.newSession();
      await s.send('/mode plan');
      await s.waitFor('#modePill', { text: 'Plan mode' });

      await t.gw.script(
        callTool('exit_plan_mode', { plan: '## The plan\n\n1. Update the value\n2. Check the result' }),
        ...(c.applies ? [callTool('read_file', { path: file }), callTool('edit_file', { path: file, old_string: 'value = 1', new_string: 'value = 2' })] : []),
        reply('Plan flow finished.'),
      );
      await s.send('Plan a change');
      await s.waitFor('.approve.plan:not(.done) .planbody li', { text: 'Update the value' });
      await s.waitFor('.approve.plan:not(.done) .planbody h2', { text: 'The plan' });
      assert.equal(t.read(file), BEFORE);
      const first = (await t.gw.requests())[0];
      assert.match(String(lastOfRole(first, 'system')?.content), /PLAN MODE/);
      assert.ok(first.tools.includes('exit_plan_mode'), 'plan mode offers exit_plan_mode');
      assert.ok(!first.tools.includes('edit_file'), 'plan mode does not offer edit_file');
      await t.shot('plan-card');

      await s.clickText('.approve.plan:not(.done) .actions button', c.button);
      await s.waitFor('.msg.assistant .md', { text: 'Plan flow finished.' });
      await s.idle();
      assert.equal(await s.count('.approve:not(.done)'), 0, 'approving the plan leaves no further prompt');
      await s.waitFor('#modePill', { text: c.modeAfter });
      assert.equal(t.read(file), c.content);
      const toolResults = (await t.gw.last()).messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
      assert.match(toolResults[0], c.result);
      await t.shot('decided');
    },
  })),
  ...QUESTION_CASES.map((c): Flow => ({
    name: c.name,
    async run(t) {
      const s = await t.newSession();
      await t.gw.script(callTool('ask_user_question', QUESTION), reply('Thanks for answering.'));
      await s.send('Format the file');
      await expectQuestionCard(t, s);
      await c.answer(s);
      await s.waitFor('.approve.question.done .q', { text: c.summary });
      await s.waitFor('.msg.assistant .md', { text: 'Thanks for answering.' });
      await s.idle();
      assert.match(String(lastOfRole(await t.gw.last(), 'tool')?.content), c.result);
    },
  })),
  {
    name: 'todo-card-tracks-progress',
    async run(t) {
      const s = await t.newSession();
      await t.gw.script(
        callTool('todo_write', todos(['completed', 'in_progress', 'pending'])),
        callTool('todo_write', todos(['completed', 'completed', 'completed']), { gate: { name: 'todo-finish' } }),
        reply('All steps are done.'),
      );
      await s.send('Do three things');

      await s.waitFor('#todo-card .th', { text: '1 of 3 done' });
      await s.waitFor('#todo-card .trow', { count: 3 });
      await s.waitFor('#todo-card .trow.in_progress .tt', { text: 'Doing: Change the code' });
      await s.waitFor('#todo-card .trow.pending .tt', { text: 'Run the tests' });
      await s.click('#todo-card .trow.completed .tline');
      await s.waitFor('#todo-card .trow.completed .tacts', { visible: true });
      await t.shot('in-progress');

      await t.gw.release('todo-finish');
      await s.waitFor('#todo-card .th', { text: '3 of 3 done' });
      await s.waitFor('.msg.assistant .md', { text: 'All steps are done.' });
      await s.idle();
      await s.waitFor('#todo-card .trow.completed', { count: 3 });
      await t.shot('done');
    },
  },
  {
    name: 'sub-agent-card-links-to-its-transcript',
    async run(t) {
      const s = await t.newSession();
      await t.gw.script(
        callTool('agent', { description: 'Survey the repo', prompt: 'Look at the repository and report back.', subagent_type: 'explore' }),
        reply('SUB-REPORT: the repository looks tidy.'),
        reply('The sub-agent has finished.'),
      );
      await s.send('Delegate a survey');

      await s.waitFor('.msg.assistant .md', { text: 'The sub-agent has finished.' });
      await s.idle();
      await s.waitFor('.tool.agent-tool.ok .label', { text: 'Survey the repo' });
      await s.waitFor('.tool.agent-tool .view-agent', { text: 'Open agent' });
      await s.waitFor('#agentCount', { text: '1' });
      await t.shot('agent-card');

      const [main, sub, mainAgain] = await t.gw.requests();
      assert.ok(main.tools.includes('agent'), 'the main agent can delegate');
      assert.match(String(lastOfRole(sub, 'system')?.content), /SUB-AGENT/);
      assert.equal(lastOfRole(sub, 'user')?.content, 'Look at the repository and report back.');
      assert.match(String(lastOfRole(mainAgain, 'tool')?.content), /SUB-REPORT/);

      await s.click('.tool.agent-tool .view-agent');
      await s.waitFor('#subBanner.show', { text: 'Survey the repo' });
      await s.waitFor('.msg.assistant .md', { text: 'SUB-REPORT: the repository looks tidy.' });
      assert.equal((await s.query('#composer')).visible, false, 'sub-agents cannot be messaged directly');
      await t.shot('sub-agent-transcript');

      await s.click('#sbBack');
      await s.waitFor('.msg.assistant .md', { text: 'The sub-agent has finished.' });
      await s.waitFor('#composer', { visible: true });
    },
  },
];
