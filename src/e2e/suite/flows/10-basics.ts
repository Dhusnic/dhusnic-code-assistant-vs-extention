import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MODELS } from '../../protocol';
import { lastOfRole, reply, waitFor } from '../harness';
import { Flow } from '../types';

const MARKDOWN = [
  '# Heading One', '',
  'Some **bold words** and `inline code` here.', '',
  '- first item', '- second item', '',
  '| Name | Size |', '|---|---|', '| alpha | 1 |', '| beta | 2 |', '',
  '```ts', 'const answer = 42;', '```', '',
  '```mermaid', 'graph TD', '  A[Start] --> B[Finish]', '```', '',
  'Closing paragraph.',
].join('\n');

export const flows: Flow[] = [
  {
    name: 'extension-activates-without-errors',
    async run(t) {
      assert.ok(t.h.ext.isActive, 'the extension is active');
      assert.ok(t.hub.manager, 'the Hub has a session manager');
      assert.deepEqual(t.hub.webviewErrors, []);
      const registered = await vscode.commands.getCommands(true);
      for (const c of t.h.pkg.contributes.commands) { assert.ok(registered.includes(c.command), `${c.command} is registered`); }
    },
  },
  {
    name: 'sidebar-renders-llm-status-and-session-list',
    async run(t) {
      const s = await t.newSession();
      await t.gw.script(reply('Listed in the sidebar'));
      await s.send('Sidebar listing check');
      await s.waitFor('.msg.assistant .md', { text: 'Listed in the sidebar' });
      await s.idle();

      const side = await t.sidebar();
      await side.waitFor('#llm', { text: 'Online' });
      await side.waitFor('#llm .hdot.ok');
      await side.waitFor('#llm', { text: new URL(String(t.hub.cfg.get('baseUrl'))).host });
      assert.deepEqual((await side.texts('#modelSel option')).sort(), [...MODELS].sort());
      await side.waitFor(`.srow[data-id="${s.id}"] .stitle`, { text: 'Sidebar listing check' });
      await t.shot('sidebar');
    },
  },
  {
    name: 'new-session-opens-from-the-sidebar',
    async run(t) {
      const side = await t.sidebar();
      const before = new Set<string>(t.hub.openPanelIds());
      await side.click('#newSession');
      const s = await t.adoptNewPanel(before);
      await s.waitFor('.empty h2', { text: 'Infraon Assistant', visible: true });
      await s.waitFor('#title', { text: 'New session' });
      await s.waitFor('#modePill', { text: 'Ask before edits' });
      await s.waitFor('#modelPill', { text: MODELS[0] });
      await s.waitFor('#send', { visible: true });
      assert.equal((await s.query('#stop')).visible, false, 'Stop is hidden while idle');
      await t.shot('empty-session');
    },
  },
  {
    name: 'message-streams-a-reply',
    async run(t) {
      const s = await t.newSession();
      const firstHalf = 'Streaming starts here. ';
      await t.gw.script(reply(`${firstHalf}And it finishes later.`, { gate: { name: 'half', afterChars: firstHalf.length } }));
      await s.send('Say something');

      await s.waitFor('.msg.user', { text: 'Say something' });
      await s.waitFor('.msg.assistant .md', { text: 'Streaming starts here.' });
      assert.ok(!(await s.text('.msg.assistant .md')).includes('finishes later'), 'the second half has not arrived yet');
      await s.waitFor('#stop', { visible: true });
      assert.equal((await s.query('#send')).visible, true, 'Send stays available while streaming: it queues the message');
      await t.shot('mid-stream');

      await t.gw.release('half');
      await s.waitFor('.msg.assistant .md', { text: 'And it finishes later.' });
      await s.idle();
      assert.equal(await s.count('.msg.assistant'), 1, 'tokens are appended to one reply');

      const req = await t.gw.last();
      assert.equal(req.stream, true);
      assert.equal(req.model, MODELS[0]);
      assert.equal(lastOfRole(req, 'user')?.content, 'Say something');
      await t.shot('finished');
    },
  },
  {
    name: 'markdown-and-mermaid-render',
    async run(t) {
      const s = await t.newSession();
      await t.gw.script(reply(MARKDOWN));
      await s.send('Show me formatting');
      await s.waitFor('.msg.assistant .md p', { text: 'Closing paragraph.' });
      await s.idle();

      await s.waitFor('.md h1', { text: 'Heading One' });
      await s.waitFor('.md b', { text: 'bold words' });
      await s.waitFor('.md p code', { text: 'inline code' });
      await s.waitFor('.md ul li', { count: 2 });
      await s.waitFor('.md .tablewrap tbody tr', { count: 2 });
      await s.waitFor('.md .codeblock code', { text: 'const answer = 42;' });
      await s.waitFor('.mermaid-block[data-rendered="1"] .mermaid-svg svg', { timeoutMs: 20_000 });
      assert.equal(await s.count('.mermaid-err'), 0, 'the diagram rendered without an error');
      await t.shot('rendered');
    },
  },
  {
    name: 'session-survives-close-and-reopen-from-the-sidebar',
    async run(t) {
      const s = await t.newSession();
      await t.gw.script(reply('The first reply survives.'));
      await s.send('Remember this conversation');
      await s.waitFor('.msg.assistant .md', { text: 'The first reply survives.' });
      await s.idle();
      const id = s.id;

      await s.close();
      await waitFor('the session to unload', () => !t.hub.manager.sessions.has(id));

      const side = await t.sidebar();
      await side.waitFor(`.srow[data-id="${id}"] .stitle`, { text: 'Remember this conversation' });
      await side.click(`.srow[data-id="${id}"] .stitle`);
      await waitFor('the session tab to reopen', () => t.hub.openPanelIds().includes(id));
      const again = await t.attach(id);
      await again.waitFor('.msg.user', { text: 'Remember this conversation' });
      await again.waitFor('.msg.assistant .md', { text: 'The first reply survives.' });
      await t.shot('reopened');

      await t.gw.script(reply('Still has its memory.'));
      await again.send('Do you remember?');
      await again.waitFor('.msg.assistant .md', { text: 'Still has its memory.' });
      await again.idle();
      const contents = (await t.gw.last()).messages.map((m) => m.content);
      assert.ok(contents.includes('Remember this conversation'), 'earlier turns are sent to the LLM after reopening');
      assert.ok(contents.includes('The first reply survives.'), 'earlier replies are sent to the LLM after reopening');
    },
  },
  {
    name: 'context-ring-opens-the-usage-popup',
    async run(t) {
      const s = await t.newSession();
      await t.gw.script(reply('Some reply to measure.'));
      await s.send('Measure the context');
      await s.waitFor('.msg.assistant .md', { text: 'Some reply to measure.' });
      await s.idle();

      await s.click('#ctxRing');
      await s.waitFor('#ctxPop', { visible: true });
      await s.waitFor('#ctxPop .cptot', { text: 'tokens' });
      await s.waitFor('#ctxPop .cptable tbody tr', { count: 8 });
      await s.waitFor('#ctxPop .cpsec', { text: 'CLAUDE.md' });
      await s.waitFor('#ctxPop .kv', { text: 'Turns1' });
      await t.shot('popup');
      await s.click('#cpClose');
      await s.waitGone('#ctxPop');
    },
  },
];
