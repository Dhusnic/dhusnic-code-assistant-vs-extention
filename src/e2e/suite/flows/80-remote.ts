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
    name: 'remote-command-asks-first-runs-over-ssh-and-masks-the-password',
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
          callTool('remote_exec', { server: SERVER, command: `echo "result-$((40+2))"; echo leaked:${PASSWORD}` }),
          reply('The server answered.'),
        );
        await s.send('Check the server');
        // This server asks before every change, even in auto mode.
        await s.waitFor('.approve:not(.done) .q', { text: 'Allow command?', timeoutMs: 15_000 });
        await t.shot('remote-approval');
        await s.clickText('.approve:not(.done) .actions button', 'Allow');
        await s.waitFor('.msg.assistant .md', { text: 'The server answered.', timeoutMs: 20_000 });
        await s.waitFor('.tool.ok', { text: `Remote ${SERVER}` });

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
