import * as assert from 'node:assert/strict';
import * as http from 'http';
import { AddressInfo } from 'net';
import { findBrowser } from '../../../core/testing/cdp';
import { callTool, lastOfRole, reply } from '../harness';
import { Flow } from '../types';

/** A tiny app with one deliberate bug: its users API answers 500. */
async function withApp<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/users') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"db down"}'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Shop</title><h1>Shop</h1><script>fetch("/api/users")</script>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
}

export const flows: Flow[] = [
  {
    name: 'testing-tools-are-offered-to-the-agent',
    async run(t) {
      const s = await t.newSession();
      await t.gw.script(reply('Ready to test.'));
      await s.send('What can you test?');
      await s.waitFor('.msg.assistant .md', { text: 'Ready to test.' });
      const names: string[] = (await t.gw.last()).tools ?? [];
      for (const n of ['browser_open', 'browser_act', 'browser_simulate', 'api_test', 'data_compare', 'db_query']) { assert.ok(names.includes(n), `${n} is offered (got ${names.join(', ')})`); }
    },
  },
  {
    name: 'browser-open-asks-first-then-reports-the-failing-api',
    timeoutMs: 90_000,
    knownFailure: findBrowser() ? undefined : 'no Chrome/Edge on this machine',
    async run(t) {
      await withApp(async (base) => {
        const s = await t.newSession();
        await t.gw.script(callTool('browser_open', { url: `${base}/`, show_text: false }), reply('Found a failing API.'));
        await s.send('Test the shop page');
        await s.waitFor('.approve:not(.done) .q');
        await t.shot('browser-approval');
        await s.clickText('.approve:not(.done) .actions button', 'Allow');
        await s.waitFor('.msg.assistant .md', { text: 'Found a failing API.', timeoutMs: 60_000 });
        await s.idle();
        const result = String(lastOfRole(await t.gw.last(), 'tool')?.content);
        assert.match(result, /Opened http:\/\/127\.0\.0\.1:\d+\/ \(HTTP 200\)/);
        assert.match(result, /✘ API GET .*\/api\/users → HTTP 500/);
        await t.shot('browser-result');
        await t.hub.testing.closeSession(s.id);
      });
    },
  },
  {
    name: 'qa-command-starts-the-test-workflow',
    async run(t) {
      const s = await t.newSession();
      await t.gw.script(reply('Plan ready.'));
      await s.send('/qa the checkout page');
      await s.waitFor('.msg.assistant .md', { text: 'Plan ready.' });
      const user = String(lastOfRole(await t.gw.last(), 'user')?.content);
      assert.match(user, /Test this like a senior QA engineer: the checkout page/);
      assert.match(user, /browser_simulate/);
    },
  },
];
