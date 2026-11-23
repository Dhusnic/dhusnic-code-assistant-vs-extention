import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { buildSessionHtml, buildSidebarHtml } from '../core/html';

const ROOT = path.join(__dirname, '..', '..');
const MEDIA = path.join(ROOT, 'media');
const read = (f: string) => fs.readFileSync(path.join(MEDIA, f), 'utf8');
const { md, esc } = require(path.join(MEDIA, 'md.js'));

const parts = { nonce: 'N0NCE', cspSource: 'vscode-resource:', cssUri: 'c.css', jsUri: 'c.js', mdUri: 'm.js', mermaidUri: 'mm.js', logoSvg: '<svg viewBox="0 0 1 1"></svg>' };
const session = buildSessionHtml(parts);
const sidebar = buildSidebarHtml(parts);

test('html: strict script CSP with nonce; images only from the extension or data: (screenshots)', () => {
  for (const h of [session, sidebar]) {
    assert.match(h, /script-src 'nonce-N0NCE'/);
    assert.match(h, /default-src 'none'/);
    assert.match(h, /img-src vscode-resource: data:/);
    assert.doesNotMatch(h, /<script(?![^>]*src=)[^>]*>/, 'no inline scripts');
    assert.doesNotMatch(h, /https?:\/\//, 'no remote resources');
  }
  assert.ok(session.indexOf('"mm.js"') < session.indexOf('"m.js"') && session.indexOf('"m.js"') < session.indexOf('"c.js"'), 'mermaid, md, then app');
  assert.doesNotMatch(sidebar, /mm\.js/, 'sidebar does not load mermaid');
});

test('webview scripts have valid syntax', () => {
  for (const f of ['session.js', 'sidebar.js', 'md.js']) { execFileSync(process.execPath, ['--check', path.join(MEDIA, f)]); }
});

for (const [file, html] of [['session.js', session], ['sidebar.js', sidebar]] as const) {
  test(`${file} only references element ids that exist in its HTML`, () => {
    const ids = [...read(file).matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]);
    assert.ok(ids.length > 5);
    // Elements the script creates itself (popups, viewer, launcher) are found by their id="…" / .id = '…' in the script.
    const js = read(file);
    const dynamic = new Set([...js.matchAll(/id="([\w-]+)"/g), ...js.matchAll(/\.id = '([\w-]+)'/g)].map((m) => m[1]));
    for (const id of new Set(ids)) {
      if (dynamic.has(id)) { continue; }
      assert.ok(html.includes(`id="${id}"`), `missing #${id} in HTML for ${file}`);
    }
  });
}

test('session.js handles every transcript event type the runtime can emit', () => {
  const runtime = fs.readFileSync(path.join(ROOT, 'src', 'core', 'runtime.ts'), 'utf8');
  const logged = /const LOGGED = new Set\(\[([^\]]+)\]\)/.exec(runtime)![1].match(/'(\w+)'/g)!.map((s) => s.slice(1, -1));
  const js = read('session.js');
  for (const t of [...logged, 'rewound', 'start', 'end', 'usage']) { assert.ok(js.includes(`case '${t}'`), `session.js does not handle '${t}'`); }
});

test('session view persists its session id so VS Code can restore the tab after a restart', () => {
  // The same session keeps what is saved with it (its input history); another session starts with just its id.
  assert.match(read('session.js'), /vscode\.setState\(prev\.sessionId === state\.sessionId \? prev : \{ sessionId: state\.sessionId \}\)/);
});

test('session header has the "your messages" clock button, and successful edits show a pen', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'core', 'html.js'), 'utf8');
  assert.match(html, /id="histBtn"/);
  assert.match(read('session.js'), /\$\('histBtn'\)\.onclick/);
  assert.match(read('chat.css'), /\.tool\.edit\.ok \.status::before \{ content: '\\270E'/);
  assert.match(read('session.js'), /m\.kind === 'edit' \? ' edit' : ''/);
});

test('mermaid is bundled locally and initialised in strict security mode', () => {
  assert.ok(fs.statSync(path.join(MEDIA, 'vendor', 'mermaid.min.js')).size > 1_000_000);
  assert.match(read('session.js'), /securityLevel: 'strict'/);
});

