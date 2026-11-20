import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { callTool, lastOfRole, reply, waitFor } from '../harness';
import { Flow } from '../types';

const BEFORE = 'export const value = 1;\n';
const AFTER = 'export const value = 2;\n';
const CARD_BUTTONS = '.approve:not(.done) .actions button';
/** The agent must read a file before it may edit it, so a scripted edit is a read followed by the edit. */
const edit = (path: string) => [callTool('read_file', { path }), callTool('edit_file', { path, old_string: 'value = 1', new_string: 'value = 2' })];

interface EditCase { name: string; button: string; content: string; result: RegExp; toolClass: string; label: string; modeAfter: string }

const EDIT_CASES: EditCase[] = [
  { name: 'approval-allow-applies-the-edit', button: 'Allow', content: AFTER, result: /^Edited /, toolClass: 'ok', label: 'allow', modeAfter: 'Ask before edits' },
  { name: 'approval-deny-leaves-the-file-unchanged', button: 'Deny', content: BEFORE, result: /^DENIED by user/, toolClass: 'fail', label: 'deny', modeAfter: 'Ask before edits' },
  { name: 'approval-allow-all-edits-switches-mode', button: 'Allow all edits', content: AFTER, result: /^Edited /, toolClass: 'ok', label: 'allow all edits', modeAfter: 'Edit automatically' },
];

interface RewindCase { name: string; tool: (path: string) => Array<ReturnType<typeof callTool>>; existing: boolean }

const REWIND_CASES: RewindCase[] = [
  { name: 'rewind-restores-an-edited-file', tool: edit, existing: true },
  { name: 'rewind-removes-a-created-file', tool: (path) => [callTool('write_file', { path, content: 'brand new\n' })], existing: false },
];

export const flows: Flow[] = [
  ...EDIT_CASES.map((c): Flow => ({
    name: c.name,
    async run(t) {
      const file = t.fixture('target.ts', BEFORE);
      const s = await t.newSession();
      await t.gw.script(...edit(file), reply('Finished with the edit.'));
      await s.send('Change the value');

      await s.waitFor('.approve:not(.done) .q', { text: 'Allow file change?' });
      await s.waitFor('.approve:not(.done) .diffbar', { text: 'target.ts' });
      await s.waitFor('.approve:not(.done) .dl.add', { text: 'value = 2' });
      await s.waitFor('.approve:not(.done) .dl.del', { text: 'value = 1' });
      assert.equal(t.read(file), BEFORE, 'nothing is written before the decision');
      await t.shot('approval-card');

      await s.clickText(CARD_BUTTONS, c.button);
      await s.waitFor('.approve.done .q', { text: c.label });
      await s.waitFor('.msg.assistant .md', { text: 'Finished with the edit.' });
      await s.idle();

      assert.equal(t.read(file), c.content);
      await s.waitFor(`.tool.${c.toolClass}`);
      assert.match(String(lastOfRole(await t.gw.last(), 'tool')?.content), c.result);
      await s.waitFor('#modePill', { text: c.modeAfter });
      await t.shot('decided');
    },
  })),
  {
    name: 'approval-open-diff-shows-the-proposed-change',
    async run(t) {
      const file = t.fixture('diffed.ts', BEFORE);
      const s = await t.newSession();
      await t.gw.script(...edit(file), reply('Left it alone.'));
      await s.send('Propose a change');
      await s.waitFor(CARD_BUTTONS);

      await s.click('.approve:not(.done) [data-opendiff]');
      const tab = await waitFor('the diff editor', () => {
        const active = vscode.window.tabGroups.activeTabGroup.activeTab;
        return active?.input instanceof vscode.TabInputTextDiff ? active : undefined;
      });
      assert.match(tab.label, /diffed\.ts \(proposed changes\)/);
      const input = tab.input as vscode.TabInputTextDiff;
      assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), BEFORE);
      assert.equal((await vscode.workspace.openTextDocument(input.modified)).getText(), AFTER);
      await t.shot('diff-editor', { keepActiveTab: true });

      await s.reveal();
      await s.clickText(CARD_BUTTONS, 'Deny');
      await s.waitFor('.msg.assistant .md', { text: 'Left it alone.' });
      await s.idle();
      assert.equal(t.read(file), BEFORE, 'opening the diff does not apply the change');
    },
  },
  {
    name: 'approval-allow-runs-a-command',
    async run(t) {
      const s = await t.newSession();
      await t.gw.script(callTool('run_command', { command: 'Write-Output e2e-command-ran' }), reply('The command finished.'));
      await s.send('Run the command');
      await s.waitFor('.approve:not(.done) .q', { text: 'Allow command?' });
      await s.waitFor('.approve:not(.done) pre', { text: 'e2e-command-ran' });
      await t.shot('command-card');
      await s.clickText(CARD_BUTTONS, 'Allow');
      await s.waitFor('.msg.assistant .md', { text: 'The command finished.' });
      await s.idle();
      await s.waitFor('.tool.ok .result', { text: 'e2e-command-ran' });
      assert.match(String(lastOfRole(await t.gw.last(), 'tool')?.content), /e2e-command-ran/);
    },
  },
  ...REWIND_CASES.map((c): Flow => ({
    name: c.name,
    async run(t) {
      const file = c.existing ? t.fixture('rewound.ts', BEFORE) : `e2e-files/${t.flow.name}/created.ts`;
      const s = await t.newSession();
      await t.gw.script(...c.tool(file), reply('Change made.'));
      await s.send('Make the change');
      await s.clickText(CARD_BUTTONS, 'Allow');
      await s.waitFor('.msg.assistant .md', { text: 'Change made.' });
      await s.idle();
      assert.ok(t.exists(file), 'the change is on disk');
      assert.notEqual(t.read(file), BEFORE);
      await t.shot('before-rewind');

      await s.click('.msg.user .restore');
      await s.waitFor('.msg.info', { text: 'Rewound to before this message' });
      await s.waitGone('.msg.user');
      await s.idle();
      if (c.existing) { assert.equal(t.read(file), BEFORE, 'the file is back to its original content'); }
      else { assert.equal(t.exists(file), false, 'the created file is gone'); }
      assert.equal((await s.query('#in')).value, 'Make the change', 'the message returns to the composer');
      assert.equal(s.main.agent.turnCount, 0, 'the turn left the conversation');
      await t.shot('after-rewind');
    },
  })),
  {
    name: 'stop-while-waiting-for-approval-applies-nothing',
    async run(t) {
      const file = t.fixture('stopped.ts', BEFORE);
      const s = await t.newSession();
      await t.gw.script(...edit(file));
      await s.send('Change it, then I will stop you');
      await s.waitFor(CARD_BUTTONS);
      await s.click('#stop');
      await s.waitFor('.approve.done .q', { text: 'cancelled' });
      await s.waitFor('.msg.info', { text: 'Cancelled.' });
      await s.idle();
      assert.equal(t.read(file), BEFORE);
    },
  },
];
