import * as assert from 'node:assert/strict';
import { SessionDriver, waitFor } from '../harness';
import { Flow } from '../types';

interface SlashCase { name: string; input: string; info: string; check?(s: SessionDriver): Promise<unknown> }

const SLASH_CASES: SlashCase[] = [
  { name: 'slash-help-lists-commands', input: '/help', info: '/help — Show available commands' },
  { name: 'slash-mode-changes-the-mode', input: '/mode auto-edit', info: 'Mode: Edit automatically', check: (s) => s.waitFor('#modePill.mode-auto-edit', { text: 'Edit automatically' }) },
  { name: 'slash-mode-rejects-an-unknown-mode', input: '/mode sideways', info: 'Usage: /mode <ask|auto-edit|auto|plan>', check: (s) => s.waitFor('#modePill', { text: 'Ask before edits' }) },
  { name: 'slash-effort-changes-the-effort', input: '/effort high', info: 'Effort: high', check: (s) => s.waitFor('#effortPill', { text: 'Effort: High' }) },
  { name: 'slash-unknown-command-is-reported', input: '/frobnicate', info: 'Unknown command /frobnicate' },
];

interface SkillsEntry { name: string; open(s: SessionDriver): Promise<void> }

const SKILLS_ENTRIES: SkillsEntry[] = [
  { name: 'skills-manager-opens-from-the-toolbar', open: (s) => s.click('#skillsPill') },
  { name: 'skills-manager-opens-with-slash-skills', open: (s) => s.send('/skills') },
];

export const flows: Flow[] = [
  ...SLASH_CASES.map((c): Flow => ({
    name: c.name,
    async run(t) {
      const s = await t.newSession();
      await s.send(c.input);
      await s.waitFor('.msg.info', { text: c.info });
      await c.check?.(s);
      assert.equal((await t.gw.requests()).length, 0, 'slash commands do not call the LLM');
      assert.equal(await s.count('.msg.user'), 0, 'slash commands are not sent as chat messages');
      await t.shot('result');
    },
  })),
  {
    name: 'slash-popup-completes-a-command-with-enter',
    async run(t) {
      const s = await t.newSession();
      await s.input('#in', '/he');
      await s.waitFor('.menu.wide .item', { text: '/help' });
      await t.shot('popup');
      await s.key('#in', 'Enter');
      await s.waitGone('.menu.wide');
      assert.equal((await s.query('#in')).value, '/help ');
    },
  },
  ...SKILLS_ENTRIES.map((c): Flow => ({
    name: c.name,
    async run(t) {
      await waitFor('the fixture skill to load', () => t.hub.skills.some((x: any) => x.name === 'demo-skill'));
      const s = await t.newSession();
      await c.open(s);
      await s.waitFor('#skillsModal', { visible: true });
      await s.waitFor('.sk-row[data-name="demo-skill"] .sk-name', { text: '/demo-skill' });
      await s.waitFor('.sk-row[data-name="demo-skill"] .sk-desc', { text: 'Demo skill for the automated UI tests' });
      await t.shot('skills-list');

      await s.input('#skSearch', 'no-such-skill');
      await s.waitFor('.sk-empty', { text: 'No skills match.' });
      await s.input('#skSearch', 'demo');
      await s.waitFor('.sk-row[data-name="demo-skill"]');

      await s.click('#skNew');
      await s.waitFor('#sfName', { visible: true });
      await s.click('#skBack');
      await s.waitFor('.sk-row[data-name="demo-skill"]');

      await s.click('#skClose');
      await s.waitGone('#skillsModal');
    },
  })),
];