test('logo assets exist and the PNG is a valid 128x128 image', () => {
  const png = fs.readFileSync(path.join(MEDIA, 'icon.png'));
  assert.deepEqual([...png.subarray(1, 4)], [...Buffer.from('PNG')]);
  assert.equal(png.readUInt32BE(16), 128); assert.equal(png.readUInt32BE(20), 128);
  assert.match(read('logo.svg'), /^<svg[^>]*viewBox="0 0 512 512"/);
  assert.match(read('icon.svg'), /currentColor/, 'activity-bar icon must be monochrome');
});

test('manifest: sidebar view, tab serializer activation, commands and icon are wired', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.icon, 'media/icon.png');
  assert.ok(pkg.activationEvents.includes('onWebviewPanel:infraonAssistant.session'));
  assert.equal(pkg.contributes.views.infraonAssistant[0].id, 'infraonAssistant.sessions');
  const cmds = pkg.contributes.commands.map((c: any) => c.command);
  for (const c of ['infraonAssistant.newSession', 'infraonAssistant.setApiKey', 'infraonAssistant.toggleInlineCompletions']) { assert.ok(cmds.includes(c), c); }
  const ext = fs.readFileSync(path.join(ROOT, 'src', 'host', 'extension.ts'), 'utf8') + fs.readFileSync(path.join(ROOT, 'src', 'host', 'features', 'editorActions.ts'), 'utf8');
  for (const c of cmds) { assert.ok(ext.includes(`'${c}'`), `${c} declared but not registered`); }
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'ocr.ps1')), 'OCR script ships with the extension');
  const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
  const lines = ignore.split(/\r?\n/);
  // Build-only scripts may be excluded one by one, but never a glob over scripts/ and never the OCR script itself.
  for (const line of lines.filter((l) => /^scripts/.test(l))) {
    assert.match(line, /^scripts\/[\w.-]+\.(m?js)$/, `.vscodeignore may only drop individual build scripts: ${line}`);
  }
  // Release output (signed update files, zips handed to IT) must never be packed into the extension itself.
  for (const p of ['dist/**', 'server/**', '*.vsix', '*.zip']) { assert.match(ignore, new RegExp(`^${p.replace(/[.*]/g, '\\$&')}\\r?$`, 'm'), p); }
  // From dist/ only the bundle (package.json main) is shipped, and the re-include must come after `dist/**`.
  const pkgMain = pkg.main.replace(/^\.\//, '');
  assert.deepEqual(lines.filter((l) => l.startsWith('!dist/')), [`!${pkgMain}`]);
  assert.ok(lines.indexOf(`!${pkgMain}`) > lines.indexOf('dist/**'), 'the bundle is re-included after dist/** is excluded');
});

test('md: escapes HTML and script injection', () => {
  const out = md('<img src=x onerror=alert(1)> and <script>alert(1)</script>');
  assert.doesNotMatch(out, /<img|<script/);
  assert.equal(esc('"<&>'), '&quot;&lt;&amp;&gt;');
});

test('md: code blocks keep content verbatim and escaped; unterminated fences still render', () => {
  assert.match(md('```ts\nconst a = "<b>";\n```'), /const a = &quot;&lt;b&gt;&quot;;/);
  assert.match(md('```py\nprint(1)'), /print\(1\)/);
});

