import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { callTool, lastOfRole, reply, waitFor } from '../harness';
import { Flow, FlowContext } from '../types';

const BEFORE = 'export const value = 1;\n';
const TOKEN = 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

/** Applies project settings for one flow and always removes them afterwards. */
async function withSettings(t: FlowContext, settings: unknown, fn: () => Promise<void>): Promise<void> {
  const dir = path.join(t.workspace, '.infraon');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  t.hub.safety.checkedAt = 0;
  try { await fn(); } finally { fs.rmSync(dir, { recursive: true, force: true }); t.hub.safety.checkedAt = 0; }
}

/** Makes the test workspace a git repository on branch main. VS Code's git extension may keep watching it afterwards. */
function repo(t: FlowContext): (...args: string[]) => string {
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', ...args], { cwd: t.workspace, encoding: 'utf8' });
  if (!fs.existsSync(path.join(t.workspace, '.git'))) { git('init', '-b', 'main'); }
  git('config', 'user.name', 'E2E'); git('config', 'user.email', 'e2e@example.invalid');
  return git;
}

export const flows: Flow[] = [
  {
    name: 'changes-panel-lists-diffs-and-accepts-a-file',
    async run(t) {
      const file = t.fixture('reviewed.ts', BEFORE);
      const s = await t.newSession();
      await t.gw.script(callTool('edit_file', { path: file, old_string: 'value = 1', new_string: 'value = 2' }), reply('Edited.'));
      await s.send('Change the value');
      await s.clickText('.approve:not(.done) .actions button', 'Allow');
      await s.waitFor('.msg.assistant .md', { text: 'Edited.' });
      await s.idle();
      await s.waitFor('#changesCount', { text: '1', visible: true });

      await s.click('#changesBtn');
      await s.waitFor('#changesModal .ch-row', { text: 'reviewed.ts' });
      await t.shot('changes-panel');
      await s.click('#changesModal [data-ch="diff"]');
      await waitFor('the review diff', () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff);
      await s.reveal();
      await s.click('#changesModal [data-ch="accept"]');
      await s.waitFor('#changesModal .ch-row', { count: 0 });
      assert.match(t.read(file), /value = 2/, 'accepting keeps the edit');
    },
  },
  {
    name: 'permission-deny-rule-blocks-a-command',
    async run(t) {
      await withSettings(t, { permissions: { deny: ['run_command(echo forbidden*)'] } }, async () => {
        const s = await t.newSession();
        await t.gw.script(callTool('run_command', { command: 'echo forbidden' }), reply('It was blocked.'));
        await s.send('Run it');
        await s.waitFor('.msg.assistant .md', { text: 'It was blocked.' });
        assert.equal(await s.count('.approve'), 0, 'a denied command never asks');
        assert.match(String(lastOfRole(await t.gw.last(), 'tool')?.content), /DENIED by permission rule/);
      });
    },
  },
  {
    name: 'permission-ask-rule-protects-the-agent-settings-file',
    async run(t) {
      const s = await t.newSession();
      await s.click('#modePill');
      await s.clickText('.menu .item', 'Auto-execute');
      await s.waitFor('#modePill', { text: 'Auto-execute' });
      await t.gw.script(callTool('write_file', { path: '.infraon/settings.json', content: '{}' }), reply('Stopped.'));
      await s.send('Loosen your own permissions');
      await s.waitFor('.approve:not(.done) .q', { text: 'Allow file change?' });
      await s.clickText('.approve:not(.done) .actions button', 'Deny');
      await s.waitFor('.msg.assistant .md', { text: 'Stopped.' });
      assert.equal(t.exists('.infraon/settings.json'), false);
      await s.click('#modePill');
      await s.clickText('.menu .item', 'Ask before edits');
    },
  },
  {
    name: 'secrets-are-masked-before-reaching-the-llm',
    async run(t) {
      const s = await t.newSession();
      await t.gw.script(reply('Noted.'));
      await s.send(`Use the token ${TOKEN} for this`);
      await s.waitFor('.msg.assistant .md', { text: 'Noted.' });
      const sent = String(lastOfRole(await t.gw.last(), 'user')?.content);
      assert.ok(!sent.includes(TOKEN), 'the real token must not be sent');
      assert.match(sent, /secret:/);
    },
  },
  {
    name: 'diagram-library-loads-only-when-a-diagram-appears',
    async run(t) {
      const s = await t.newSession();
      assert.equal(await s.count('script[src*="mermaid"]'), 0, 'not loaded for a plain session');
      await t.gw.script(reply('```mermaid\ngraph TD; A-->B;\n```'));
      await s.send('Draw it');
      await s.waitFor('.mermaid-svg svg', { timeoutMs: 15_000 });
      assert.equal(await s.count('script[src*="mermaid"]'), 1);
    },
  },
  {
    name: 'slash-permissions-and-changes-open',
    async run(t) {
      const s = await t.newSession();
      await s.send('/permissions');
      await s.waitFor('.msg.info', { text: 'permission rules' });
      await s.send('/changes');
      await s.waitFor('#changesModal .sk-empty', { text: 'No file changes' });
      await s.key('#changesModal', 'Escape');
      await s.waitFor('#changesModal', { count: 0 });
    },
  },
  {
    name: 'quick-fix-is-offered-and-applies-after-accept',
    timeoutMs: 45_000,
    async run(t) {
      const file = t.fixture('broken.ts', 'const total = 1 +;\n');
      const uri = vscode.Uri.file(t.abs(file));
      const editor = await vscode.window.showTextDocument(uri);
      const range = new vscode.Range(0, 0, 0, 18);
      const diagnostics = vscode.languages.createDiagnosticCollection('e2e');
      try {
        diagnostics.set(uri, [new vscode.Diagnostic(range, 'Expression expected.', vscode.DiagnosticSeverity.Error)]);
        const actions = await waitFor('the quick fix', async () => {
          const all = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, range);
          return all?.some((a) => a.title === 'Fix with Infraon') ? all : undefined;
        });
        assert.ok(actions.some((a) => a.title === 'Fix in a session'));

        await t.gw.script(reply('const total = 1 + 2;'));
        void vscode.commands.executeCommand('infraonAssistant.fixDiagnostic', uri, range, 'Expression expected.');
        await waitFor('the proposed fix', () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff, 20_000);
        assert.match(editor.document.getText(), /1 \+;/, 'nothing changes before accepting');
        await vscode.commands.executeCommand('infraonAssistant.inlineEdit.accept');
        await waitFor('the fix to apply', () => editor.document.getText().includes('1 + 2;'));
      } finally {
        diagnostics.dispose();
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }
    },
  },
  {
    name: 'scheduled-task-runs-in-its-own-session',
    async run(t) {
      const before = new Set<string>(t.hub.openPanelIds());
      await t.gw.script(reply('Daily summary is ready.'));
      await t.hub.runScheduled('Daily summary', 'Summarize the project', 'plan');
      const s = await t.adoptNewPanel(before);
      await s.waitFor('.msg.assistant .md', { text: 'Daily summary is ready.' });
      await s.waitFor('#title', { text: 'Scheduled: Daily summary' });
    },
  },
  {
    name: 'agent-worktree-keeps-edits-apart-until-merged',
    timeoutMs: 60_000,
    async run(t) {
      const cfg = vscode.workspace.getConfiguration('infraonAssistant');
      await cfg.update('agentWorktrees', true, vscode.ConfigurationTarget.Global);
      const git = repo(t);
      try {
        const file = t.fixture('isolated.ts', BEFORE);
        git('add', '-A'); git('commit', '-m', 'base');
        const s = await t.newSession();
        await s.click('#modePill');
        await s.clickText('.menu .item', 'Auto-execute');
        await t.gw.script(
          callTool('agent', { description: 'Edit in isolation', prompt: 'Change the value', subagent_type: 'general-purpose' }),
          callTool('edit_file', { path: file, old_string: 'value = 1', new_string: 'value = 2' }),
          reply('Changed the value on my branch.'),
          reply('The agent finished.'),
        );
        await s.send('Delegate this');
        await s.waitFor('.msg.assistant .md', { text: 'The agent finished.', timeoutMs: 20_000 });
        await s.idle();
        assert.equal(t.read(file), BEFORE, 'the main workspace is untouched until the merge');

        await s.click('#changesBtn');
        await s.waitFor('#changesModal .ch-row', { text: 'Edit in isolation' });
        await t.shot('agent-branch');
        await s.click('#changesModal [data-ch="merge"]');
        await waitFor('the merge', () => t.read(file).includes('value = 2'), 20_000);
        await s.waitFor('#changesModal .ch-row', { count: 0, timeoutMs: 15_000 });
        await s.key('#changesModal', 'Escape');
        await s.click('#modePill');
        await s.clickText('.menu .item', 'Ask before edits');
      } finally { await cfg.update('agentWorktrees', undefined, vscode.ConfigurationTarget.Global); }
    },
  },
  {
    name: 'commit-writes-a-message-and-commits-after-review',
    timeoutMs: 45_000,
    async run(t) {
      const git = repo(t);
      t.fixture('committed.ts', BEFORE);
      const s = await t.newSession();
      await s.waitFor('#branchTag', { text: 'main', visible: true, timeoutMs: 10_000 });
      await t.gw.script(reply('feat: add the committed value'));
      await s.send('/commit');
      await s.waitFor('#commitModal #cmText');
      assert.equal((await s.query('#cmText')).value, 'feat: add the committed value');
      await t.shot('commit-review');
      await s.click('#cmGo');
      await s.waitFor('.msg.info', { text: 'Committed' });
      assert.match(git('log', '-1', '--format=%s'), /feat: add the committed value/);
    },
  },
];
