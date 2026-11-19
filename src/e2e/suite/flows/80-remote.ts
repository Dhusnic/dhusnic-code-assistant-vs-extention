import * as assert from 'node:assert/strict';
import * as path from 'path';
import { callTool, lastOfRole, reply } from '../harness';
import { Flow } from '../types';

const SERVER = 'local-e2e';
const PASSWORD = 'pw-e2e-Secret-9431';

// The test SSH server is compiled with the unit tests; the UI suite reuses it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startSshServer, findShell } = require(path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'sshServer')) as typeof import('../../../test/fixtures/sshServer');

export const flows: Flow[] = [
  {
    name: 'auto-execute-never-asks-even-for-a-server-saved-to-ask-and-masks-the-password',
    timeoutMs: 60_000,
    async run(t) {
      if (!findShell()) { throw new Error('no bash found for the test SSH server'); }
      const ssh = await startSshServer({ user: 'deploy', password: PASSWORD });
      try {
        // The host key is trusted up front: the first-connection prompt is a modal dialog the harness cannot click.
        await t.hub.ctx.globalState.update('sshHostKeys', { ...t.hub.ctx.globalState.get('sshHostKeys', {}), [`127.0.0.1:${ssh.port}`]: ssh.hostKeyFingerprint });
        await t.hub.servers.saveLinux(undefined, { name: SERVER, host: '127.0.0.1', port: ssh.port, user: 'deploy', auth: 'password', password: PASSWORD, env: {}, notes: 'Test server', alwaysAsk: true });

        const s = await t.newSession();
        await s.click('#modePill');
        await s.clickText('.menu .item', 'Auto-execute');
        await t.gw.script(
          callTool('remote_exec', { server: '127.0.0.1', command: `mkdir -p e2e-made && echo "result-$((40+2))"; echo leaked:${PASSWORD}` }),
          reply('The server answered.'),
        );
        await s.send('Check the server');
        // Saved with the old "ask before every change" flag: Auto-execute still runs it without asking.
        await s.waitFor('.msg.assistant .md', { text: 'The server answered.', timeoutMs: 20_000 });
        assert.equal(await s.count('.approve'), 0, 'Auto-execute never asks for an ordinary change');
        await s.waitFor('.tool.ok', { text: 'Remote 127.0.0.1' }); // found by IP: the agent may name a server by its address

        const result = String(lastOfRole(await t.gw.last(), 'tool')?.content);
        assert.match(result, /result-42/);
        assert.match(result, /exit 0/);
        assert.ok(!result.includes(PASSWORD), 'the saved password never reaches the LLM');
        assert.match(result, /leaked:‹secret:/);
        await t.shot('remote-result');
        await s.click('#modePill');
        await s.clickText('.menu .item', 'Ask before edits');
      } finally {
        await t.hub.servers.remove('linux', SERVER);
        t.hub.remote.pool.close(SERVER);
        await ssh.close();
      }
    },
  },
];

