/* Infraon session tab: one main conversation (Claude-style) + live views of its sub-agents. */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $('log'), input = $('in'), composer = $('composer');
  const { md, esc, autolink } = window.InfraonMd;
  const state = { mode: 'ask', effort: 'medium', model: '', models: [], modeInfo: {}, effortInfo: {}, commands: [], sessionId: '', agentId: '', mainId: '', viewingSub: false, focusedAgent: {}, agentTypes: [], contextLimit: 0 };
  let logo = '', agents = [], busy = false, cur = null, curText = '', curTurn = -1, images = [], bookmarks = new Set(), replaying = false;
  const BUSY = ['queued', 'running', 'waiting'];
  const STATUS_LABEL = { idle: 'Idle', queued: 'Queued', running: 'Working', waiting: 'Needs your approval', error: 'Error', interrupted: 'Interrupted' };
  const OUTCOME_LABEL = { completed: 'Completed', failed: 'Failed', cancelled: 'Stopped' };
  const post = (m) => vscode.postMessage(m);
  if (window.InfraonProbe) { window.InfraonProbe.install(post, () => !!state.e2e); }
  /* Follow new output only while the user is at the bottom; scrolling up to read stops the follow (like Claude). */
  let pinned = true;
  const jumpBtn = document.createElement('button');
  jumpBtn.id = 'jumpLatest'; jumpBtn.className = 'jump-latest'; jumpBtn.hidden = true;
  jumpBtn.title = 'Scroll to the latest output'; jumpBtn.textContent = '↓ Jump to latest';
  composer.prepend(jumpBtn);
  const gap = () => log.scrollHeight - log.scrollTop - log.clientHeight;
  const nearBottom = () => gap() < 48;
  // Direction-aware: any move up unpins at once; only reaching the bottom pins again. (Growing content never changes
  // scrollTop, so it cannot re-pin by itself.) A drop in scrollTop that still sits at the very bottom is the browser
  // clamping after content shrank (a tool block collapsing, the task card re-rendering), not the user: it never unpins.
  let lastTop = 0;
  const movedUp = (top) => top < lastTop - 2 && gap() > 2;
  log.addEventListener('scroll', () => {
    const top = log.scrollTop;
    if (movedUp(top)) { pinned = false; } else if (nearBottom()) { pinned = true; jumpBtn.hidden = true; }
    lastTop = top;
  }, { passive: true });
  // A wheel/touch/key scroll up unpins immediately, even before the scroll event lands between two streamed tokens.
  // Not when the log cannot move up (top, or nothing to scroll) or a nested scroller (code block, diff) takes the wheel:
  // that would leave it unpinned at the bottom with no scroll event to ever re-pin it.
  const innerTakesWheel = (el) => {
    for (; el && el !== log; el = el.parentElement) { if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY)) { return true; } }
    return false;
  };
  log.addEventListener('wheel', (e) => { if (e.deltaY < 0 && log.scrollTop > 0 && !innerTakesWheel(e.target)) { pinned = false; } }, { passive: true });
  log.addEventListener('touchmove', () => { pinned = nearBottom(); }, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (!['PageUp', 'ArrowUp', 'Home'].includes(e.key) || log.scrollTop <= 0) { return; }
    const t = e.target;
    if (t === document.body || t === log || (log.contains(t) && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.isContentEditable)) { pinned = false; }
  });
  /** force: the user just sent a message, or a session was opened / switched / replayed, so always show the bottom.
   *  Otherwise follow only while pinned; first catch a user scroll-up (e.g. a scrollbar drag) whose scroll event has not
   *  landed yet, so a streamed token can never pull the view back down. */
  const scroll = (force) => {
    if (force === true) { pinned = true; } else if (movedUp(log.scrollTop)) { pinned = false; lastTop = log.scrollTop; }
    else if (!pinned && log.clientHeight > 0 && log.scrollHeight <= log.clientHeight + 2) { pinned = true; }   // nothing above to read
    if (pinned) { log.scrollTo({ top: log.scrollHeight, behavior: 'instant' }); lastTop = log.scrollTop; jumpBtn.hidden = true; } else { jumpBtn.hidden = false; }
  };
  jumpBtn.onclick = () => { pinned = true; jumpBtn.hidden = true; log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' }); };
  // Late growth nobody calls scroll() for (images loading, mermaid diagrams, tool results, blocks expanding, the panel or
  // composer resizing) keeps the view at the bottom while pinned; it never scrolls once the user has scrolled up.
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => { if (pinned && log.clientHeight > 0) { scroll(); } });
    ro.observe(log);
    for (const c of log.children) { ro.observe(c); }
    new MutationObserver((muts) => {
      for (const mu of muts) {
        mu.addedNodes.forEach((n) => { if (n.nodeType === 1) { ro.observe(n); } });
        mu.removedNodes.forEach((n) => { if (n.nodeType === 1) { ro.unobserve(n); } });
      }
    }).observe(log, { childList: true });
  }
  const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);
  const since = (ts) => { if (!ts) { return ''; } const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; } return (h >>> 0).toString(16); };
  const ICON = {
    copy: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5" y="5" width="8.5" height="9" rx="1.5"/><path d="M3 10.5V3.5A1.5 1.5 0 014.5 2h6"/></svg>',
    check: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 8.5l3 3 7-7"/></svg>',
    bm: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 2.5h8v11l-4-2.8-4 2.8z"/></svg>',
    bmOn: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" stroke="currentColor" stroke-width="1.3"><path d="M4 2.5h8v11l-4-2.8-4 2.8z"/></svg>',
    expand: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9"/></svg>',
  };

  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
    if (btn) { const old = btn.innerHTML; btn.innerHTML = btn.classList.contains('ma') ? ICON.check : 'Copied'; btn.classList.add('done'); setTimeout(() => { btn.innerHTML = old; btn.classList.remove('done'); }, 1200); }
  }

  /* ================================================================ mermaid */
  const mermaidCache = new Map();
  let mermaidSeq = 0, mermaidLoading = null;
  const scriptNonce = document.currentScript && document.currentScript.nonce;
  /** The diagram library is large, so it is fetched only when the first diagram needs rendering. */
  function loadMermaid() {
    mermaidLoading ??= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.nonce = scriptNonce; s.src = document.body.dataset.mermaid;
      s.onload = () => {
        const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
        window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', fontFamily: 'var(--vscode-font-family)' });
        resolve();
      };
      s.onerror = () => reject(new Error('the diagram library could not be loaded'));
      document.head.appendChild(s);
    });
    return mermaidLoading;
  }
  function placeSvg(block, entry) {
    if (block.dataset.rendered) { return; }
    block.dataset.rendered = '1';
    const src = block.querySelector('.mermaid-src');
    const bar = block.querySelector('.bar');
    if (!entry.svg) {
      const err = document.createElement('div'); err.className = 'mermaid-err'; err.textContent = `Diagram could not be rendered: ${entry.error}`;
      src.before(err); return;
    }
    const box = document.createElement('div'); box.className = 'mermaid-svg'; box.innerHTML = entry.svg; box.title = 'Double-click to maximize';
    box.ondblclick = () => openViewer(entry.svg, block.getAttribute('data-src'));
    src.style.display = 'none'; src.before(box);
    const toggle = document.createElement('button'); toggle.className = 'icon-btn'; toggle.textContent = 'Source';
    toggle.onclick = () => { const show = src.style.display === 'none'; src.style.display = show ? '' : 'none'; box.style.display = show ? 'none' : ''; toggle.textContent = show ? 'Diagram' : 'Source'; };
    const max = document.createElement('button'); max.className = 'icon-btn'; max.innerHTML = `${ICON.expand} Maximize`; max.title = 'Open full screen with pan & zoom';
    max.onclick = () => openViewer(entry.svg, block.getAttribute('data-src'));
    bar.append(toggle, max);
  }
  function renderMermaid(root) {
    if (!root || !root.querySelector('.mermaid-block[data-complete="1"]:not([data-rendered])')) { return; }
    if (!window.mermaid) {
      loadMermaid().then(() => renderMermaid(document.body), (e) => {
        document.querySelectorAll('.mermaid-block[data-complete="1"]:not([data-rendered])').forEach((b) => placeSvg(b, { error: e.message }));
      });
      return;
    }
    root.querySelectorAll('.mermaid-block[data-complete="1"]:not([data-rendered])').forEach((block) => {
      const src = block.getAttribute('data-src');
      const hit = mermaidCache.get(src);
      if (hit && hit !== 'pending') { placeSvg(block, hit); return; }
      if (hit === 'pending') { return; }
      mermaidCache.set(src, 'pending');
      window.mermaid.render(`mmd-${++mermaidSeq}`, src)
        .then(({ svg }) => ({ svg }), (e) => ({ error: String((e && e.message) || e).split('\n')[0] }))
        .then((entry) => {
          mermaidCache.set(src, entry);
          document.querySelectorAll('.mermaid-block[data-complete="1"]:not([data-rendered])').forEach((b) => { if (b.getAttribute('data-src') === src) { placeSvg(b, entry); } });
        });
    });
  }

  /* ---------- full-screen diagram viewer: two-finger pan, pinch / ctrl+wheel zoom, drag, arrows, +/-, 0, Esc ---------- */
  function openViewer(svgMarkup, source) {
    closeViewer();
    const v = document.createElement('div'); v.className = 'viewer'; v.id = 'viewer'; v.tabIndex = -1;
    v.innerHTML = `<div class="vbar"><b>Diagram</b><span class="spacer"></span>
      <button class="icon-btn" data-z="out" title="Zoom out (−)">−</button><span class="vpct" id="vpct">100%</span><button class="icon-btn" data-z="in" title="Zoom in (+)">+</button>
      <button class="icon-btn" data-z="fit" title="Fit to screen (0)">Fit</button><button class="icon-btn" data-z="one" title="Actual size (1)">100%</button>
      <button class="icon-btn" data-z="copy" title="Copy Mermaid source">Copy</button><button class="icon-btn vclose" data-z="close" title="Close (Esc)">✕</button></div>
      <div class="vstage" id="vstage"><div class="vcanvas" id="vcanvas">${svgMarkup}</div></div>
      <div class="vhint">Two-finger scroll to move · pinch or Ctrl + scroll to zoom · drag to pan · arrows move (Shift = faster) · + / − zoom · 0 fit · Esc close</div>`;
    document.body.appendChild(v);
    const stage = v.querySelector('#vstage'), canvas = v.querySelector('#vcanvas'), svg = canvas.querySelector('svg');
    let w = 800, h = 600;
    if (svg) {
      const vb = svg.viewBox && svg.viewBox.baseVal;
      if (vb && vb.width) { w = vb.width; h = vb.height; }
      svg.removeAttribute('style'); svg.setAttribute('width', w); svg.setAttribute('height', h);
    }
    const view = { x: 0, y: 0, s: 1 };
    const MIN = 0.05, MAX = 12;
    const apply = () => { canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`; v.querySelector('#vpct').textContent = `${Math.round(view.s * 100)}%`; };
    const zoomAt = (factor, cx, cy) => {
      const s = Math.min(MAX, Math.max(MIN, view.s * factor));
      view.x = cx - ((cx - view.x) * s) / view.s; view.y = cy - ((cy - view.y) * s) / view.s; view.s = s; apply();
    };
    const center = () => { const r = stage.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
    const fit = () => { const r = stage.getBoundingClientRect(); view.s = Math.min(MAX, Math.max(MIN, Math.min(r.width / w, r.height / h) * 0.92)); view.x = (r.width - w * view.s) / 2; view.y = (r.height - h * view.s) / 2; apply(); };
    const one = () => { const r = stage.getBoundingClientRect(); view.s = 1; view.x = (r.width - w) / 2; view.y = (r.height - h) / 2; apply(); };
    requestAnimationFrame(fit);

    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) { zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top); }  // trackpad pinch arrives as ctrl+wheel
      else { view.x -= e.deltaX; view.y -= e.deltaY; apply(); }                                            // two-finger scroll pans
    }, { passive: false });
    const pts = new Map(); let last = null;
    const pinchInfo = () => { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; };
    stage.addEventListener('pointerdown', (e) => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = pts.size === 2 ? pinchInfo() : { x: e.clientX, y: e.clientY }; stage.classList.add('grabbing'); });
    stage.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) { return; }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const r = stage.getBoundingClientRect();
      if (pts.size === 2) {                               // touch: pinch to zoom, move both fingers to pan
        const p = pinchInfo();
        if (last && last.d) { zoomAt(p.d / last.d, p.mx - r.left, p.my - r.top); view.x += p.mx - last.mx; view.y += p.my - last.my; apply(); }
        last = p;
      } else if (pts.size === 1 && last && last.x !== undefined) {
        view.x += e.clientX - last.x; view.y += e.clientY - last.y; last = { x: e.clientX, y: e.clientY }; apply();
      }
    });
    const up = (e) => { pts.delete(e.pointerId); last = pts.size === 1 ? { ...[...pts.values()][0] } : null; if (!pts.size) { stage.classList.remove('grabbing'); } };
    stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
    stage.addEventListener('dblclick', (e) => { const r = stage.getBoundingClientRect(); zoomAt(e.shiftKey ? 0.5 : 2, e.clientX - r.left, e.clientY - r.top); });
    v.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 200 : 50;
      const [cx, cy] = center();
      const keys = {
        ArrowLeft: () => { view.x += step; }, ArrowRight: () => { view.x -= step; }, ArrowUp: () => { view.y += step; }, ArrowDown: () => { view.y -= step; },
        '+': () => zoomAt(1.25, cx, cy), '=': () => zoomAt(1.25, cx, cy), '-': () => zoomAt(0.8, cx, cy), _: () => zoomAt(0.8, cx, cy),
        0: fit, 1: one, Escape: closeViewer,
      };
      const fn = keys[e.key]; if (!fn) { return; }
      e.preventDefault(); fn(); if (e.key !== 'Escape') { apply(); }
    });
    v.querySelector('.vbar').addEventListener('click', (e) => {
      const z = e.target.closest('[data-z]')?.dataset.z; if (!z) { return; }
      const [cx, cy] = center();
      ({ in: () => zoomAt(1.25, cx, cy), out: () => zoomAt(0.8, cx, cy), fit, one, close: closeViewer, copy: () => copyText(source || '', e.target.closest('button')) })[z]();
    });
    v.focus();
  }
  function closeViewer() { $('viewer')?.remove(); input.focus(); }

  /* ================================================================ transcript rendering */
  function clearEmpty() { log.querySelector('.empty')?.remove(); }
  function add(cls, html) { clearEmpty(); const d = document.createElement('div'); d.className = `msg ${cls}`; d.innerHTML = html; log.appendChild(d); scroll(); return d; }
  function showEmpty() {
    if (state.viewingSub) { log.innerHTML = '<div class="empty"><p>This agent has not produced any output yet.</p></div>'; return; }
    log.innerHTML = `<div class="empty">${logo}<h2>Infraon Assistant</h2><p>Powered by your company LLM. Your code never leaves the network.</p>
      <div class="chips">
        <button class="chip" data-s="Explain the structure of this project">Explain the structure of this project</button>
        <button class="chip" data-s="Find and fix bugs in the file I have open">Find and fix bugs in the open file</button>
        <button class="chip" data-s="Use parallel explore agents to map how this repo is organised, then summarise">Map this repo with parallel agents</button>
      </div></div>`;
    log.querySelectorAll('.chip').forEach((c) => (c.onclick = () => { input.value = c.dataset.s; send(); }));
  }
  const viewBtn = (id, label = 'View') => `<button class="link view-agent" data-view="${esc(id)}">${esc(label)}</button>`;

  function userMsg(m) {
    if (m.midTurn) {
      cur = null;
      const q = add('user mid', esc(m.text));
      q.dataset.raw = m.text;
      q.insertAdjacentHTML('afterbegin', '<div class="mid-tag">Sent while the agent was working</div>');
      if (m.thumbs && m.thumbs.length) { q.insertAdjacentHTML('beforeend', `<div class="thumbs">${m.thumbs.map((t) => `<img src="${esc(t)}" alt="screenshot">`).join('')}</div>`); }
      return;
    }
    curTurn = m.turn ?? curTurn;
    cur = null;
    if (m.notification || (typeof m.text === 'string' && m.text.startsWith('🔔'))) {
      const items = m.notification || [];
      const d = add('notice', items.length
        ? items.map((n) => `<div class="nrow"><span class="nicon ${esc(n.outcome || '')}">${n.outcome === 'completed' ? '✓' : n.outcome === 'cancelled' ? '■' : '!'}</span><span>Background agent <b>${esc(n.description)}</b> ${esc(OUTCOME_LABEL[n.outcome] || n.outcome || 'finished')}</span>${viewBtn(n.id)}</div>`).join('')
        : `<div class="nrow"><span>${esc(m.text)}</span></div>`);
      d.dataset.turn = m.turn;
      return;
    }
    const d = add('user', esc(m.text));
    d.dataset.raw = m.text;   // no force here: send() already jumped; a queued message starting later must not yank a reader
    if (m.thumbs && m.thumbs.length) { d.insertAdjacentHTML('beforeend', `<div class="thumbs">${m.thumbs.map((t) => `<img src="${esc(t)}" alt="screenshot">`).join('')}</div>`); }
    if (m.files && m.files.length) { d.insertAdjacentHTML('beforeend', `<div class="att">${m.files.map((f) => `<span>${f.startsWith('🖼') ? '' : '📎 '}${esc(f)}</span>`).join('')}</div>`); }
    if (m.turn !== undefined) {
      d.dataset.turn = m.turn;
      const b = document.createElement('button'); b.className = 'icon-btn restore'; b.textContent = '↶ Restore';
      b.title = 'Rewind this conversation and its file changes to before this message';
      b.onclick = () => post({ type: 'rewind', turn: m.turn }); d.appendChild(b);
    }
  }

  function newReply() {
    const d = add('assistant', '<div class="md"></div>');
    d.dataset.turn = curTurn;
    d.insertAdjacentHTML('beforeend', `<div class="msg-actions"><button class="ma copy" title="Copy reply">${ICON.copy}</button><button class="ma bm" title="Bookmark this reply">${ICON.bm}</button></div>`);
    return d;
  }
  function setReplyText(d, text) { d.dataset.raw = text; d.querySelector('.md').innerHTML = md(text); renderMermaid(d); }
  function assistantToken(t) { if (!cur) { cur = newReply(); curText = ''; } curText += t; setReplyText(cur, curText); scroll(); }
  function assistantText(t) { cur = null; markBookmark(setReplyAndReturn(newReply(), t)); }
  function setReplyAndReturn(d, t) { setReplyText(d, t); return d; }
  const replyKey = (d) => `${d.dataset.turn}:${hash(d.dataset.raw || '')}`;
  function markBookmark(d) {
    const on = bookmarks.has(replyKey(d));
    d.classList.toggle('bookmarked', on);
    const b = d.querySelector('.ma.bm'); if (b) { b.innerHTML = on ? ICON.bmOn : ICON.bm; b.title = on ? 'Remove bookmark' : 'Bookmark this reply'; }
  }

  function diffHtml(diff) {
    if (!diff) { return ''; }
    const rows = diff.lines.map((l) => (l.t === 'gap'
      ? `<div class="dl gap">⋯ ${esc(l.text)}</div>`
      : `<div class="dl ${l.t}"><span class="no">${l.n}</span><span>${l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' '} ${esc(l.text)}</span></div>`)).join('');
    return `<div class="diffbar"><span>${esc(diff.path)}</span><span class="add">+${diff.added}</span><span class="del">−${diff.removed}</span><span class="spacer"></span><button class="icon-btn" data-opendiff="${esc(diff.id)}">Open diff</button></div><div class="diff">${rows || '<div class="dl gap">No changes</div>'}</div>`;
  }
  /* ---------- task list (todo_write): live checklist; click a step to see what was done during it ---------- */
  const openSteps = new Set();
  let todoSig = '', lastTodos = null;
  const dur = (ms) => (ms === undefined || ms === null || ms < 0 ? '' : ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
  /** When the agent stopped while a step was still in_progress: that step's clock and spinner freeze there. */
  let todoPausedAt = 0;
  const stepTime = (t) => (t.status === 'completed' && t.startedAt && t.finishedAt ? dur(t.finishedAt - t.startedAt) : t.status === 'in_progress' && t.startedAt ? dur((busy ? Date.now() : todoPausedAt || Date.now()) - t.startedAt) : '');
  setInterval(() => { if (busy && lastTodos && lastTodos.some((t) => t.status === 'in_progress') && $('todo-card')) { renderTodos(lastTodos); } }, 1000);
  function renderTodos(items) {
    lastTodos = items;
    const sig = items.map((t) => `${t.content}|${t.status}`).join('\n');
    let card = $('todo-card');
    if (card && sig !== todoSig) { card.remove(); card = null; }   // list or a status changed: show it at the latest point
    todoSig = sig;
    if (!card) { clearEmpty(); card = document.createElement('div'); card.className = 'todo-card'; card.id = 'todo-card'; log.appendChild(card); cur = null; }
    const done = items.filter((t) => t.status === 'completed').length;
    const icon = (s) => (s === 'completed' ? '<span class="ti done">✓</span>' : s === 'in_progress' ? (busy ? '<span class="ti run"></span>' : '<span class="ti paused" title="The agent is not running: this step was left in progress"></span>') : '<span class="ti todo"></span>');
    const total = items.reduce((ms, t) => ms + (t.status === 'completed' && t.startedAt && t.finishedAt ? t.finishedAt - t.startedAt : 0), 0);
    card.innerHTML = `<div class="th"><b>Tasks</b><span class="muted">${done} of ${items.length} done${total ? ` · ${dur(total)}` : ''}</span><div class="tbar2"><div style="width:${items.length ? (done / items.length) * 100 : 0}%"></div></div></div>`
      + items.map((t, i) => {
        const open = openSteps.has(t.content);
        const n = t.actions.length;
        const acts = n ? t.actions.map((a) => `<div class="ta ${a.ok === undefined ? 'running' : a.ok ? 'ok' : 'fail'}"><span class="tas"></span><span class="tad">${esc(a.detail)}</span><span class="tam">${a.ok === undefined ? (a.at ? dur(Date.now() - a.at) : '') : dur(a.ms)}</span></div>`).join('') : `<div class="ta none">${t.status === 'pending' ? 'Not started yet.' : 'No tool actions recorded for this step.'}</div>`;
        const time = stepTime(t);
        return `<div class="trow ${t.status}${open ? ' open' : ''}" data-ti="${i}">
          <div class="tline" title="Click to see what ran in this step">${icon(t.status)}<span class="tt">${esc(t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content)}</span>${n ? `<span class="tc">${n} action${n === 1 ? '' : 's'}</span>` : ''}${time ? `<span class="ttime">${time}</span>` : ''}<span class="tcaret">▸</span></div>
          ${open ? `<div class="tacts">${acts}</div>` : ''}</div>`;
      }).join('');
    card.querySelectorAll('.tline').forEach((line) => {
      line.onclick = () => {
        const t = items[Number(line.parentElement.dataset.ti)];
        if (openSteps.has(t.content)) { openSteps.delete(t.content); } else { openSteps.add(t.content); }
        renderTodos(items);
      };
    });
    if (!replaying) { scroll(); }
  }

  function toolStart(m) {
    if (m.name === 'todo_write') { return; }   // represented by the task-list card
    cur = null; clearEmpty();
    const d = document.createElement('details');
    d.className = `tool running${m.name === 'agent' ? ' agent-tool' : ''}`; d.id = `t-${m.id}`;
    const stat = m.diff ? ` <span class="muted">+${m.diff.added} −${m.diff.removed}</span>` : '';
    d.innerHTML = `<summary><span class="status"></span><span class="label">${esc(m.detail || m.name)}${stat}</span></summary>${m.diff ? diffHtml(m.diff) : `<pre>${esc(m.args || '')}</pre>`}`;
    if (m.name === 'agent') { d.open = true; }
    log.appendChild(d); scroll();
  }
  function toolEnd(m) {
    const d = $(`t-${m.id}`); if (!d) { return; }
    d.classList.remove('running'); d.classList.add(m.ok ? 'ok' : 'fail');
    if (m.result) { d.insertAdjacentHTML('beforeend', `<pre class="result">${esc(m.result)}</pre>`); }
    if (d.classList.contains('agent-tool')) { d.open = false; }
  }
  function toolProgress(m) {
    const d = $(`t-${m.id}`); if (!d) { return; }
    let box = d.querySelector('.sublog');
    if (!box) { box = document.createElement('div'); box.className = 'sublog'; d.querySelector('summary').after(box); }
    const row = document.createElement('div'); row.textContent = `↳ ${m.text}`; box.appendChild(row);
    while (box.children.length > 40) { box.firstChild.remove(); }
    scroll();
  }
  function agentLink(m) {
    const d = $(`t-${m.toolId}`); if (!d || d.querySelector('.view-agent')) { return; }
    d.querySelector('summary').insertAdjacentHTML('beforeend', viewBtn(m.agentId, 'Open agent'));
  }
  function card(m, cls, title, bodyHtml, buttons) {
    cur = null;
    const d = add('', ''); d.className = `approve ${cls}`; d.id = `ap-${m.id}`;
    d.innerHTML = `<div class="q">${esc(title)}</div>${bodyHtml}<div class="actions"></div>`;
    const actions = d.querySelector('.actions');
    for (const [label, sec, msg] of buttons) {
      const b = document.createElement('button'); b.className = `btn ${sec ? 'sec' : ''}`; b.textContent = label;
      b.onclick = () => { post(msg); markDone(m.id, label.toLowerCase()); };
      actions.appendChild(b);
    }
  }
  function markDone(id, label) {
    const d = $(`ap-${id}`); if (!d || d.classList.contains('done')) { return; }
    d.querySelector('.actions')?.remove(); d.classList.add('done');
    d.querySelectorAll('input, textarea').forEach((x) => { x.disabled = true; });
    d.querySelector('.q').textContent += ` — ${label}`;
  }
  function approval(m) {
    const what = m.kind === 'edit' ? 'file change' : m.kind === 'exec' ? 'command' : m.name;
    const buttons = [['Allow', false, { type: 'approval', id: m.id, ok: true }]];
    if (m.kind === 'edit') { buttons.push(['Allow all edits', true, { type: 'approval', id: m.id, ok: true, setMode: 'auto-edit' }]); }
    buttons.push(['Deny', true, { type: 'approval', id: m.id, ok: false }]);
    const why = m.reason ? `<div class="ap-why">Asking because ${esc(m.reason)}.</div>` : '';
    card(m, '', `Allow ${what}?`, `${why}${m.diff ? diffHtml(m.diff) : `<pre>${esc(m.detail)}</pre>`}`, buttons);
  }
  function planApproval(m) {
    card(m, 'plan', 'Proposed plan', `<div class="planbody">${md(m.plan)}</div>`, [
      ['Approve & edit automatically', false, { type: 'planDecision', id: m.id, mode: 'auto-edit' }],
      ['Approve, ask before edits', true, { type: 'planDecision', id: m.id, mode: 'ask' }],
      ['Keep planning', true, { type: 'planDecision', id: m.id, mode: null }],
    ]);
    renderMermaid($(`ap-${m.id}`));
  }
  /* ---------- clarifying questions (single / multi select + "Other"), like Claude's AskUserQuestion ---------- */
  function questionCard(m) {
    cur = null;
    const qs = m.questions || [];
    const d = add('', ''); d.className = 'approve question'; d.id = `ap-${m.id}`; d.tabIndex = -1;
    const many = qs.length > 1;
    const optHtml = (q, i) => {
      const type = q.multiSelect ? 'checkbox' : 'radio';
      const name = `q-${m.id}-${i}`;
      const opts = q.options.map((o, j) => {
        const rec = /\(recommended\)\s*$/i.test(o.label);
        return `<label class="opt${rec ? ' rec' : ''}"><input type="${type}" name="${esc(name)}" value="${esc(o.label)}"><span class="okey">${j + 1}</span><span class="otxt"><b>${esc(o.label)}</b>${o.description ? `<span class="od">${esc(o.description)}</span>` : ''}</span></label>`;
      }).join('');
      return `${opts}<label class="opt other"><input type="${type}" name="${esc(name)}" value="__other"><span class="okey">${q.options.length + 1}</span><span class="otxt"><b>Other</b><input type="text" class="otext" placeholder="Type your own answer" maxlength="2000"></span></label>`;
    };
    d.innerHTML = `<div class="q">${many ? `${qs.length} questions` : 'Question'} <span class="muted">— the agent is waiting for your answer</span></div>
      ${many ? `<div class="qtabs">${qs.map((q, i) => `<button class="qtab${i === 0 ? ' active' : ''}" data-qi="${i}"><span class="qchk">✓</span>${esc(q.header)}</button>`).join('')}</div>` : ''}
      ${qs.map((q, i) => `<div class="qpanel${i === 0 ? ' active' : ''}" data-qi="${i}"><div class="qtext">${!many ? `<span class="tchip">${esc(q.header)}</span> ` : ''}${esc(q.question)}</div>${q.multiSelect ? '<div class="muted small">Select all that apply</div>' : ''}<div class="opts">${optHtml(q, i)}</div></div>`).join('')}
      <div class="actions"><button class="btn sec" data-qa="skip">Skip</button><span class="spacer"></span>${many ? '<button class="btn sec" data-qa="prev">Back</button><button class="btn sec" data-qa="next">Next</button>' : ''}<button class="btn" data-qa="submit" disabled>Submit</button></div>`;
    let cur2 = 0;
    const panels = [...d.querySelectorAll('.qpanel')];
    const answerOf = (i) => {
      const p = panels[i];
      const selected = [...p.querySelectorAll('input:checked')].map((x) => x.value).filter((v) => v !== '__other');
      const otherOn = !!p.querySelector('input[value="__other"]:checked');
      const other = otherOn ? p.querySelector('.otext').value.trim() : '';
      return { selected, other, done: selected.length > 0 || !!other };
    };
    const refresh = () => {
      panels.forEach((p, i) => p.classList.toggle('active', i === cur2));
      d.querySelectorAll('.qtab').forEach((t, i) => { t.classList.toggle('active', i === cur2); t.classList.toggle('answered', answerOf(i).done); });
      const all = panels.every((_, i) => answerOf(i).done);
      const submit = d.querySelector('[data-qa="submit"]'); if (submit) { submit.disabled = !all; }
      const prev = d.querySelector('[data-qa="prev"]'), next = d.querySelector('[data-qa="next"]');
      if (prev) { prev.disabled = cur2 === 0; } if (next) { next.disabled = cur2 === panels.length - 1; }
    };
    const go = (i) => { cur2 = Math.max(0, Math.min(panels.length - 1, i)); refresh(); };
    const finish = (answers) => {
      post({ type: 'answer', id: m.id, answers });
      const summary = answers ? qs.map((q, i) => `${q.header}: ${[...(answers[i]?.selected || []), ...(answers[i]?.other ? [`“${answers[i].other}”`] : [])].join(', ') || '—'}`).join(' · ') : 'skipped';
      markDone(m.id, answers ? `answered — ${summary}` : 'skipped');
      input.focus();
    };
    d.addEventListener('change', (e) => {
      const t = e.target;
      if (t.value === '__other' && t.checked) { t.closest('.opt').querySelector('.otext').focus(); }
      refresh();
    });
    d.addEventListener('input', (e) => {
      if (!e.target.classList.contains('otext')) { return; }
      const box = e.target.closest('.opt').querySelector('input[value="__other"]');
      if (e.target.value.trim() && !box.checked) { box.checked = true; }
      refresh();
    });
    d.addEventListener('click', (e) => {
      const tab = e.target.closest('.qtab'); if (tab) { go(Number(tab.dataset.qi)); return; }
      const a = e.target.closest('[data-qa]')?.dataset.qa;
      if (a === 'prev') { go(cur2 - 1); } else if (a === 'next') { go(cur2 + 1); }
      else if (a === 'skip') { finish(null); }
      else if (a === 'submit') {
        const answers = {};
        panels.forEach((_, i) => { const x = answerOf(i); answers[i] = { selected: x.selected, ...(x.other ? { other: x.other } : {}) }; });
        finish(answers);
      }
    });
    d.addEventListener('keydown', (e) => {
      if (d.classList.contains('done') || e.target.classList.contains('otext')) { if (e.key === 'Enter' && e.target.classList.contains('otext')) { e.preventDefault(); d.focus(); } return; }
      const n = Number(e.key);
      const boxes = [...panels[cur2].querySelectorAll('.opts > .opt > input')];
      if (n >= 1 && n <= boxes.length) { e.preventDefault(); const b = boxes[n - 1]; b.checked = b.type === 'checkbox' ? !b.checked : true; b.dispatchEvent(new Event('change', { bubbles: true })); return; }
      if (e.key === 'ArrowRight') { go(cur2 + 1); } else if (e.key === 'ArrowLeft') { go(cur2 - 1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (answerOf(cur2).done && cur2 < panels.length - 1) { go(cur2 + 1); } else { d.querySelector('[data-qa="submit"]:not([disabled])')?.click(); }
      }
    });
    refresh();
    if (!replaying) { setTimeout(() => d.focus(), 0); }
    scroll();
  }

  function rewound(m) {
    const target = log.querySelector(`.msg.user[data-turn="${m.turn}"]`);
    if (target) {
      input.value = target.dataset.raw || ''; autosize();
      let n = target; while (n) { const next = n.nextElementSibling; n.remove(); n = next; }
    }
    add('info', esc(m.note || `Rewound to before this message. ${m.files} file${m.files === 1 ? '' : 's'} restored.`));
    cur = null; input.focus();
  }
  function info(m) { const d = add(m.error ? 'info error' : 'info', autolink(m.text)); if (m.agentId) { d.insertAdjacentHTML('beforeend', ` ${viewBtn(m.agentId)}`); } cur = null; }

  /** Applies one transcript event; used for live events and for replays alike. */
  function apply(m) {
    switch (m.type) {
      case 'userMsg': userMsg(m); break;
      case 'token': assistantToken(m.text); break;
      case 'assistantText': assistantText(m.text); break;
      case 'toolStart': toolStart(m); break;
      case 'toolEnd': toolEnd(m); break;
      case 'toolProgress': toolProgress(m); break;
      case 'agentLink': agentLink(m); break;
      case 'approve': approval(m); break;
      case 'planApprove': planApproval(m); break;
      case 'question': questionCard(m); break;
      case 'todos': renderTodos(m.items || []); break;
      case 'approvalDone': markDone(m.id, m.label); break;
      case 'info': info(m); break;
      case 'rewound': rewound(m); break;
      case 'start': setBusy(true); cur = null; break;
      case 'end': if (cur) { markBookmark(cur); } setBusy(false); cur = null; break;
      case 'usage': setUsage(m.used, m.limit); break;
    }
  }

  log.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-href]');
    if (a) { e.preventDefault(); post({ type: 'openLink', url: a.dataset.href }); return; }
    const t = e.target.closest('button');
    if (!t) { return; }
    if (t.dataset.view) { e.preventDefault(); post({ type: 'viewAgent', id: t.dataset.view }); return; }
    if (t.dataset.opendiff) { e.preventDefault(); post({ type: 'openDiff', id: t.dataset.opendiff }); return; }
    if (t.hasAttribute('data-copy')) { const block = t.closest('.codeblock, .mermaid-block'); copyText(block.getAttribute('data-src') ?? block.querySelector('code').textContent, t); return; }
    if (t.dataset.copyTable) {
      const wrap = t.closest('.tablewrap');
      if (t.dataset.copyTable === 'md') { copyText(wrap.getAttribute('data-src'), t); return; }
      const rows = [...wrap.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join('\t'));
      copyText(rows.join('\n'), t); return;
    }
    const reply = t.closest('.msg.assistant');
    if (reply && t.classList.contains('copy')) { copyText(reply.dataset.raw || '', t); return; }
    if (reply && t.classList.contains('bm')) {
      if (reply === cur && busy) { add('info', 'Wait for this reply to finish before bookmarking it.'); return; }
      const key = replyKey(reply), on = !bookmarks.has(key);
      if (on) { bookmarks.add(key); } else { bookmarks.delete(key); }
      markBookmark(reply);
      post({ type: 'bookmark', turn: Number(reply.dataset.turn), hash: key.split(':')[1], preview: (reply.dataset.raw || '').replace(/\s+/g, ' ').slice(0, 140), on });
    }
  });

  /* ================================================================ header: agents, bookmarks, context */
  function renderAgents() {
    const me = agents.find((a) => a.id === state.agentId);
    const subs = agents.filter((a) => a.role === 'sub');
    const working = subs.filter((a) => BUSY.includes(a.status)).length;
    const waiting = subs.some((a) => a.status === 'waiting' && a.id !== state.agentId);
    const btn = $('agentBtn');
    btn.className = `agent-btn st-${me ? me.status : 'idle'}${waiting ? ' attn' : ''}`;
    $('agentName').textContent = state.viewingSub && me ? (me.description || me.name) : 'Main';
    const count = $('agentCount');
    count.textContent = subs.length ? (working ? `${working}/${subs.length}` : String(subs.length)) : '';
    count.style.display = subs.length ? '' : 'none';
    count.className = `badge${working ? ' live' : ''}`;
    btn.title = `${subs.length} sub-agent${subs.length === 1 ? '' : 's'} in this session${working ? ` · ${working} working` : ''}${waiting ? ' · one needs your approval' : ''}`;
    const line = $('activity');
    const show = me && me.status !== 'idle';
    line.className = show ? `show st-${me.status}` : '';
    line.textContent = show ? `${STATUS_LABEL[me.status]}${me.activity ? ` · ${me.activity}` : ''}${me.startedAt ? ` · ${since(me.startedAt)}` : ''}` : '';
    renderSubBanner(me);
    if (me) { setBusy(BUSY.includes(me.status)); }
    if (openMenu && openMenu.classList.contains('agent-menu')) { agentMenu(true); }
    if ($('agentMap')) { renderAgentMap(); }
  }
  setInterval(() => { if (agents.some((a) => a.startedAt)) { renderAgents(); } }, 1000);

  function renderSubBanner(me) {
    const b = $('subBanner');
    const sub = state.viewingSub && me;
    composer.style.display = sub ? 'none' : '';
    b.className = sub ? 'show' : '';
    if (!sub) { b.innerHTML = ''; return; }
    const st = BUSY.includes(me.status) ? STATUS_LABEL[me.status] : (OUTCOME_LABEL[me.outcome] || STATUS_LABEL[me.status]);
    b.innerHTML = `<div class="sb-row"><span class="tchip">${esc(me.type || 'agent')}</span><b>${esc(me.description || me.name)}</b><span class="muted">· ${esc(st)}${me.background ? ' · background' : ''}</span><span class="spacer"></span>
      ${BUSY.includes(me.status) ? '<button class="btn sec" id="sbStop">■ Stop</button>' : ''}<button class="btn" id="sbBack">← Back to Main</button></div>
      <div class="muted small">Sub-agents work for the main conversation. You can watch and stop it here; to steer it, ask the main agent (it can use <code>send_message</code>).</div>`;
    $('sbBack').onclick = () => post({ type: 'backToMain' });
    const st2 = $('sbStop'); if (st2) { st2.onclick = () => post({ type: 'stop' }); }
  }

  function agentMenu(refresh) {
    if (!refresh) { closeMenu(); } else { openMenu?.remove(); }
    const m = document.createElement('div'); m.className = 'menu agent-menu'; m.setAttribute('role', 'menu');
    const main = agents.find((a) => a.role !== 'sub');
    const subs = agents.filter((a) => a.role === 'sub').sort((a, b) => (BUSY.includes(b.status) - BUSY.includes(a.status)) || b.updatedAt - a.updatedAt);
    const row = (a, isMain) => {
      const r = document.createElement('div');
      r.className = `item agent-row st-${a.status}${a.id === state.agentId ? ' active' : ''}`;
      const st = BUSY.includes(a.status) ? `${STATUS_LABEL[a.status]}${a.activity ? ` · ${a.activity}` : ''}${a.startedAt ? ` · ${since(a.startedAt)}` : ''}` : (OUTCOME_LABEL[a.outcome] || STATUS_LABEL[a.status]);
      r.innerHTML = `<span class="dot"></span><span class="ai"><b>${isMain ? 'Main conversation' : esc(a.description || a.name)}</b><span class="d">${isMain ? '' : `<span class="tchip">${esc(a.type || 'agent')}</span> `}${esc(st)}</span></span>`
        + `<span class="ra">${!isMain && BUSY.includes(a.status) ? '<button class="icon-btn" data-act="stop" title="Stop">■</button>' : ''}${!isMain && !BUSY.includes(a.status) ? '<button class="icon-btn" data-act="remove" title="Remove">×</button>' : ''}</span>`;
      r.onmousedown = (ev) => {
        ev.preventDefault();
        const act = ev.target.closest('[data-act]')?.dataset.act;
        if (act === 'stop') { post({ type: 'stopAgent', id: a.id }); return; }
        closeMenu();
        if (act === 'remove') { post({ type: 'removeAgent', id: a.id }); return; }
        if (a.id !== state.agentId) { post({ type: isMain ? 'backToMain' : 'viewAgent', id: a.id }); }
      };
      m.appendChild(r);
    };
    if (main) { row(main, true); }
    m.insertAdjacentHTML('beforeend', `<div class="mhead">Sub-agents${subs.length ? ` (${subs.length})` : ''}</div>`);
    if (!subs.length) { m.insertAdjacentHTML('beforeend', '<div class="mempty">None yet. The main agent starts them when a task benefits from delegation, or start one yourself.</div>'); }
    subs.forEach((a) => row(a, false));
    m.insertAdjacentHTML('beforeend', '<div class="sep"></div>');
    const mapItem = document.createElement('div'); mapItem.className = 'item';
    mapItem.innerHTML = '<div class="row"><span>Agent map</span></div><span class="d">Every agent with its status, time and tokens, live</span>';
    mapItem.onmousedown = (ev) => { ev.preventDefault(); closeMenu(); openAgentMap(); };
    m.appendChild(mapItem);
    const run = document.createElement('div'); run.className = 'item';
    run.innerHTML = '<div class="row"><span>＋ Run an agent…</span></div><span class="d">Start a sub-agent in the background; its report comes back to Main</span>';
    run.onmousedown = (ev) => { ev.preventDefault(); closeMenu(); openLauncher(); };
    m.appendChild(run);
    placeBelow(m, $('agentBtn'));
  }
  $('agentBtn').onclick = () => { if (openMenu?.classList.contains('agent-menu')) { closeMenu(); } else { agentMenu(); } };

  /* ---------- agent map: the main conversation and its sub-agents, with live status, time and tokens ---------- */
  const fmtTokens = (n) => { n = Math.max(0, Math.round(n || 0)); return n < 1000 ? `${n}` : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`; };
  const fmtDur = (ms) => {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    if (s < 60) { return `${s}s`; }
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
  };
  /** Total running time: finished runs plus the run in progress. */
  const elapsedOf = (a) => (a.runMs || 0) + (a.startedAt ? Math.max(0, Date.now() - a.startedAt) : 0);
  const mapStatus = (a) => (BUSY.includes(a.status) ? STATUS_LABEL[a.status] : (OUTCOME_LABEL[a.outcome] || STATUS_LABEL[a.status] || a.status));
  /** The dot colour: a finished sub-agent shows its outcome, everything else its live status. */
  const mapState = (a) => (BUSY.includes(a.status) ? a.status : a.outcome === 'completed' ? 'done' : a.outcome === 'failed' ? 'error' : a.outcome === 'cancelled' ? 'stopped' : a.status);
  /** Sub-agents in launch order (a1, a2, … a10). */
  const byLaunch = (a, b) => (Number(String(a.id).replace(/\D/g, '')) - Number(String(b.id).replace(/\D/g, ''))) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  function mapNode(a, isMain) {
    const busyNow = BUSY.includes(a.status);
    const title = isMain ? 'Main conversation' : (a.description || a.name);
    const meta = [isMain ? a.model : a.type, fmtDur(elapsedOf(a)), `${fmtTokens(a.tokens)} tokens`].filter(Boolean).map(esc).join(' · ');
    const line = busyNow ? `${mapStatus(a)}${a.activity ? ` · ${a.activity}` : ''}` : `${mapStatus(a)}${a.error ? `: ${a.error}` : ''}`;
    const tip = isMain ? 'Open the main conversation' : `Open this agent: ${a.description || a.name}`;
    return `<div class="am-node st-${esc(mapState(a))}${a.id === state.agentId ? ' active' : ''}" data-am="${esc(a.id)}" data-main="${isMain ? 1 : 0}" role="button" tabindex="0" title="${esc(tip)}">
      <div class="am-top"><span class="dot"></span><b class="am-title">${esc(title)}</b>${!isMain && busyNow ? '<button class="icon-btn am-stop" data-amstop="1" title="Stop this agent">■</button>' : ''}</div>
      <div class="am-meta">${meta}</div>
      <div class="am-line" title="${esc(line)}">${esc(line)}</div></div>`;
  }

  function renderAgentMap() {
    const body = $('amBody'); if (!body) { return; }
    const main = agents.find((a) => a.role !== 'sub');
    const subs = agents.filter((a) => a.role === 'sub').sort(byLaunch);
    const count = (pred) => subs.filter(pred).length;
    const running = count((a) => a.status === 'running' || a.status === 'waiting');
    const queued = count((a) => a.status === 'queued');
    const done = count((a) => !BUSY.includes(a.status) && a.outcome === 'completed');
    const failed = count((a) => !BUSY.includes(a.status) && a.outcome !== 'completed' && a.outcome !== 'cancelled' && (a.outcome === 'failed' || a.status === 'error'));
    const stopped = count((a) => !BUSY.includes(a.status) && a.outcome === 'cancelled');
    const total = agents.reduce((n, a) => n + (a.tokens || 0), 0);
    const parts = [`${subs.length} sub-agent${subs.length === 1 ? '' : 's'}`, running && `${running} running`, queued && `${queued} queued`,
      done && `${done} done`, failed && `${failed} failed`, stopped && `${stopped} stopped`, `${fmtTokens(total)} tokens in total`].filter(Boolean);
    $('amSummary').textContent = parts.join(' · ');
    const pct = subs.length ? Math.round(((done + failed + stopped) / subs.length) * 100) : 0;
    $('amProgress').style.width = `${pct}%`;
    $('amBar').hidden = !subs.length;
    $('amBar').title = `${done + failed + stopped} of ${subs.length} finished`;
    const old = $('amKids'); const keep = old ? old.scrollTop : 0;
    body.innerHTML = `<div class="am-root">${main ? mapNode(main, true) : ''}</div>
      <div class="am-kids${subs.length ? '' : ' empty'}" id="amKids">${subs.length
        ? subs.map((a) => `<div class="am-kid">${mapNode(a, false)}</div>`).join('')
        : '<div class="mempty">No sub-agents yet. Give the main agent several independent tasks (for example a numbered list) and it runs one agent per task in parallel.</div>'}</div>`;
    $('amKids').scrollTop = keep;
  }

  function openAgentMap() {
    $('agentMap')?.remove();
    const l = document.createElement('div'); l.className = 'modal'; l.id = 'agentMap';
    l.innerHTML = `<div class="mcard amap" role="dialog" aria-modal="true" aria-label="Agent map"><div class="mtitle">Agent map<button class="icon-btn" id="amClose" title="Close (Esc)">✕</button></div>
      <div class="am-sum"><span class="muted small" id="amSummary"></span><div class="am-bar" id="amBar" hidden><div id="amProgress"></div></div></div>
      <div class="am-body" id="amBody"></div></div>`;
    document.body.appendChild(l);
    const close = () => l.remove();
    $('amClose').onclick = close;
    l.addEventListener('mousedown', (e) => { if (e.target === l) { close(); } });
    l.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); return; }
      if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.am) { e.preventDefault(); e.target.click(); }
    });
    l.addEventListener('click', (e) => {
      const node = e.target.closest('[data-am]'); if (!node) { return; }
      const id = node.dataset.am;
      if (e.target.closest('[data-amstop]')) { post({ type: 'stopAgent', id }); return; }
      close();
      if (id !== state.agentId) { post({ type: node.dataset.main === '1' ? 'backToMain' : 'viewAgent', id }); }
    });
    renderAgentMap();
    $('amClose').focus();
  }
  $('mapBtn').onclick = openAgentMap;
  // Keeps elapsed times ticking while the map is open, even when nothing else changes.
  setInterval(() => { if ($('agentMap') && agents.some((a) => a.startedAt)) { renderAgentMap(); } }, 1000);

  function openLauncher() {
    $('launcher')?.remove();
    const types = state.agentTypes || [];
    const l = document.createElement('div'); l.className = 'modal'; l.id = 'launcher';
    l.innerHTML = `<div class="mcard"><div class="mtitle">Run an agent<button class="icon-btn" id="lClose">✕</button></div>
      <label>Type</label><select id="lType">${types.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}${t.readOnly ? ' (read-only)' : ''}${t.source !== 'builtin' ? ` · ${esc(t.source)}` : ''}</option>`).join('')}</select>
      <div class="muted small" id="lDesc"></div>
      <label>Task</label><textarea id="lTask" rows="5" placeholder="Describe the task completely: the agent starts with an empty context (except “fork”)."></textarea>
      <div class="muted small">Runs in the background. When it finishes, its report is delivered to the main conversation, which continues automatically.</div>
      <div class="actions"><button class="btn sec" id="lCancel">Cancel</button><button class="btn" id="lRun">Run agent</button></div></div>`;
    document.body.appendChild(l);
    const desc = () => { const t = types.find((x) => x.name === $('lType').value); $('lDesc').textContent = t ? t.description : ''; };
    $('lType').onchange = desc; desc();
    const close = () => { l.remove(); input.focus(); };
    $('lClose').onclick = close; $('lCancel').onclick = close;
    l.addEventListener('mousedown', (e) => { if (e.target === l) { close(); } });
    l.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); } if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { $('lRun').click(); } });
    $('lRun').onclick = () => {
      const prompt = $('lTask').value.trim();
      if (!prompt) { $('lTask').focus(); return; }
      post({ type: 'spawnAgent', agentType: $('lType').value, prompt }); close();
    };
    $('lTask').focus();
  }

  /* ---------- skills manager (Claude-compatible SKILL.md) ---------- */
  let skillsData = { items: [], errors: [], template: '' }, skillFilter = 'all', skillQuery = '', skillView = 'list', editDetail = null;
  function onSkillDetail(d) {
    // Adding a supporting file refreshes the detail: update only the file list so unsaved form edits survive.
    if (skillView === 'edit' && editDetail && editDetail.name === d.name && $('sfName')) {
      editDetail.files = d.files;
      const box = document.querySelector('.sf-files');
      if (box) { box.querySelectorAll('.tchip, .muted').forEach((x) => x.remove()); box.insertAdjacentHTML('afterbegin', d.files.length ? d.files.map((f) => `<span class="tchip alt">${esc(f)}</span> `).join('') : ''); }
      if ($('sfNewFile')) { $('sfNewFile').hidden = true; $('sfFilePath').value = ''; $('sfFileBody').value = ''; }
      return;
    }
    editDetail = d; skillView = 'edit';
    if (!$('skillsModal')) { openSkills('edit'); } else { renderSkills(); }
  }
  const TOOL_CHOICES = [['read_file', 'Read files'], ['grep', 'Search'], ['glob_files', 'Find files'], ['edit_file', 'Edit files'], ['write_file', 'Create files'], ['run_command', 'Run commands']];
  function openSkills(view) {
    skillView = view || 'list';
    if (!$('skillsModal')) {
      const l = document.createElement('div'); l.className = 'modal'; l.id = 'skillsModal';
      l.innerHTML = '<div class="mcard wide skills"><div id="skBody"></div></div>';
      document.body.appendChild(l);
      l.addEventListener('mousedown', (e) => { if (e.target === l) { closeSkills(); } });
      l.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (skillView === 'list') { closeSkills(); } else { skillView = 'list'; renderSkills(); } } });
    }
    renderSkills();
    post({ type: 'listSkills' });
  }
  function closeSkills() { $('skillsModal')?.remove(); input.focus(); }
  function renderSkills() {
    const body = $('skBody'); if (!body) { return; }
    if (skillView === 'new') { renderSkillForm(body); return; }
    if (skillView === 'edit' && editDetail) { renderSkillForm(body, editDetail); return; }
    if (skillView === 'ai') { renderSkillAi(body); return; }
    const q = skillQuery.toLowerCase();
    const items = skillsData.items.filter((s) => (skillFilter === 'all' || (skillFilter === 'project' ? s.source === 'project' : s.source === 'user'))
      && (!q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)));
    const count = (f) => skillsData.items.filter((s) => f === 'all' || (f === 'project' ? s.source === 'project' : s.source === 'user')).length;
    body.innerHTML = `<div class="mtitle sk-head"><span class="sk-title">Skills</span><span class="sk-count">${skillsData.items.length}</span>
        <span class="info" tabindex="0" role="button" aria-label="About skills" aria-describedby="skInfoTip"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.2v4.3" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".8" fill="currentColor" stroke="none"/></svg>
          <span class="tip" role="tooltip" id="skInfoTip">Reusable instructions for recurring tasks. Run one with <code>/name</code>, or let the agent pick it automatically when your request matches its description. Compatible with Claude Code (<code>.claude/skills/&lt;name&gt;/SKILL.md</code>).</span></span>
        <span class="spacer"></span><button class="icon-btn" id="skClose" title="Close (Esc)">✕</button></div>
      <div class="sk-tools"><input id="skSearch" type="search" placeholder="Search skills" value="${esc(skillQuery)}">
        ${['all', 'project', 'personal'].map((f) => `<button class="seg${skillFilter === f ? ' active' : ''}" data-skf="${f}">${f[0].toUpperCase() + f.slice(1)} · ${count(f)}</button>`).join('')}
        <span class="spacer"></span><button class="btn sec" id="skAi">Create with AI</button><button class="btn" id="skNew">＋ New skill</button></div>
      <div class="sk-list">${items.length ? items.map((s) => `
        <div class="sk-row" data-name="${esc(s.name)}">
          <div class="sk-main">
            <div class="sk-name"><b>/${esc(s.name)}</b>${s.argumentHint ? `<span class="muted"> ${esc(s.argumentHint)}</span>` : ''}
              <span class="tchip">${s.source === 'user' ? 'personal' : 'project'}</span>${s.kind === 'command' ? '<span class="tchip alt">command</span>' : ''}${s.userInvocable ? '' : '<span class="tchip alt">agent only</span>'}</div>
            <div class="sk-desc">${esc(s.description)}</div>
            <div class="sk-meta muted small">${esc(s.path)}${s.files ? ` · ${s.files} supporting file${s.files === 1 ? '' : 's'}` : ''}${s.allowedTools.length ? ` · tools: ${esc(s.allowedTools.join(', '))}` : ''}</div>
          </div>
          <div class="sk-side">
            <label class="switch${s.kind === 'command' ? ' disabled' : ''}" title="${s.kind === 'command' ? 'Legacy commands can only be run with /name' : 'Let the agent load this skill by itself when a request matches'}"><input type="checkbox" data-sk="toggle"${s.modelInvocable ? ' checked' : ''}${s.kind === 'command' ? ' disabled' : ''}><span class="slider"></span><span class="sl">Auto</span></label>
            <div class="sk-acts">${s.userInvocable ? '<button class="icon-btn" data-sk="test" title="Test it now in this session">▶ Test</button><button class="icon-btn" data-sk="run" title="Put /name in the input">/ Use</button>' : ''}${s.kind === 'skill' ? '<button class="icon-btn" data-sk="form" title="Edit in the form">✎ Edit</button>' : ''}<button class="icon-btn" data-sk="file" title="Open SKILL.md">📝</button><button class="icon-btn" data-sk="copy" title="${s.source === 'user' ? 'Copy to the project (share with the team)' : 'Copy to my personal skills'}">⧉</button><button class="icon-btn" data-sk="reveal" title="Show in folder">📂</button><button class="icon-btn" data-sk="delete" title="Delete">🗑</button></div>
          </div>
          ${s.issues ? `<div class="sk-issues" title="Open ✎ Edit to see the checks">⚠ ${s.issues} issue${s.issues === 1 ? '' : 's'} may stop the agent from using this skill — open ✎ Edit to see them</div>` : ''}
          <div class="sk-test" hidden><input class="sk-args" placeholder="${esc(s.argumentHint || 'arguments (optional)')}"><button class="btn" data-sk="go">Run test</button><button class="btn sec" data-sk="cancel">Cancel</button></div>
        </div>`).join('') : `<div class="sk-empty">${skillsData.items.length ? 'No skills match.' : 'No skills yet. Create one with “New skill”, or describe what you want and use “Create with AI”.'}</div>`}</div>
      ${skillsData.errors.length ? `<details class="sk-errors"><summary>${skillsData.errors.length} skill file${skillsData.errors.length === 1 ? '' : 's'} could not be loaded</summary>${skillsData.errors.map((e) => `<div>${esc(e)}</div>`).join('')}</details>` : ''}`;
    $('skClose').onclick = closeSkills;
    $('skNew').onclick = () => { skillView = 'new'; renderSkills(); };
    $('skAi').onclick = () => { skillView = 'ai'; renderSkills(); };
    const search = $('skSearch');
    search.oninput = () => { skillQuery = search.value; const pos = search.selectionStart; renderSkills(); const s2 = $('skSearch'); s2.focus(); s2.setSelectionRange(pos, pos); };
    body.querySelectorAll('[data-skf]').forEach((b) => (b.onclick = () => { skillFilter = b.dataset.skf; renderSkills(); }));
    body.querySelectorAll('.sk-row').forEach((row) => {
      const name = row.dataset.name;
      row.querySelector('[data-sk="toggle"]')?.addEventListener('change', (e) => post({ type: 'toggleSkill', name, enabled: e.target.checked }));
      const test = row.querySelector('.sk-test'), args = row.querySelector('.sk-args');
      const runTest = () => { post({ type: 'testSkill', name, args: args.value.trim() }); closeSkills(); };
      args.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runTest(); } else if (e.key === 'Escape') { e.stopPropagation(); test.hidden = true; } });
      row.querySelectorAll('button[data-sk]').forEach((b) => (b.onclick = () => {
        const a = b.dataset.sk;
        const s = skillsData.items.find((x) => x.name === name);
        if (a === 'run') { closeSkills(); input.value = `/${name} `; autosize(); input.focus(); return; }
        if (a === 'test') { test.hidden = !test.hidden; if (!test.hidden) { args.focus(); } return; }
        if (a === 'go') { runTest(); return; }
        if (a === 'cancel') { test.hidden = true; return; }
        if (a === 'form') { post({ type: 'getSkill', name }); return; }
        if (a === 'copy') { post({ type: 'copySkill', name, scope: s && s.source === 'user' ? 'project' : 'personal' }); return; }
        post({ type: { file: 'editSkill', reveal: 'revealSkill', delete: 'deleteSkill' }[a], name });
      }));
    });
    if (skillView === 'list' && !document.activeElement?.closest('#skillsModal')) { $('skSearch').focus(); }
  }
  function renderSkillForm(body, detail) {
    const editing = !!detail;
    body.innerHTML = `<div class="mtitle">${editing ? `Edit /${esc(detail.name)} <span class="muted small">${esc(detail.path)}</span>` : 'New skill'}<button class="icon-btn" id="skBack" title="Back (Esc)">←</button></div>
      <div class="sk-form">
        <label>Name</label><input id="sfName" placeholder="release-notes" maxlength="64" autocomplete="off">
        <div class="muted small" id="sfPath">Lowercase letters, digits and hyphens. You will run it as /name.</div>
        <label>Description <span class="muted">— what it does and when to use it (this is how the agent picks it)</span></label>
        <textarea id="sfDesc" rows="2" placeholder="Write release notes from the git history. Use when the user asks for a changelog or release notes."></textarea>
        <label>Instructions <span class="muted">— the steps the agent follows; use $ARGUMENTS for what is typed after /name</span></label>
        <textarea id="sfBody" rows="10" spellcheck="false"></textarea>
        <div class="sf-grid">
          <div><label>Argument hint <span class="muted">(optional)</span></label><input id="sfHint" placeholder="[from-tag] [to-tag]"></div>
          <div${editing ? ' hidden' : ''}><label>Where</label><div class="sf-radio"><label><input type="radio" name="sfScope" value="project" checked> Project <span class="muted">— .claude/skills, shared with the team via git</span></label><label><input type="radio" name="sfScope" value="personal"> Personal <span class="muted">— ~/.claude/skills, only you</span></label></div></div>
        </div>
        <label>Options</label>
        <div class="sf-checks"><label><input type="checkbox" id="sfUser" checked> Show as a /command</label><label><input type="checkbox" id="sfModel" checked> Let the agent use it automatically</label></div>
        <label>Tools it needs <span class="muted">(optional, documented in allowed-tools)</span></label>
        <div class="sf-checks">${TOOL_CHOICES.map(([v, l]) => `<label><input type="checkbox" class="sfTool" value="${v}"> ${l}</label>`).join('')}</div>
        <div id="sfLint" class="sf-lint"></div>
        ${editing ? `<label>Supporting files <span class="muted">— templates, scripts or reference docs the instructions can point to</span></label>
        <div class="sf-files">${detail.files.length ? detail.files.map((f) => `<span class="tchip alt">${esc(f)}</span>`).join(' ') : '<span class="muted small">None yet.</span>'}
          <button class="link" id="sfAddFile">＋ Add file</button></div>
        <div id="sfNewFile" hidden class="sf-newfile"><input id="sfFilePath" placeholder="templates/notes.md"><textarea id="sfFileBody" rows="5" spellcheck="false" placeholder="File content"></textarea>
          <div class="err small" id="sfFileErr"></div><div class="actions"><span class="spacer"></span><button class="btn sec" id="sfFileCancel">Cancel</button><button class="btn" id="sfFileSave">Add file</button></div></div>` : ''}
        <div class="err" id="sfErr"></div>
      </div>
      <div class="actions"><span class="spacer"></span><button class="btn sec" id="sfCancel">Cancel</button><button class="btn" id="sfCreate" disabled>${editing ? 'Save changes' : 'Create &amp; open'}</button></div>`;
    $('sfBody').value = editing ? detail.instructions : (skillsData.template || '');
    if (editing) {
      $('sfName').value = detail.name; $('sfDesc').value = detail.description; $('sfHint').value = detail.argumentHint || '';
      $('sfUser').checked = detail.userInvocable; $('sfModel').checked = detail.modelInvocable;
      body.querySelectorAll('.sfTool').forEach((x) => { x.checked = detail.allowedTools.includes(x.value); });
    }
    const draft = () => ({
      name: $('sfName').value.trim(), description: $('sfDesc').value.trim(), instructions: $('sfBody').value,
      argumentHint: $('sfHint').value.trim(), userInvocable: $('sfUser').checked, modelInvocable: $('sfModel').checked,
      allowedTools: [...body.querySelectorAll('.sfTool:checked')].map((x) => x.value),
    });
    let lintTimer, lintReq = 0, hasErrors = true;
    const validate = () => {
      const n = $('sfName').value.trim();
      const scope = body.querySelector('input[name="sfScope"]:checked').value;
      const nameOk = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(n);
      $('sfPath').textContent = !n ? 'Lowercase letters, digits and hyphens. You will run it as /name.' : !nameOk ? 'Use lowercase letters, digits and hyphens only (e.g. release-notes).'
        : editing ? (n !== detail.name ? `Renames the skill (and its folder) to /${n}` : `Run it as /${n}`) : `Creates ${scope === 'personal' ? '~/.claude' : '.claude'}/skills/${n}/SKILL.md · run it as /${n}`;
      $('sfPath').className = `small ${n && !nameOk ? 'err' : 'muted'}`;
      clearTimeout(lintTimer);
      lintTimer = setTimeout(() => post({ type: 'lintSkill', req: ++lintReq, skill: draft(), originalName: editing ? detail.name : undefined }), 250);
    };
    window.__skillLint = (m) => {
      if (m.req !== lintReq || !$('sfLint')) { return; }
      hasErrors = m.issues.some((x) => x.level === 'error');
      const icon = { error: '✕', warning: '⚠', tip: '💡' };
      $('sfLint').innerHTML = m.issues.length ? m.issues.map((x) => `<div class="li ${x.level}"><span>${icon[x.level]}</span>${esc(x.message)}</div>`).join('') : '<div class="li ok"><span>✓</span>Looks good — the agent has what it needs to pick and follow this skill.</div>';
      $('sfCreate').disabled = hasErrors;
    };
    body.addEventListener('input', validate); body.addEventListener('change', validate); validate();
    $('sfName').addEventListener('input', () => { const v = $('sfName').value; const fixed = v.toLowerCase().replace(/\s+/g, '-'); if (v !== fixed) { $('sfName').value = fixed; } });
    $('skBack').onclick = $('sfCancel').onclick = () => { skillView = 'list'; editDetail = null; renderSkills(); };
    $('sfCreate').onclick = () => {
      if (hasErrors) { return; }
      $('sfCreate').disabled = true; $('sfErr').textContent = '';
      if (editing) { post({ type: 'updateSkill', originalName: detail.name, skill: draft() }); }
      else { post({ type: 'createSkill', scope: body.querySelector('input[name="sfScope"]:checked').value, skill: draft() }); }
    };
    if (editing) {
      $('sfAddFile').onclick = () => { $('sfNewFile').hidden = false; $('sfFilePath').focus(); };
      $('sfFileCancel').onclick = () => { $('sfNewFile').hidden = true; };
      $('sfFileSave').onclick = () => { $('sfFileErr').textContent = ''; post({ type: 'addSkillFile', name: detail.name, path: $('sfFilePath').value.trim(), content: $('sfFileBody').value }); };
    }
    (editing ? $('sfDesc') : $('sfName')).focus();
  }
  function renderSkillAi(body) {
    const examples = ['Review my uncommitted changes against our CLAUDE.md rules and list violations', 'Generate release notes from git log between two tags', 'Scaffold a new Django controller + view following this repo\'s patterns', 'Write regression test cases (Gherkin) for a feature I describe'];
    body.innerHTML = `<div class="mtitle">Create a skill with AI<button class="icon-btn" id="skBack" title="Back (Esc)">←</button></div>
      <div class="muted small">Describe what the skill should do. The agent looks at your code, asks you questions if something is unclear, then writes <code>.claude/skills/&lt;name&gt;/SKILL.md</code>. You can review and edit it afterwards.</div>
      <textarea id="saDesc" rows="5" placeholder="e.g. Check a PR branch for missing i18n keys in en.json, ar.json and hi.json and list what is missing"></textarea>
      <div class="sa-ex">${examples.map((e) => `<button class="chip small" data-ex="${esc(e)}">${esc(e)}</button>`).join('')}</div>
      <div class="actions"><span class="spacer"></span><button class="btn sec" id="saCancel">Cancel</button><button class="btn" id="saGo" disabled>Create with AI</button></div>`;
    const d = $('saDesc');
    d.oninput = () => { $('saGo').disabled = d.value.trim().length < 10; };
    body.querySelectorAll('[data-ex]').forEach((b) => (b.onclick = () => { d.value = b.dataset.ex; d.oninput(); d.focus(); }));
    $('skBack').onclick = $('saCancel').onclick = () => { skillView = 'list'; renderSkills(); };
    $('saGo').onclick = () => { post({ type: 'aiCreateSkill', description: d.value.trim() }); closeSkills(); };
    d.focus();
  }
  $('skillsPill').onclick = () => openSkills();

  /* ---------- changed-files review ---------- */
  let changesData = { files: [], worktrees: [] };
  const STATUS_MARK = { added: 'A', modified: 'M', deleted: 'D' };
  function renderChanges() {
    const body = $('chBody'); if (!body) { return; }
    const { files, worktrees } = changesData;
    const fileRows = files.map((f) => `<div class="ch-row" data-rel="${esc(f.rel)}"><span class="ch-st ${esc(f.status)}" title="${esc(f.status)}">${STATUS_MARK[f.status] || '?'}</span>
        <span class="ch-path" title="${esc(f.rel)}">${esc(f.rel)}</span>${f.conflict ? '<span class="tchip alt" title="Several agents edited this file at the same time">conflict risk</span>' : ''}
        <span class="muted small">${esc(f.agents.join(', '))}</span>${f.binary ? '<span class="muted small">binary</span>' : `<span class="add">+${f.added}</span><span class="del">−${f.removed}</span>`}
        <span class="ch-acts">${f.binary ? '' : '<button class="icon-btn" data-ch="diff">Diff</button>'}<button class="icon-btn" data-ch="accept">Accept</button><button class="icon-btn" data-ch="revert">Revert</button></span></div>`).join('');
    const wtRows = worktrees.map((w) => `<div class="ch-row" data-agent="${esc(w.agentId)}"><span class="ch-path" title="${esc(w.branch)}"><b>${esc(w.name)}</b> <span class="muted small">${esc(w.branch)}</span></span>
        <span class="muted small">${w.files} file${w.files === 1 ? '' : 's'}</span><span class="add">+${w.added}</span><span class="del">−${w.removed}</span>
        <span class="ch-acts"><button class="icon-btn" data-ch="merge"${w.busy ? ' disabled' : ''}>Merge</button><button class="icon-btn" data-ch="discard"${w.busy ? ' disabled' : ''}>Discard</button></span></div>`).join('');
    body.innerHTML = `${files.length ? `<div class="ch-tools"><span class="muted small">${files.length} file${files.length === 1 ? '' : 's'} changed</span><span class="spacer"></span><button class="btn sec" data-ch="diffAll">Open all diffs</button><button class="btn sec" data-ch="revertAll">Revert all</button><button class="btn" data-ch="acceptAll">Accept all</button></div><div class="ch-list">${fileRows}</div>` : '<div class="sk-empty">No file changes are waiting for review.</div>'}
      ${worktrees.length ? `<h4 class="ch-head">Agent branches</h4><div class="ch-list">${wtRows}</div>` : ''}`;
  }
  function openChanges() {
    if (!$('changesModal')) {
      const l = document.createElement('div'); l.className = 'modal'; l.id = 'changesModal';
      l.innerHTML = '<div class="mcard wide"><div class="mtitle">Changed files<button class="icon-btn" id="chClose" title="Close (Esc)">✕</button></div><div id="chBody"></div></div>';
      document.body.appendChild(l);
      const close = () => { l.remove(); input.focus(); };
      $('chClose').onclick = close;
      l.addEventListener('mousedown', (e) => { if (e.target === l) { close(); } });
      l.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); } });
      l.addEventListener('click', (e) => {
        const b = e.target.closest('[data-ch]'); if (!b) { return; }
        const row = b.closest('.ch-row');
        post({ type: 'changeAction', action: b.dataset.ch, rel: row?.dataset.rel, agentId: row?.dataset.agent });
      });
    }
    renderChanges();
  }
  $('changesBtn').onclick = () => post({ type: 'openChanges' });

  /* ---------- commit message review ---------- */
  function openCommit(m) {
    $('commitModal')?.remove();
    const l = document.createElement('div'); l.className = 'modal'; l.id = 'commitModal';
    l.innerHTML = `<div class="mcard wide"><div class="mtitle">Commit to ${esc(m.branch)}<button class="icon-btn" id="cmClose" title="Close (Esc)">✕</button></div>
      <div class="muted small">${m.source === 'staged' ? 'Commits your staged changes.' : 'Stages and commits all changes.'}${m.truncated ? ' The diff was long, so the message is based on part of it.' : ''} Edit the message if needed.</div>
      <textarea id="cmText" class="htext" rows="8" spellcheck="false"></textarea><div class="err small" id="cmErr"></div>
      <div class="actions"><span class="spacer"></span><button class="btn sec" id="cmCancel">Cancel</button><button class="btn" id="cmGo">Commit</button></div></div>`;
    document.body.appendChild(l);
    $('cmText').value = m.message || '';
    const close = () => { l.remove(); input.focus(); };
    $('cmClose').onclick = close; $('cmCancel').onclick = close;
    l.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); } });
    $('cmGo').onclick = () => {
      const message = $('cmText').value.trim();
      if (!message) { $('cmText').focus(); return; }
      $('cmGo').disabled = true; $('cmErr').textContent = '';
      post({ type: 'doCommit', message, source: m.source });
    };
    $('cmText').focus();
  }

  /* ---------- session summary / handoff ---------- */
  function openHandoff() {
    $('handoff')?.remove();
    const l = document.createElement('div'); l.className = 'modal'; l.id = 'handoff';
    l.innerHTML = `<div class="mcard wide"><div class="mtitle">Session summary<button class="icon-btn" id="hClose" title="Close (Esc)">✕</button></div>
      <div class="muted small">A handoff of this whole session: goal, what was done, decisions, files changed, commands, agents and next steps. Paste it into a new session to continue.</div>
      <div id="hBody" class="hbody"><div class="hload"><span class="spin"></span> Summarizing the session…</div></div>
      <div class="actions"><span class="muted small" id="hMeta"></span><span class="spacer"></span>
        <button class="btn sec" id="hRegen" disabled>Regenerate</button><button class="btn sec" id="hNew" disabled>Start new session with this</button><button class="btn" id="hCopy" disabled>Copy</button></div></div>`;
    document.body.appendChild(l);
    const close = () => { l.remove(); input.focus(); };
    $('hClose').onclick = close;
    l.addEventListener('mousedown', (e) => { if (e.target === l) { close(); } });
    l.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); } });
    $('hRegen').onclick = () => { $('hBody').innerHTML = '<div class="hload"><span class="spin"></span> Summarizing the session…</div>'; ['hRegen', 'hNew', 'hCopy'].forEach((id) => { $(id).disabled = true; }); post({ type: 'summarize' }); };
    $('hCopy').onclick = (e) => copyText($('hText').value, e.currentTarget);
    $('hNew').onclick = () => { post({ type: 'startWithHandoff', text: $('hText').value }); close(); };
    post({ type: 'summarize' });
  }
  function showHandoff(m) {
    if (!$('handoff')) { return; }
    if (!m.text) { $('hBody').innerHTML = `<div class="err">Could not summarize: ${esc(m.error || 'unknown error')}</div>`; $('hRegen').disabled = false; return; }
    $('hBody').innerHTML = `<textarea id="hText" class="htext" spellcheck="false"></textarea>`;
    $('hText').value = m.text;
    $('hMeta').textContent = `${m.files} file${m.files === 1 ? '' : 's'} changed · ${m.commands} command${m.commands === 1 ? '' : 's'}${m.usedLlm ? '' : ' · facts only (LLM summary unavailable)'}`;
    ['hRegen', 'hNew', 'hCopy'].forEach((id) => { $(id).disabled = false; });
    $('hCopy').focus();
  }
  $('sumBtn').onclick = openHandoff;

  let bmRequested = false;
  $('bmBtn').onclick = () => { if (openMenu?.classList.contains('bm-menu')) { closeMenu(); } else { bmRequested = true; post({ type: 'listBookmarks' }); } };
  function bookmarkMenu(items) {
    closeMenu();
    const m = document.createElement('div'); m.className = 'menu bm-menu';
    m.insertAdjacentHTML('beforeend', `<div class="mhead">Bookmarks${items.length ? ` (${items.length})` : ''}</div>`);
    if (!items.length) { m.insertAdjacentHTML('beforeend', '<div class="mempty">No bookmarks yet. Hover a reply and click the bookmark icon to keep it handy.</div>'); }
    for (const b of items) {
      const r = document.createElement('div'); r.className = 'item';
      r.innerHTML = `<div class="row"><span class="bmprev">${esc(b.preview || '(empty)')}</span></div><span class="d">${esc(b.agentName)} · message ${b.turn + 1}</span>`;
      r.onmousedown = (ev) => { ev.preventDefault(); closeMenu(); post({ type: 'gotoBookmark', agentId: b.agentId, turn: b.turn, hash: b.hash }); };
      m.appendChild(r);
    }
    placeBelow(m, $('bmBtn'), true);
  }
  function scrollToReply(turn, h) {
    const el = [...log.querySelectorAll('.msg.assistant')].find((d) => Number(d.dataset.turn) === Number(turn) && hash(d.dataset.raw || '') === h);
    if (!el) { add('info', 'That bookmarked reply is no longer in the conversation.'); return; }
    pinned = false; jumpBtn.hidden = false;   // reading an older reply: new output must not pull the view away from it
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600);
  }

  /* ---------- context usage popup ---------- */
  const CTX_COLORS = { system: '#d97706', tools: '#3b82f6', mcp: '#22c55e', agents: '#a855f7', memory: '#eab308', messages: '#ef4444', buffer: '#06b6d4', free: 'transparent' };
  $('ctxRing').onclick = () => { if ($('ctxPop')) { $('ctxPop').remove(); return; } post({ type: 'contextDetails' }); };
  function contextPopup(d) {
    $('ctxPop')?.remove();
    const pct = d.limit ? (d.used / d.limit) * 100 : 0;
    const p = document.createElement('div'); p.className = 'ctxpop'; p.id = 'ctxPop'; p.tabIndex = -1;
    const cats = d.categories;
    const bar = cats.filter((c) => c.key !== 'free').map((c) => `<span style="width:${Math.max(c.tokens ? 0.6 : 0, (c.tokens / d.limit) * 100)}%;background:${CTX_COLORS[c.key]}" title="${esc(c.label)}: ${k(c.tokens)}"></span>`).join('');
    const rows = cats.map((c) => `<tr class="${c.key}"><td><span class="sw" style="background:${CTX_COLORS[c.key]}"></span>${esc(c.label)}</td><td>${k(c.tokens)}</td><td>${d.limit ? ((c.tokens / d.limit) * 100).toFixed(1) : '0.0'}%</td></tr>`).join('');
    const ms = d.messages;
    p.innerHTML = `<div class="cph"><b>Context usage</b><button class="icon-btn" id="cpClose" title="Close (Esc)">✕</button></div>
      <div class="cpsub">${esc(d.agentName)} · ${esc(d.model || '')}</div>
      <div class="cptot"><b>${k(d.used)}</b> / ${k(d.limit)} tokens <span class="muted">(${pct.toFixed(0)}%)</span></div>
      <div class="cpbar">${bar}</div>
      <table class="cptable"><thead><tr><th>Category</th><th>Tokens</th><th>Usage</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="cpsec"><h4>Messages</h4>
        <div class="kv"><span>Turns</span><b>${ms.turns}</b></div>
        <div class="kv"><span>Your messages</span><b>${ms.userCount} · ${k(ms.userTokens)}</b></div>
        <div class="kv"><span>Assistant replies</span><b>${ms.assistantCount} · ${k(ms.assistantTokens)}</b></div>
        <div class="kv"><span>Tool results</span><b>${ms.toolResults} (${ms.toolCalls} calls) · ${k(ms.toolResultTokens)}</b></div></div>
      <div class="cpsec"><h4>Memory files</h4>${d.memoryFile ? `<div class="kv"><span>${esc(d.memoryFile.name)}</span><b>${k(d.memoryFile.tokens)}</b></div>` : '<div class="muted small">None (add CLAUDE.md or INFRAON.md at the workspace root)</div>'}</div>
      ${d.mcp.length ? `<div class="cpsec"><h4>MCP servers</h4>${d.mcp.map((s) => `<div class="kv"><span>${esc(s.server)} (${s.tools} tools)</span><b>${k(s.tokens)}</b></div>`).join('')}</div>` : ''}
      <div class="cpfoot muted small">Auto-compacts at ${k(d.compactAt)} tokens (${Math.round(d.ratio * 100)}%).${d.measured ? '' : ' System prompt and tools are measured on the first request.'} Estimates use ~3.5 characters per token.</div>
      ${ms.turns >= 2 && !state.viewingSub ? '<div class="actions"><button class="btn sec" id="cpCompact">Compact now</button></div>' : ''}`;
    document.body.appendChild(p);
    const r = $('ctxRing').getBoundingClientRect();
    p.style.top = `${r.bottom + 6}px`;
    p.style.left = `${Math.max(8, Math.min(r.right - p.offsetWidth, innerWidth - p.offsetWidth - 8))}px`;
    $('cpClose').onclick = () => p.remove();
    const c = $('cpCompact'); if (c) { c.onclick = () => { p.remove(); post({ type: 'send', text: '/compact', images: [] }); }; }
    p.addEventListener('keydown', (e) => { if (e.key === 'Escape') { p.remove(); } });
    p.focus();
  }
  document.addEventListener('mousedown', (e) => { const p = $('ctxPop'); if (p && !p.contains(e.target) && !e.target.closest('#ctxRing')) { p.remove(); } });

  /* ================================================================ menus */
  let openMenu = null;
  function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
  function showMenu(anchor, items, onPick) {
    closeMenu();
    const m = document.createElement('div'); m.className = 'menu';
    items.forEach((it) => {
      if (it.sep) { m.insertAdjacentHTML('beforeend', '<div class="sep"></div>'); return; }
      const e = document.createElement('div'); e.className = `item${it.active || it.hl ? ' active' : ''}`;
      e.innerHTML = `<div class="row"><span>${esc(it.label)}</span>${it.active ? '<span>✓</span>' : ''}</div>${it.desc ? `<span class="d" title="${esc(it.desc)}">${esc(it.desc)}</span>` : ''}`;
      e.onmousedown = (ev) => { ev.preventDefault(); closeMenu(); onPick(it); };
      m.appendChild(e);
    });
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = `${Math.max(4, Math.min(r.left, innerWidth - m.offsetWidth - 4))}px`;
    m.style.bottom = `${innerHeight - r.top + 4}px`;
    openMenu = m;
    return m;
  }
  function placeBelow(m, anchor, alignRight) {
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = `${r.bottom + 4}px`;
    m.style.left = `${Math.max(4, Math.min(alignRight ? r.right - m.offsetWidth : r.left, innerWidth - m.offsetWidth - 4))}px`;
    openMenu = m;
  }
  document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target) && !e.target.closest('.pill, #agentBtn, #bmBtn')) { closeMenu(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenu) { closeMenu(); } });

  /* ================================================================ composer */
  function refreshPills() {
    const mp = $('modePill'); mp.className = `pill mode-${state.mode}`; mp.querySelector('span').textContent = state.modeInfo[state.mode]?.label ?? state.mode;
    $('effortPill').querySelector('span').textContent = `Effort: ${state.effortInfo[state.effort]?.label ?? state.effort}`;
    $('modelPill').querySelector('span').textContent = state.model || 'Model';
    $('modelPill').title = state.model;
  }
  $('modePill').onclick = (e) => showMenu(e.currentTarget, Object.entries(state.modeInfo).map(([key, v]) => ({ id: key, label: v.label, desc: v.description, active: key === state.mode })), (it) => post({ type: 'setMode', value: it.id }));
  $('effortPill').onclick = (e) => showMenu(e.currentTarget, Object.entries(state.effortInfo).map(([key, v]) => ({ id: key, label: v.label, desc: v.description, active: key === state.effort })), (it) => post({ type: 'setEffort', value: it.id }));
  $('modelPill').onclick = (e) => {
    const items = state.models.map((m) => ({ id: m, label: m, active: m === state.model }));
    if (!items.length) { items.push({ id: state.model, label: state.model || '(no models found)', active: true }); }
    items.push({ sep: true }, { id: '__refresh', label: 'Refresh model list' });
    showMenu(e.currentTarget, items, (it) => post(it.id === '__refresh' ? { type: 'refreshModels' } : { type: 'setModel', value: it.id }));
  };
  const IDLE_PLACEHOLDER = input.placeholder;
  function setBusy(b) {
    const was = busy;
    busy = b;
    if (was !== b) { todoPausedAt = b ? 0 : Date.now(); if (lastTodos && $('todo-card')) { renderTodos(lastTodos); } } $('stop').style.display = b ? 'grid' : 'none';
    $('send').title = b ? 'Queue message: the agent reads it at its next step (Enter)' : 'Send (Enter)';
    input.placeholder = b ? 'Agent is working: type to queue a message (it is read at the next step)' : IDLE_PLACEHOLDER;
  }
  /* ---------- messages queued while the agent works (Claude-style) ---------- */
  function renderQueue(items) {
    const box = $('queued');
    box.hidden = !items.length;
    box.innerHTML = items.length ? `<div class="q-head">Queued · sent with the agent's next step</div>${items.map((q) => `<div class="q-item" data-id="${esc(q.id)}"><span class="q-text" title="${esc(q.display)}">${esc(q.display)}</span><button class="icon-btn" data-q="edit" title="Take back to edit">Edit</button><button class="icon-btn" data-q="remove" title="Remove from queue">✕</button></div>`).join('')}` : '';
  }
  $('queued').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-q]'); if (!b) { return; }
    const id = b.closest('.q-item').dataset.id;
    post({ type: 'unqueue', id, edit: b.dataset.q === 'edit' });
  });
  function send() {
    const t = input.value.trim();
    if (!t && !images.length) { return; }
    post({ type: 'send', text: t, images: images.map(({ name, mime, dataUrl, thumb }) => ({ name, mime, dataUrl, thumb })) });
    input.value = ''; images = []; renderAttach(); autosize(); hidePopup();
    scroll(true);   // sending always jumps to the latest and follows again, even when queued or sent mid-turn
  }
  function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, innerHeight * 0.4)}px`; }
  $('send').onclick = send;
  $('stop').onclick = () => post({ type: 'stop' });
  $('newBtn').onclick = () => post({ type: 'newSession' });
  $('sidebarBtn').onclick = () => post({ type: 'openSidebar' });
  /* ---------- inline session-name editing: autosave while typing, Ctrl+Z / Ctrl+Y, Enter to finish, Esc to revert ---------- */
  let titleEditing = false;
  function editTitle() {
    if (titleEditing) { return; }
    titleEditing = true;
    const span = $('title');
    const original = span.textContent;
    const field = document.createElement('input');
    field.className = 'title-input'; field.value = original; field.maxLength = 120; field.setAttribute('aria-label', 'Session name');
    span.style.display = 'none'; $('titleEdit').style.display = 'none';
    span.after(field);
    field.focus(); field.select();
    let timer, lastSaved = original;
    const save = (v) => { const t = v.trim(); if (t && t !== lastSaved) { lastSaved = t; post({ type: 'setTitle', title: t }); } };
    field.addEventListener('input', () => { clearTimeout(timer); field.classList.toggle('invalid', !field.value.trim()); timer = setTimeout(() => save(field.value), 400); });
    const finish = (revert) => {
      if (!titleEditing) { return; }
      titleEditing = false; clearTimeout(timer);
      if (revert) { if (lastSaved !== original) { lastSaved = original; post({ type: 'setTitle', title: original }); } } else { save(field.value); }
      span.textContent = revert || !field.value.trim() ? original : field.value.trim();
      field.remove(); span.style.display = ''; $('titleEdit').style.display = '';
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(false); input.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(true); input.focus(); }
      // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) use the field's native undo history; every undo step autosaves too.
    });
    field.addEventListener('blur', () => finish(false));
  }
  $('title').onclick = editTitle;
  $('titleEdit').onclick = editTitle;
  input.addEventListener('input', () => { autosize(); onInputChange(); });
  input.addEventListener('keydown', (e) => {
    if (popupKey(e)) { return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); post({ type: 'cycleMode' }); }
  });

  /* ---------- screenshots / images ---------- */
  const MAX_IMAGES = 6, MAX_BYTES = 10 * 1024 * 1024;
  function thumbnail(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, 320 / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve({ thumb: c.toDataURL('image/jpeg', 0.8), w: img.width, h: img.height });
      };
      img.onerror = () => resolve({ thumb: '', w: 0, h: 0 });
      img.src = dataUrl;
    });
  }
  function addFiles(files) {
    for (const f of files) {
      if (!f.type.startsWith('image/')) { continue; }
      if (images.length >= MAX_IMAGES) { add('info error', `Up to ${MAX_IMAGES} images per message.`); break; }
      if (f.size > MAX_BYTES) { add('info error', `${esc(f.name)} is larger than 10 MB.`); continue; }
      const r = new FileReader();
      r.onload = async () => {
        const meta = await thumbnail(r.result);
        images.push({ name: f.name && f.name !== 'image.png' ? f.name : `screenshot-${images.length + 1}.png`, mime: f.type, dataUrl: r.result, thumb: meta.thumb, w: meta.w, h: meta.h });
        renderAttach();
      };
      r.readAsDataURL(f);
    }
  }
  function renderAttach() {
    const box = $('attach');
    box.innerHTML = images.map((im, i) => `<span class="att-chip" title="${esc(im.name)}"><img src="${esc(im.thumb)}" alt=""><span>${esc(im.name)}</span><small>${im.w}×${im.h}</small><button class="icon-btn" data-rm="${i}" title="Remove">×</button></span>`).join('');
    box.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { images.splice(Number(b.dataset.rm), 1); renderAttach(); }));
    box.style.display = images.length ? 'flex' : 'none';
  }
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  composer.addEventListener('dragover', (e) => { e.preventDefault(); composer.classList.add('drop'); });
  composer.addEventListener('dragleave', () => composer.classList.remove('drop'));
  composer.addEventListener('drop', (e) => { e.preventDefault(); composer.classList.remove('drop'); addFiles([...(e.dataTransfer?.files || [])]); });
  $('clipBtn').onclick = () => $('file').click();
  $('file').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };

  /* ---------- @file and /command popups ---------- */
  let popup = null, fileReq = 0;
  function openPopup(items, onPick) {
    if (!items.length) { hidePopup(); return; }
    const idx = popup ? Math.min(popup.idx, items.length - 1) : 0;
    popup = { items, idx, onPick };
    renderPopup();
  }
  function renderPopup() {
    const m = showMenu(composer, popup.items.map((it, i) => ({ ...it, hl: i === popup.idx })), (it) => popup.onPick(it));
    const r = composer.getBoundingClientRect();
    m.classList.add('wide'); m.style.width = `${r.width}px`; m.style.left = `${r.left}px`;
    m.querySelector('.item.active')?.scrollIntoView({ block: 'nearest' });
  }
  function hidePopup() { popup = null; closeMenu(); }
  function popupKey(e) {
    if (!popup) { return false; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = popup.items.length; popup.idx = (popup.idx + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; renderPopup(); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); popup.onPick(popup.items[popup.idx]); return true; }
    if (e.key === 'Escape') { e.preventDefault(); hidePopup(); return true; }
    return false;
  }
  function onInputChange() {
    const v = input.value, caret = input.selectionStart;
    const slash = /^\/([\w.:-]*)$/.exec(v);
    if (slash) {
      const p = slash[1].toLowerCase();
      const all = state.commands || [];
      const ranked = [...all.filter((c) => c.name.toLowerCase().startsWith(p)), ...all.filter((c) => !c.name.toLowerCase().startsWith(p) && c.name.toLowerCase().includes(p))];
      openPopup(ranked.map((c) => ({ id: c.name, label: `/${c.name}${c.args ? ' ' + c.args : ''}`, desc: `${c.skill ? `${c.source === 'user' ? 'personal' : 'project'} skill · ` : ''}${c.description}` })),
        (it) => { input.value = `/${it.id} `; hidePopup(); input.focus(); autosize(); });
      return;
    }
    const m = /(^|\s)@([^\s@]*)$/.exec(v.slice(0, caret));
    if (m) { post({ type: 'queryFiles', q: m[2], req: ++fileReq }); return; }
    hidePopup();
  }
  function onFiles(msg) {
    if (msg.req !== fileReq) { return; }
    const caret = input.selectionStart, before = input.value.slice(0, caret);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!m) { return; }
    openPopup(msg.items.map((f) => ({ id: f, label: f.split('/').pop(), desc: f })), (it) => {
      const start = before.length - m[2].length - 1;
      input.value = `${input.value.slice(0, start)}@${it.id} ${input.value.slice(caret)}`;
      const pos = start + it.id.length + 2; input.setSelectionRange(pos, pos);
      hidePopup(); input.focus(); autosize();
    });
  }

  /** Circular context meter in the header: percentage inside, exact tokens in the tooltip, click for details. */
  const RING_C = 2 * Math.PI * 15.5;
  function setUsage(used, limit) {
    used = used || 0;
    limit = limit || state.contextLimit || 0;
    const ring = $('ctxRing');
    if (!limit) { ring.style.visibility = 'hidden'; return; }
    ring.style.visibility = '';
    const pct = Math.min(100, (used / limit) * 100);
    const arc = $('ctxArc');
    arc.style.strokeDasharray = `${RING_C}`;
    arc.style.strokeDashoffset = `${RING_C * (1 - pct / 100)}`;
    ring.className = `ring${pct > 90 ? ' hot' : pct > 70 ? ' warn' : ''}`;
    $('ctxPct').textContent = used > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
    ring.title = `Context: ${k(used)} / ${k(limit)} tokens (${pct.toFixed(1)}%)\nClick for details`;
    ring.setAttribute('aria-label', `Context ${Math.round(pct)} percent used`);
  }

  /* ================================================================ host messages */
  window.addEventListener('message', ({ data: m }) => {
    switch (m.type) {
      case 'init': logo = m.logo; Object.assign(state, m.state); vscode.setState({ sessionId: state.sessionId }); refreshPills(); break;
      case 'state': Object.assign(state, m.state); refreshPills(); break;
      case 'replay': {
        Object.assign(state, m.state); refreshPills();
        bookmarks = new Set((m.bookmarks || []).map((b) => `${b.turn}:${b.hash}`));
        log.innerHTML = ''; cur = null; curText = ''; curTurn = -1; todoSig = '';
        replaying = true;
        for (const ev of m.events) { apply(ev); }
        replaying = false;
        log.querySelectorAll('.msg.assistant').forEach(markBookmark);
        if (!m.events.length) { showEmpty(); }
        renderQueue(m.queue || []);
        setBusy(BUSY.includes(m.view.status));
        setUsage(m.view.contextUsed, m.view.contextLimit);
        renderAgents();
        scroll(true); if (!state.viewingSub) { input.focus(); }
        break;
      }
      case 'agents': agents = m.agents; state.agentId = m.focused; state.mainId = m.mainId; $('title').textContent = m.title; renderAgents(); break;
      case 'files': onFiles(m); break;
      case 'bookmarks': if (bmRequested) { bmRequested = false; bookmarkMenu(m.items); } break;
      case 'scrollTo': setTimeout(() => scrollToReply(m.turn, m.hash), 60); break;
      case 'contextDetails': contextPopup(m.data); break;
      case 'handoff': showHandoff(m); break;
      case 'openChanges': changesData = { files: m.files || [], worktrees: m.worktrees || [] }; openChanges(); break;
      case 'changes': changesData = { files: m.files || [], worktrees: m.worktrees || [] }; renderChanges(); $('changesCount').hidden = !changesData.files.length; $('changesCount').textContent = String(changesData.files.length); break;
      case 'gitInfo':
        $('branchTag').hidden = !m.branch; $('branchTag').textContent = m.branch || ''; $('branchTag').title = `Current branch: ${m.branch || ''}`;
        $('changesCount').hidden = !m.changes; $('changesCount').textContent = String(m.changes || '');
        break;
      case 'commitDraft': openCommit(m); break;
      case 'commitDone': $('commitModal')?.remove(); input.focus(); break;
      case 'commitFailed': if ($('cmErr')) { $('cmErr').textContent = m.error; $('cmGo').disabled = false; } break;
      case 'openSkills': openSkills(m.view); break;
      case 'skills': skillsData = { items: m.items || [], errors: m.errors || [], template: m.template || skillsData.template }; if ($('skillsModal') && skillView === 'list') { renderSkills(); } break;
      case 'skillDetail': onSkillDetail(m.skill); break;
      case 'skillLint': if (window.__skillLint) { window.__skillLint(m); } break;
      case 'skillFileError': if ($('sfFileErr')) { $('sfFileErr').textContent = m.error; } break;
      case 'skillResult':
        if (m.ok) { skillView = 'list'; editDetail = null; renderSkills(); add('info', m.updated ? `Skill /${esc(m.name)} saved.` : `Skill /${esc(m.name)} created and opened in the editor. Try it with ▶ Test in the Skills manager, or type /${esc(m.name)}.`); }
        else if ($('sfErr')) { $('sfErr').textContent = m.error; $('sfCreate').disabled = false; }
        break;
      case 'queue': renderQueue(m.items || []); break;
      case 'queueReturned': {
        const back = (m.texts || []).join('\n\n');
        if (back) { input.value = input.value.trim() ? `${back}\n\n${input.value}` : back; autosize(); input.focus(); }
        break;
      }
      case 'prefill': input.value = m.text || ''; autosize(); input.focus(); input.setSelectionRange(input.value.length, input.value.length); break;
      default: apply(m);
    }
  });
  post({ type: 'ready' });
})();
