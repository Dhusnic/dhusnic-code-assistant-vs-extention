import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/* Runs the real follow-the-latest block of media/session.js against a fake scroll container (no DOM library needed). */
const ROOT = fs.existsSync(path.join(__dirname, '..', '..', 'media', 'session.js')) ? path.join(__dirname, '..', '..') : process.cwd();
const JS = fs.readFileSync(path.join(ROOT, 'media', 'session.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'media', 'chat.css'), 'utf8');

type Fn = (e?: unknown) => void;
function harness() {
  const start = JS.indexOf('/* Follow new output');
  const end = JS.indexOf('const k = (n) =>');
  assert.ok(start > 0 && end > start, 'scroll block found in session.js');
  const listeners: Record<string, Fn[]> = {};
  const docListeners: Record<string, Fn[]> = {};
  let content = 300, top = 0;
  const log = {
    clientHeight: 400, children: [] as unknown[],
    get scrollHeight() { return Math.max(content, this.clientHeight); },
    get scrollTop() { return top; },
    set scrollTop(v: number) { top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); },
    scrollTo(o: { top: number }) { this.scrollTop = o.top; },
    addEventListener(t: string, f: Fn) { (listeners[t] ||= []).push(f); },
    contains: (n: unknown) => n === log,
  };
  const jump = { hidden: true } as Record<string, unknown>;
  let roCb: Fn = () => undefined;
  const env = {
    log, composer: { prepend: () => undefined },
    document: { createElement: () => jump, body: {}, addEventListener: (t: string, f: Fn) => (docListeners[t] ||= []).push(f) },
    getComputedStyle: () => ({ overflowY: 'visible' }),
    ResizeObserver: class { constructor(cb: Fn) { roCb = cb; } observe() { /* */ } unobserve() { /* */ } },
    MutationObserver: class { observe() { /* */ } },
  };
  const body = `${JS.slice(start, end)}\nreturn { scroll, isPinned: () => pinned, jumpBtn };`;
  const api = new Function(...Object.keys(env), body)(...Object.values(env));
  const fire = (t: string, e: unknown = {}) => (listeners[t] || []).forEach((f) => f(e));
  const max = () => log.scrollHeight - log.clientHeight;
  /** One streamed token: the reply grows, then assistantToken() calls scroll(). */
  const token = () => { content += 20; api.scroll(); };
  return {
    api, log, fire, max, token, ro: () => roCb(),
    grow: (n: number) => { content += n; }, shrink: (n: number) => { content -= n; log.scrollTop = top; },
    key: (key: string) => (docListeners.keydown || []).forEach((f) => f({ key, target: env.document.body })),
  };
}

test('scroll follow: streaming follows while pinned', () => {
  const h = harness();
  for (let i = 0; i < 100; i++) { h.token(); }
  assert.equal(h.log.scrollTop, h.max());
  assert.ok(h.api.isPinned());
});

test('scroll follow: a scrollbar drag up (scroll event not landed yet) is never undone by streamed tokens', () => {
  const h = harness();
  for (let i = 0; i < 100; i++) { h.token(); }
  h.log.scrollTop = 500;                       // user drags the scrollbar; the scroll event comes a frame later
  for (let i = 0; i < 200; i++) { h.token(); }
  assert.equal(h.log.scrollTop, 500, 'tokens did not pull the view down');
  assert.equal(h.api.isPinned(), false);
  assert.equal(h.api.jumpBtn.hidden, false, 'jump button shown');
  h.fire('scroll');                            // the late scroll event must not re-pin
  for (let i = 0; i < 200; i++) { h.token(); }
  h.ro();                                      // late layout growth (images, mermaid) does not scroll either
  assert.equal(h.log.scrollTop, 500);
});

test('scroll follow: wheel up unpins before its scroll event, and PageUp unpins too', () => {
  const h = harness();
  for (let i = 0; i < 100; i++) { h.token(); }
  const before = h.log.scrollTop;
  h.fire('wheel', { deltaY: -100, target: h.log });
  for (let i = 0; i < 50; i++) { h.token(); }
  assert.equal(h.log.scrollTop, before, 'no token scrolled after the wheel');
  const h2 = harness();
  for (let i = 0; i < 100; i++) { h2.token(); }
  const b2 = h2.log.scrollTop;
  h2.key('PageUp');
  for (let i = 0; i < 50; i++) { h2.token(); }
  assert.equal(h2.log.scrollTop, b2);
});

test('scroll follow: scrolling back to the bottom resumes following; the jump button and force re-pin', () => {
  const h = harness();
  for (let i = 0; i < 100; i++) { h.token(); }
  h.log.scrollTop = 100; h.fire('scroll');
  for (let i = 0; i < 20; i++) { h.token(); }
  assert.equal(h.log.scrollTop, 100);
  h.log.scrollTop = h.max() - 10; h.fire('scroll');   // user scrolls back down to near the bottom
  assert.ok(h.api.isPinned());
  for (let i = 0; i < 20; i++) { h.token(); }
  assert.equal(h.log.scrollTop, h.max(), 'following again');
  h.log.scrollTop = 0; h.fire('scroll');
  (h.api.jumpBtn.onclick as () => void)();
  for (let i = 0; i < 5; i++) { h.token(); }
  assert.equal(h.log.scrollTop, h.max(), 'jump button re-pins');
  h.log.scrollTop = 0; h.fire('scroll');
  h.api.scroll(true);                                    // send / session open
  assert.equal(h.log.scrollTop, h.max());
  assert.ok(h.api.isPinned());
});

test('scroll follow: content shrinking (browser clamps scrollTop) or late growth never unpins', () => {
  const h = harness();
  for (let i = 0; i < 100; i++) { h.token(); }
  h.shrink(300); h.fire('scroll');                       // a tool block collapsed
  assert.ok(h.api.isPinned(), 'clamp is not a user scroll-up');
  h.grow(800); h.ro();                                   // an image / diagram finished loading
  assert.equal(h.log.scrollTop, h.max());
});

test('scroll follow: wheel up when there is nothing to scroll does not leave it unpinned', () => {
  const h = harness();                                    // short conversation: no overflow, scrollTop 0
  h.fire('wheel', { deltaY: -100, target: h.log });
  for (let i = 0; i < 50; i++) { h.token(); }
  assert.equal(h.log.scrollTop, h.max(), 'follows once it overflows');
});

test('slash menu: the command name is never truncated; the description ellipsizes with a tooltip', () => {
  assert.match(CSS, /\.menu\.wide \.item \.row \{ flex: none; white-space: nowrap; \}/);
  assert.doesNotMatch(CSS, /\.menu\.wide \.item \.row span \{[^}]*text-overflow/);
  assert.match(CSS, /\.menu\.wide \.item \.d \{ flex: 1 1 0; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/);
  assert.match(JS, /<span class="d" title="\$\{esc\(it\.desc\)\}">/);
});