flows.push({
  name: 'auto-execute-runs-remote-commands-without-asking-but-a-reboot-still-asks',
  timeoutMs: 60_000,
  async run(t) {
    if (!findShell()) { throw new Error('no bash found for the test SSH server'); }
    const ssh = await startSshServer({ user: 'deploy', password: PASSWORD });
    try {
      await t.hub.ctx.globalState.update('sshHostKeys', { ...t.hub.ctx.globalState.get('sshHostKeys', {}), [`127.0.0.1:${ssh.port}`]: ssh.hostKeyFingerprint });
      await t.hub.servers.saveLinux(undefined, { name: SERVER, host: '127.0.0.1', port: ssh.port, user: 'deploy', auth: 'password', password: PASSWORD, env: {} });
      const s = await t.newSession();
      await s.click('#modePill');
      await s.clickText('.menu .item', 'Auto-execute');
      await t.gw.script(
        callTool('remote_exec', { server: SERVER, command: 'echo auto-ok' }),
        callTool('remote_exec', { server: SERVER, command: 'sudo reboot' }),
        reply('Done checking.'),
      );
      await s.send('Check it, then reboot it');
      await s.waitFor('.approve:not(.done) .q', { text: 'Allow command?', timeoutMs: 20_000 });
      assert.equal(await s.count('.approve'), 1, 'only the reboot asks');
      await s.waitFor('.approve:not(.done) pre', { text: 'sudo reboot' });
      await s.waitFor('.tool.ok', { text: 'echo auto-ok' });
      await s.clickText('.approve:not(.done) .actions button', 'Deny');
      await s.waitFor('.msg.assistant .md', { text: 'Done checking.', timeoutMs: 20_000 });
      const tools = (await t.gw.last()).messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content));
      assert.ok(tools.some((c: string) => /auto-ok/.test(c)), 'the check ran without approval');
      assert.ok(tools.some((c: string) => /DENIED by user/.test(c)), 'the reboot was refused');
      await s.click('#modePill');
      await s.clickText('.menu .item', 'Ask before edits');
    } finally {
      await t.hub.servers.remove('linux', SERVER);
      t.hub.remote.pool.close(SERVER);
      await ssh.close();
    }
  },
});

flows.push({
  name: 'connect-server-asks-for-credentials-securely-retries-and-saves-the-server',
  timeoutMs: 60_000,
  async run(t) {
    if (!findShell()) { throw new Error('no bash found for the test SSH server'); }
    const ssh = await startSshServer({ user: 'deploy', password: PASSWORD });
    const original = t.hub.remote.prompts;
    const asked: string[] = [];
    const answers = ['deploy', 'wrong-password', PASSWORD];
    t.hub.remote.prompts = { input: async (o: any) => { asked.push(o.password ? 'password' : 'user'); return answers.shift(); }, pickKeyFile: async () => undefined };
    const saved = () => t.hub.servers.linuxSync().find((s: any) => s.host === '127.0.0.1' && s.port === ssh.port);
    try {
      await t.hub.ctx.globalState.update('sshHostKeys', { ...t.hub.ctx.globalState.get('sshHostKeys', {}), [`127.0.0.1:${ssh.port}`]: ssh.hostKeyFingerprint });
      const s = await t.newSession();
      await s.click('#modePill');
      await s.clickText('.menu .item', 'Auto-execute');
      await t.gw.script(
        callTool('connect_server', { host: `127.0.0.1:${ssh.port}` }),
        callTool('remote_exec', { server: '127.0.0.1', command: 'echo saved-and-working' }),
        reply('Connected and checked.'),
      );
      await s.send(`ssh into 127.0.0.1 port ${ssh.port} and check it`);
      await s.waitFor('.msg.assistant .md', { text: 'Connected and checked.', timeoutMs: 30_000 });
      assert.deepEqual(asked, ['user', 'password', 'password'], 'asks the user name, then the password again after a wrong one');
      const server = saved();
      assert.ok(server, 'the server was saved automatically');
      assert.equal(server.user, 'deploy');
      assert.equal((await t.hub.servers.credentials(server.name)).password, PASSWORD);
      const sent = JSON.stringify((await t.gw.requests()).map((r: any) => r.messages));
      assert.ok(!sent.includes(PASSWORD) && !sent.includes('wrong-password'), 'no password ever reaches the LLM');
      const tools = (await t.gw.last()).messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content));
      assert.ok(tools.some((c: string) => /Saved as "deploy@127\.0\.0\.1"/.test(c)));
      assert.ok(tools.some((c: string) => /saved-and-working/.test(c)));
      await t.shot('connected-and-saved');
      await s.click('#modePill');
      await s.clickText('.menu .item', 'Ask before edits');
    } finally {
      t.hub.remote.prompts = original;
      const server = saved();
      if (server) { await t.hub.servers.remove('linux', server.name); t.hub.remote.pool.close(server.name); }
      await ssh.close();
    }
  },
});
