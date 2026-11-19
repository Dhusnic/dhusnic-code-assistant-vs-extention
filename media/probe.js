/* Shared by the session tab and the sidebar.
 * 1. Always: forwards uncaught script errors to the extension (shown in the "Infraon Assistant" output channel).
 * 2. Only in automated UI tests (the host enables it): answers DOM queries and simulates clicks / typing. */
(function (root) {
  function visible(el) {
    if (!el) { return false; }
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }
  function describe(el) {
    if (!el) { return undefined; }
    const out = {};
    for (const a of el.getAttributeNames()) { if (a.startsWith('data-') || a === 'id' || a === 'class' || a === 'title' || a === 'hidden') { out[a] = el.getAttribute(a); } }
    return out;
  }
  function run(m) {
    const all = m.selector ? [...document.querySelectorAll(m.selector)] : [];
    const el = all[m.index || 0];
    const need = () => { if (!el) { throw new Error(`no element matches ${m.selector}`); } };
    switch (m.action) {
      case 'query':
        return {
          count: all.length,
          texts: all.slice(0, 20).map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400)),
          visible: visible(el), value: el && 'value' in el ? el.value : undefined,
          disabled: !!(el && el.disabled), checked: !!(el && el.checked), attrs: describe(el),
          scroll: el ? { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight } : undefined,
        };
      case 'click':
        need();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        el.click();
        return { ok: true };
      case 'input':
        need();
        el.focus();
        el.value = m.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      case 'check':
        need();
        el.checked = !!m.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      case 'scroll':
        need();
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: m.value < el.scrollTop ? -100 : 100, bubbles: true }));
        el.scrollTop = m.value;
        el.dispatchEvent(new Event('scroll'));
        return { ok: true };
      case 'key': {
        const target = el || document.activeElement || document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: m.key, bubbles: true, cancelable: true, ctrlKey: !!m.ctrl, shiftKey: !!m.shift }));
        return { ok: true };
      }
      case 'state':
        return { title: document.title, active: document.activeElement ? describe(document.activeElement) : undefined, bodyClass: document.body.className };
      default:
        throw new Error(`unknown probe action ${m.action}`);
    }
  }
  root.InfraonProbe = {
    install(post, isEnabled) {
      root.addEventListener('error', (e) => post({ type: '__error', message: String(e.message || (e.error && e.error.message) || 'script error'), source: e.filename, line: e.lineno, col: e.colno }));
      root.addEventListener('unhandledrejection', (e) => post({ type: '__error', message: String((e.reason && e.reason.message) || e.reason) }));
      root.addEventListener('message', ({ data: m }) => {
        if (!m || m.type !== '__probe' || !isEnabled()) { return; }
        let result;
        try { result = run(m); } catch (err) { result = { error: String((err && err.message) || err) }; }
        post({ type: '__probeResult', id: m.id, result });
      });
    },
  };
})(window);
