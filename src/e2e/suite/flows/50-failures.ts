import * as assert from 'node:assert/strict';
import { reply, waitFor } from '../harness';
import { ScriptStep } from '../../protocol';
import { Flow } from '../types';

interface GatewayErrorCase { name: string; step: ScriptStep; shown: string }

const ERROR_CASES: GatewayErrorCase[] = [
  { name: 'gateway-http-500-shows-an-error', step: { status: 500, body: '{"error":"gateway exploded"}' }, shown: 'LLM HTTP 500' },
  { name: 'gateway-http-400-shows-an-error', step: { status: 400, body: '{"error":"bad request"}' }, shown: 'LLM HTTP 400' },
];

export const flows: Flow[] = [
  {
    name: 'stop-button-cancels-a-streaming-reply',
    async run(t) {
      const s = await t.newSession();
      const partial = 'This reply never gets to finish ';
      await t.gw.script(reply(`${partial}because the user stops it.`, { gate: { name: 'never', afterChars: partial.length } }));
      await s.send('Write something long');
      await s.waitFor('.msg.assistant .md', { text: 'This reply never gets to finish' });
      await s.waitFor('#stop', { visible: true });
      await t.shot('streaming');

      await s.click('#stop');
      await s.waitFor('.msg.info', { text: 'Cancelled.' });
      await s.idle();
      await waitFor('the gateway to see the disconnect', async () => (await t.gw.last()).aborted);
      assert.ok(!(await s.text('.msg.assistant .md')).includes('because the user stops it'));
      await t.shot('stopped');

      await t.gw.script(reply('Back to normal.'));
      await s.send('Are you still there?');
      await s.waitFor('.msg.assistant .md', { text: 'Back to normal.' });
      await s.idle();
    },
  },
  ...ERROR_CASES.map((c): Flow => ({
    name: c.name,
    async run(t) {
      const s = await t.newSession();
      await t.gw.script(c.step);
      await s.send('This request will fail');
      await s.waitFor('.msg.info.error', { text: c.shown });
      await s.idle();
      assert.equal((await t.gw.requests()).length, 1, 'a permanent error is not retried');
      await t.shot('error');

      await t.gw.script(reply('Recovered after the error.'));
      await s.send('Try again');
      await s.waitFor('.msg.assistant .md', { text: 'Recovered after the error.' });
      await s.idle();
    },
  })),
  {
    name: 'gateway-http-503-is-retried-without-showing-an-error',
    async run(t) {
      const s = await t.newSession();
      await t.gw.script({ status: 503 }, reply('Worked on the second attempt.'));
      await s.send('Please retry');
      await s.waitFor('.msg.assistant .md', { text: 'Worked on the second attempt.' });
      await s.idle();
      assert.equal((await t.gw.requests()).length, 2);
      assert.equal(await s.count('.msg.info.error'), 0);
    },
  },
];
