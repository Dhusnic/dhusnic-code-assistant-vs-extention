import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Agent } from '../core/agent';
import { createFsTools } from '../core/fstools';
import { CheckpointStore } from '../core/checkpoints';
import { REVIEW_SYSTEM, SelfReviewSetting, buildReviewDiff, isLgtm, shouldSelfReview } from '../core/selfReview';
import { call, fakeLlm, recordingUi, text, tmpDir } from './helpers';

type Effort = 'low' | 'medium' | 'high' | 'max';
const opts = (effort: Effort) => ({ mode: 'auto', effort, model: 'm' } as const);
const isReview = (msgs: any[]) => msgs[0]?.role === 'system' && msgs[0].content === REVIEW_SYSTEM;

/** Fake LLM that answers review calls with `review` (in order) and main calls with `main` (in order). */
function scripted(main: Array<ReturnType<typeof text>>, review: Array<string | Error>) {
  let m = 0, r = 0;
  const reviewCalls: any[][] = [];
  const llm = fakeLlm([(msgs) => {
    if (isReview(msgs)) {
      reviewCalls.push(msgs);
      const step = review[Math.min(r++, review.length - 1)];
      if (step instanceof Error) { throw step; }
      return text(step);
    }
    return main[Math.min(m++, main.length - 1)];
  }]);
  return { llm, reviewCalls, mainCalls: () => m };
}

async function build(main: Array<ReturnType<typeof text>>, review: Array<string | Error>, setting: SelfReviewSetting | undefined = 'high', withStore = true) {
  const root = await tmpDir('selfrev-');
  await fs.writeFile(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
  const s = scripted(main, review);
  const store = new CheckpointStore(path.join(root, '.infraon-checkpoints'));
  const agent = new Agent({
    root, llm: s.llm.fn, tools: () => createFsTools(),
    getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }),
    selfReview: setting ? () => setting : undefined,
    ...(withStore ? { snapshot: (t: number, abs: string) => store.snapshot(t, abs), original: (t: number, abs: string) => store.originalIn(t, abs) } : {}),
  });
  return { agent, root, ...s };
}

const edit = (id: string, newText = 'TWO', oldText = 'two') => call('edit_file', { path: 'a.txt', old_string: oldText, new_string: newText }, id);
const readA = call('read_file', { path: 'a.txt' }, 'R1');

test('shouldSelfReview: high/max by default, always at any effort, never when off, without changes, in plan mode or for sub-agents', () => {
  assert.equal(shouldSelfReview('high', 'high', 'auto', false, 1), true);
  assert.equal(shouldSelfReview('high', 'max', 'auto', false, 1), true);
  assert.equal(shouldSelfReview('high', 'medium', 'auto', false, 1), false);
  assert.equal(shouldSelfReview('always', 'low', 'auto', false, 1), true);
  assert.equal(shouldSelfReview('off', 'max', 'auto', false, 1), false);
  assert.equal(shouldSelfReview(undefined, 'max', 'auto', false, 1), false);
  assert.equal(shouldSelfReview('high', 'max', 'auto', false, 0), false);
  assert.equal(shouldSelfReview('high', 'max', 'plan', false, 1), false);
  assert.equal(shouldSelfReview('high', 'max', 'auto', true, 1), false);
  assert.ok(isLgtm('LGTM') && isLgtm(' **LGTM.** ') && !isLgtm('1. a.txt:2 - wrong'));
});