test('views from older versions are still answered, so a hot-restarted extension host never leaves a spinning panel', () => {
  const ext = fs.readFileSync(path.join(ROOT, 'src', 'host', 'extension.ts'), 'utf8');
  assert.match(ext, /LEGACY_VIEW_IDS = \['infraonAssistant\.chat'\]/);
  assert.match(ext, /LEGACY_VIEW_IDS\.map\(\(id\) => vscode\.window\.registerWebviewViewProvider\(id/);
  assert.match(ext, /enableCommandUris: \['workbench\.action\.reloadWindow'\]/, 'only the reload command is allowed from the notice');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const current = pkg.contributes.views.infraonAssistant.map((v: any) => v.id);
  assert.ok(!current.includes('infraonAssistant.chat'), 'legacy id is not re-declared in the manifest');
});

test('context meter is a circular ring with a percentage in the session header, not a bar at the bottom', () => {
  const hdr = /<div id="hdr"[^>]*>[\s\S]*?<\/div>\n<div id="activity"/.exec(session)![0];
  assert.match(hdr, /id="ctxRing"[\s\S]*<circle class="arc" id="ctxArc"[\s\S]*id="ctxPct">0%</);
  assert.ok(hdr.indexOf('ctxRing') < hdr.indexOf('sidebarBtn'), 'ring sits before the Sessions button');
  assert.doesNotMatch(session, /id="ctx"|id="ctxlabel"/, 'old bottom bar removed');
  const js = read('session.js');
  assert.match(js, /strokeDashoffset = `\$\{RING_C \* \(1 - pct \/ 100\)\}`/);
  assert.match(js, /used > 0 && pct < 1 \? '<1%'/);
  assert.match(read('chat.css'), /\.ring\.hot \.arc/);
});


test('session header is compact: agents collapse into one button with a dropdown (no separate agent bar)', () => {
  const hdr = /<div id="hdr"[^>]*>[\s\S]*?<\/div>\n<div id="activity"/.exec(session)![0];
  assert.match(hdr, /class="compact"/);
  assert.match(hdr, /id="agentBtn"[^>]*aria-haspopup="menu"/);
  assert.ok(hdr.indexOf('agentBtn') < hdr.indexOf('ctxRing'), 'agent button before the context ring');
  assert.doesNotMatch(session, /id="agents"/, 'old agent bar removed');
  assert.doesNotMatch(hdr, />Sessions<|＋ Session/, 'header buttons are icons, not text');
  const js = read('session.js');
  // Claude-style agents: view a sub-agent, go back to Main, launch one, stop or remove it.
  for (const msg of ["type: 'viewAgent'", "type: 'backToMain'", "type: 'spawnAgent'", "type: 'stopAgent'", "type: 'removeAgent'"]) { assert.ok(js.includes(msg), msg); }
  assert.doesNotMatch(js, /type: 'addAgent'|type: 'forkAgent'/, 'no parallel-conversation agents any more (fork is an agent type)');
  assert.match(read('chat.css'), /\.agent-btn\.attn/, 'another agent waiting for approval is highlighted');
});

test('every reply has Copy and Bookmark; tables and diagrams have Copy; diagrams can be maximized', () => {
  const js = read('session.js');
  assert.match(js, /class="ma copy" title="Copy reply"/);
  assert.match(js, /class="ma bm" title="Bookmark this reply"/);
  assert.match(js, /type: 'bookmark', turn: Number\(reply\.dataset\.turn\)/);
  assert.match(js, /t\.dataset\.copyTable === 'md'/);
  assert.ok(js.includes(String.raw`.join('\t')`), 'table copy for Excel is tab-separated');
  assert.match(js, /Maximize/);
  assert.match(read('chat.css'), /\.msg\.assistant\.bookmarked \.ma\.bm/);
});

test('diagram viewer: two-finger pan, pinch/ctrl+wheel zoom, touch pinch, drag, arrow keys, +/- , 0 fit, Esc close', () => {
  const js = read('session.js');
  assert.match(js, /if \(e\.ctrlKey \|\| e\.metaKey\) \{ zoomAt\(/, 'trackpad pinch (ctrl+wheel) zooms');
  assert.match(js, /else \{ view\.x -= e\.deltaX; view\.y -= e\.deltaY; apply\(\); \}/, 'two-finger scroll pans in both axes');
  assert.match(js, /pts\.size === 2/, 'touch pinch with two fingers');
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', "'+'", "'-'", '0: fit', 'Escape: closeViewer']) { assert.ok(js.includes(key), key); }
  assert.match(js, /data-z="close"/);
  assert.match(read('chat.css'), /\.vstage \{[^}]*touch-action: none/, 'browser gestures do not hijack pinch/pan');
});

test('context ring opens a Claude-style breakdown popup', () => {
  const js = read('session.js');
  assert.match(js, /\$\('ctxRing'\)\.onclick/);
  for (const key of ['system', 'tools', 'mcp', 'agents', 'memory', 'messages', 'buffer', 'free']) { assert.ok(new RegExp(`${key}: '`).test(js), `colour for ${key}`); }
  assert.match(js, /Auto-compacts at/);
});

test('session name: pencil icon, inline edit with autosave, native Ctrl+Z, Enter to finish, Esc to revert', () => {
  assert.match(session, /id="titleEdit"/);
  const js = read('session.js');
  assert.match(js, /timer = setTimeout\(\(\) => save\(field\.value\), 400\)/, 'autosaves while typing');
  assert.match(js, /e\.key === 'Escape'\) \{ e\.preventDefault\(\); finish\(true\)/, 'Esc reverts');
  assert.match(js, /post\(\{ type: 'setTitle'/);
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'host', 'sessionPanel.ts'), 'utf8');
  assert.match(panel, /case 'setTitle'/);
});
