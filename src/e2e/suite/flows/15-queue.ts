import * as assert from 'node:assert/strict';
import { callTool, lastOfRole, reply, waitFor } from '../harness';
import { Flow, FlowContext } from '../types';

/**
 * Waits until the model call is really in flight. The Stop button shows as soon as the agent is busy, but a message
 * sent before its first model call is folded into that call (by design), so it is never queued: a test that sends a
 * follow-up must wait for the request to reach the gateway, or it races the agent.
 */
async function modelCallInFlight(t: FlowContext, count = 1): Promise<void> {
  await waitFor(`chat request ${count} to reach the gateway`, async () => ((await t.gw.requests()).length >= count ? true : undefined));
}

export const flows: Flow[] = [
  {
    name: 'message-sent-while-working-is-queued-and-delivered',
    async run(t) {
      const s = await t.newSession();
      await t.gw.script(callTool('list_dir', { path: '.' }, { gate: { name: 'work' } }), reply('Handled both requests.'));
      await s.send('Start the task');
      await s.waitFor('#stop', { visible: true });
      await modelCallInFlight(t);

      await s.send('Also check the README');
      await s.waitFor('#queued .q-item .q-text', { text: 'Also check the README', visible: true });
      await s.waitFor('#in', { visible: true });
      assert.equal((await s.query('#in')).value, '', 'the composer is cleared after queueing');
      await t.shot('queued');

      await t.gw.release('work');
      await s.waitFor('.msg.user.mid', { text: 'Also check the README' });
      await s.waitFor('.msg.user.mid .mid-tag', { text: 'Sent while the agent was working' });
      await s.waitFor('.msg.assistant .md', { text: 'Handled both requests.' });
      await s.idle();
      assert.equal(await s.count('#queued .q-item'), 0, 'the queue is empty once delivered');

      const last = lastOfRole(await t.gw.last(), 'user')?.content ?? '';
      assert.match(String(last), /while you were working:\n<user-message>\nAlso check the README\n<\/user-message>/);
      assert.equal(s.main.agent.turnCount, 1, 'delivered inside the running turn');
      await t.shot('delivered');
    },
  },
  {
    name: 'stop-returns-queued-messages-to-the-composer',
    async run(t) {
      const s = await t.newSession();
      await t.gw.script(reply('Working on it for a long time', { gate: { name: 'never', afterChars: 7 } }));
      await s.send('Long task');
      await s.waitFor('#stop', { visible: true });
      await modelCallInFlight(t);
      await s.send('Change of plan');
      await s.waitFor('#queued .q-item', { count: 1 });
      await s.click('#stop');
      await s.idle();
      assert.equal(await s.count('#queued .q-item'), 0);
      assert.equal((await s.query('#in')).value, 'Change of plan', 'the queued text is back in the composer');
    },
  },
  {
    name: 'queued-message-can-be-edited-or-removed',
    async run(t) {
      const s = await t.newSession();
      await t.gw.script(reply('Busy for a while', { gate: { name: 'never', afterChars: 4 } }));
      await s.send('Busy task');
      await s.waitFor('#stop', { visible: true });
      await modelCallInFlight(t);
      await s.send('First follow-up');
      await s.send('Second follow-up');
      await s.waitFor('#queued .q-item', { count: 2 });

      await s.click('#queued .q-item [data-q="edit"]', 0);
      await s.waitFor('#queued .q-item', { count: 1 });
      assert.equal((await s.query('#in')).value, 'First follow-up', 'Edit takes the message back into the composer');
      await s.click('#queued .q-item [data-q="remove"]', 0);
      await s.waitGone('#queued .q-item');
      assert.deepEqual(s.main.userQueue, []);
      await s.click('#stop');
      await s.idle();
    },
  },
];

const LONG = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of a long streamed answer.`).join('\n\n');

flows.push({
  name: 'scrolling-up-while-streaming-is-not-pulled-back-down',
  async run(t) {
    const s = await t.newSession();
    const half = LONG.indexOf('Line 41');
    await t.gw.script(reply(LONG, { gate: { name: 'rest', afterChars: half } }));
    await s.send('Write a long answer');
    await s.waitFor('.msg.assistant .md p:last-child', { text: 'Line 40' });
    const before = (await s.query('#log')).scroll!;
    assert.ok(before.height > before.client * 1.5, 'the transcript is long enough to scroll');

    await s.scrollTo('#log', 0);
    await t.gw.release('rest');
    await s.waitFor('.msg.assistant .md p:last-child', { text: 'Line 80' });
    await s.idle();
    const after = (await s.query('#log')).scroll!;
    assert.equal(after.top, 0, 'the view stayed where the user scrolled to');
    await s.waitFor('#jumpLatest', { visible: true });
    await t.shot('scrolled-up');

    await s.click('#jumpLatest');
    await waitFor('Jump to latest to reach the bottom', async () => { const e = (await s.query('#log')).scroll!; return e.height - e.top - e.client < 48; });
    assert.equal((await s.query('#jumpLatest')).visible, false);

    // At the bottom, new output is followed again.
    await t.gw.script(reply(LONG));
    await s.send('Again please');
    await s.waitFor('.msg.assistant .md p:last-child', { text: 'Line 80', count: 2 });
    await s.idle();
    const follow = (await s.query('#log')).scroll!;
    assert.ok(follow.height - follow.top - follow.client < 48, 'output is followed while the user is at the bottom');
  },
});