test('a high-effort turn that changed files is reviewed in a fresh context with the request and the diff; LGTM finishes', async () => {
  const { agent, reviewCalls, mainCalls } = await build([readA, edit('E1'), text('Done.')], ['LGTM']);
  const ui = recordingUi();
  await agent.send('capitalize two', opts('high'), ui);
  assert.equal(reviewCalls.length, 1);
  const [sys, user, ...rest] = reviewCalls[0];
  assert.equal(sys.content, REVIEW_SYSTEM);
  assert.equal(rest.length, 0, 'no working history in the review conversation');
  assert.match(user.content, /capitalize two/);
  assert.match(user.content, /### a\.txt \(modified, \+1 -1\)/);
  assert.match(user.content, /-\s+2: two\n\+\s+2: TWO/);
  assert.equal(mainCalls(), 3, 'no extra main iteration after LGTM');
  assert.equal(agent.history.at(-1)!.content, 'Done.');
  assert.ok(ui.events.some((e) => /^info:Self-review: no issues/.test(e)));
});

test('issues go back to the model as a user message and it gets another iteration; the review runs at most once', async () => {
  const { agent, root, reviewCalls, mainCalls } = await build(
    [readA, edit('E1'), text('Done.'), edit('E2', 'Two', 'TWO'), text('Fixed.')],
    ['1. a.txt:2 - should be "Two", not "TWO"', '1. still wrong'],
    'high',
  );
  const ui = recordingUi();
  await agent.send('make two title case', opts('max'), ui);
  assert.equal(reviewCalls.length, 1, 'once per turn even though files changed again');
  const fb = agent.history.filter((m) => m.role === 'user' && m.display === 'Self-review found issues');
  assert.equal(fb.length, 1);
  assert.match(String(fb[0].content), /a\.txt:2 - should be "Two"/);
  assert.equal(mainCalls(), 5);
  assert.equal(agent.history.at(-1)!.content, 'Fixed.');
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'one\nTwo\nthree\n');
});

test('a failed review call is not fatal: the turn finishes normally with a notice', async () => {
  const { agent, reviewCalls } = await build([readA, edit('E1'), text('Done.')], [new Error('gateway down')]);
  const ui = recordingUi();
  await agent.send('capitalize two', opts('high'), ui);
  assert.equal(reviewCalls.length, 1);
  assert.equal(agent.history.at(-1)!.content, 'Done.');
  assert.ok(ui.events.some((e) => /^info:Self-review skipped: gateway down/.test(e)));
});

test('no review at medium effort, when the setting is off, or when nothing changed', async () => {
  const a = await build([readA, edit('E1'), text('Done.')], ['1. x']);
  await a.agent.send('capitalize two', opts('medium'), recordingUi());
  assert.equal(a.reviewCalls.length, 0);

  const b = await build([readA, edit('E1'), text('Done.')], ['1. x'], 'off');
  await b.agent.send('capitalize two', opts('max'), recordingUi());
  assert.equal(b.reviewCalls.length, 0);

  const c = await build([readA, text('It says two.')], ['1. x']);
  await c.agent.send('what does a.txt say?', opts('max'), recordingUi());
  assert.equal(c.reviewCalls.length, 0);

  const d = await build([readA, edit('E1'), text('Done.')], ['LGTM'], 'always');
  await d.agent.send('capitalize two', opts('low'), recordingUi());
  assert.equal(d.reviewCalls.length, 1);
});

test('buildReviewDiff: without a before-state shows current content; stays within budget and lists every file', async () => {
  const root = await tmpDir('selfrev-diff-');
  const big = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  await fs.writeFile(path.join(root, 'big.txt'), big);
  await fs.writeFile(path.join(root, 'small.txt'), 'hello\n');
  const files = [path.join(root, 'big.txt'), path.join(root, 'small.txt'), path.join(root, 'gone.txt')];
  const out = await buildReviewDiff(root, files, async (abs) => (abs.endsWith('small.txt') ? { existed: false } : undefined), 5000);
  assert.ok(out.length <= 5200, `size ${out.length}`);
  assert.match(out, /### big\.txt \(no before-state captured; current content\)/);
  assert.match(out, /more diff lines not shown/);
  assert.match(out, /### small\.txt \(new file, \+1 -0\)\n\+\s+1: hello/);
  assert.match(out, /### gone\.txt \(no longer exists\)/);
});
