import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { waitFor } from '../harness';
import { Flow } from '../types';

const NAME = 'Prod e2e server';

export const flows: Flow[] = [
  {
    name: 'linux-server-saves-credentials-securely-and-edits-keep-them',
    async run(t) {
      const sb = await t.sidebar();
      try {
        await sb.click('#addServerBtn');
        await sb.waitFor('#serverDialog', { visible: true });
        await sb.waitFor('#mcpFields', { visible: false });
        await sb.input('#serverName', NAME);
        await sb.input('#serverHost', '10.0.0.5');
        await sb.input('#serverUser', 'deploy');
        await sb.input('#serverPassword', 's3cret-pass');
        await sb.click('#addEnvBtn');
        await sb.input('#envList .env-k', 'API_TOKEN');
        await sb.input('#envList .env-v', 'tok-123');
        await t.shot('server-dialog');
        await sb.click('#dialogSave');
        await sb.waitFor('#serverDialog', { visible: false });
        await sb.waitFor('.sv-row2[data-kind="linux"] .sv-detail', { text: 'deploy@10.0.0.5:22' });
        await sb.waitFor('.sv-row2[data-kind="linux"] .tchip', { text: 'API_TOKEN' });

        assert.deepEqual(await t.hub.servers.credentials(NAME), { password: 's3cret-pass', env: { API_TOKEN: 'tok-123' } });
        const stored = JSON.stringify(t.hub.ctx.globalState.get('linuxServers'));
        assert.ok(!stored.includes('s3cret') && !stored.includes('tok-123'), 'no credential is kept outside secret storage');
        assert.ok(!JSON.stringify(vscode.workspace.getConfiguration('infraonAssistant')).includes('s3cret'));

        // Editing without retyping the password or the variable keeps both.
        await sb.click('.sv-row2[data-kind="linux"] [data-sv="edit"]');
        await sb.waitFor('#serverDialog', { visible: true });
        assert.equal((await sb.query('#serverPassword')).value, '', 'the saved password is never sent back to the view');
        await sb.input('#serverPort', '2222');
        await sb.click('#dialogSave');
        await sb.waitFor('.sv-row2[data-kind="linux"] .sv-detail', { text: 'deploy@10.0.0.5:2222' });
        assert.deepEqual(await t.hub.servers.credentials(NAME), { password: 's3cret-pass', env: { API_TOKEN: 'tok-123' } });
        await t.shot('server-list');
      } finally {
        await t.hub.servers.remove('linux', NAME);
        t.hub.sidebar?.refresh();
      }
      await waitFor('the server to be removed', async () => (await t.hub.servers.credentials(NAME)).password === undefined);
    },
  },
  {
    name: 'server-dialog-shows-validation-errors-inline',
    async run(t) {
      const sb = await t.sidebar();
      await sb.click('#addServerBtn');
      await sb.input('#serverKind', 'mcp');
      await sb.waitFor('#mcpFields', { visible: true });
      await sb.waitFor('#linuxFields', { visible: false });
      await sb.input('#serverName', 'docs');
      await sb.input('#serverCommand', 'npx "unclosed');
      await sb.click('#dialogSave');
      await sb.waitFor('#serverErr', { text: 'unclosed quote' });
      await sb.waitFor('#serverCommand.invalid');
      await sb.waitFor('#serverDialog', { visible: true });
      // MCP names become tool names, so spaces are refused there and the name field is highlighted.
      await sb.input('#serverName', 'my docs');
      await sb.input('#serverCommand', 'npx docs-mcp');
      await sb.click('#dialogSave');
      await sb.waitFor('#serverErr', { text: 'no spaces' });
      await sb.waitFor('#serverName.invalid');
      await sb.input('#serverKind', 'linux');
      await sb.input('#serverName', 'Personal server');
      await sb.input('#serverHost', '-oProxyCommand=x');
      await sb.input('#serverUser', 'deploy');
      await sb.input('#serverPassword', 'p');
      await sb.click('#dialogSave');
      await sb.waitFor('#serverErr', { text: 'valid IP address or host name' });
      await sb.waitFor('#serverHost.invalid');
      await sb.waitFor('#serverName.invalid', { count: 0 });
      await sb.click('#dialogCancel');
      await sb.waitFor('#serverDialog', { visible: false });
      assert.deepEqual(t.hub.servers.mcpList(), []);
    },
  },
];
