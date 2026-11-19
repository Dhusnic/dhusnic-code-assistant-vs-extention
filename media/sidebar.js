/* Infraon sidebar: LLM status/usage + session manager with live agent activity. */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const { esc } = window.InfraonMd;
  const post = (m) => vscode.postMessage(m);
  if (window.InfraonProbe) { window.InfraonProbe.install(post, () => !!(data && data.e2e)); }
  const saved = vscode.getState() || {};
  let data = { llm: null, sessions: [] };
  let filter = saved.filter || 'all', query = '';
  const expanded = new Set(saved.expanded || []);
  const closedSecs = new Set(saved.closedSecs || ['storeSec']);
  const persist = () => vscode.setState({ filter, expanded: [...expanded], closedSecs: [...closedSecs] });

  const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 45) { return 'now'; }
    if (s < 3600) { return `${Math.round(s / 60)}m`; }
    if (s < 86400) { return `${Math.round(s / 3600)}h`; }
    return `${Math.round(s / 86400)}d`;
  }
  const since = (ts) => { if (!ts) { return ''; } const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
  const STATUS = { idle: 'Idle', queued: 'Queued', running: 'Working', waiting: 'Needs approval', error: 'Error', interrupted: 'Interrupted' };

  /* ---------- sections ---------- */
  document.querySelectorAll('.sec-h').forEach((h) => {
    const sec = $(h.dataset.sec);
    sec.classList.toggle('open', !closedSecs.has(sec.id));
    h.onclick = () => { sec.classList.toggle('open'); if (sec.classList.contains('open')) { closedSecs.delete(sec.id); } else { closedSecs.add(sec.id); } persist(); };
  });

  /* ---------- LLM ---------- */
  function renderLlm() {
    const l = data.llm; if (!l) { return; }
    const h = l.health || {};
    const dot = h.ok === undefined ? 'unknown' : h.ok ? 'ok' : 'bad';
    const healthText = h.ok === undefined ? 'checking…' : h.ok ? `Online · ${h.ms} ms` : 'Offline';
    const u = l.usage, max = Math.max(1, ...u.days.map((d) => d.prompt + d.completion));
    const bars = u.days.map((d) => {
      const tot = d.prompt + d.completion;
      return `<div class="bar-col" title="${d.day}: ${d.requests} requests · ${k(tot)} tokens"><div style="height:${Math.round((tot / max) * 100)}%"></div><span>${'SMTWTFS'[new Date(`${d.day}T12:00:00`).getDay()]}</span></div>`;
    }).join('');
    const mcp = l.mcp.length ? l.mcp.map((s) => `<span class="tag ${s.status}">${esc(s.name)}${s.status === 'connected' ? ` · ${s.tools}` : ''}</span>`).join('') : '<span class="muted">none</span>';
    $('llm').innerHTML = `
      <div class="kv"><span>Endpoint</span><b title="${esc(l.endpoint)}">${esc(l.endpoint || 'not set')}</b></div>
      <div class="kv"><span>Status</span><b><span class="hdot ${dot}"></span>${healthText}</b></div>
      ${h.ok === false ? `<div class="err">${esc(h.error || '')} <a href="#" id="keyLink">Set API key</a></div>` : ''}
      <div class="kv"><span>Model</span><select id="modelSel">${(l.models.length ? l.models : [l.model]).map((m) => `<option${m === l.model ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select></div>
      <div class="kv"><span>Context</span><b>${k(l.contextWindow)} tokens</b></div>
      <div class="kv"><span>Agents</span><b>${l.running} running${l.queued ? ` · ${l.queued} queued` : ''} / limit ${l.maxConcurrent}</b></div>
      <div class="kv"><span>MCP</span><b class="tags">${mcp}</b></div>
      <h4>Usage</h4>
      <div class="kv"><span>Today</span><b>${u.today.requests} req · ${k(u.today.prompt + u.today.completion)} tokens</b></div>
      <div class="meter"><div style="width:${Math.min(100, ((u.today.prompt + u.today.completion) / Math.max(1, u.week.prompt + u.week.completion)) * 100)}%"></div></div>
      <div class="kv"><span>Last 7 days</span><b>${u.week.requests} req · ${k(u.week.prompt + u.week.completion)} tokens</b></div>
      <div class="bars">${bars}</div>
      <div class="kv small"><span>Prompt / completion (7d)</span><b>${k(u.week.prompt)} / ${k(u.week.completion)}</b></div>
      ${u.week.errors ? `<div class="kv small"><span>Failed requests (7d)</span><b class="warn">${u.week.errors}</b></div>` : ''}
      <div class="row-btns"><button class="link" id="settingsLink">Settings</button></div>`;
    $('modelSel').onchange = (e) => post({ type: 'setModel', value: e.target.value });
    $('settingsLink').onclick = () => post({ type: 'openSettings' });
    const kl = $('keyLink'); if (kl) { kl.onclick = (e) => { e.preventDefault(); post({ type: 'setApiKey' }); }; }
  }

  /* ---------- sessions ---------- */
  function renderSessions() {
    const active = data.sessions.filter((s) => s.status === 'running' || s.status === 'waiting');
    $('activeSeg').textContent = `Active · ${active.length}`;
    document.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
    const q = query.toLowerCase();
    const rows = data.sessions.filter((s) => (filter === 'all' || s.status === 'running' || s.status === 'waiting') && (!q || s.title.toLowerCase().includes(q)));
    const list = $('list');
    if (!rows.length) { list.innerHTML = `<div class="muted empty-list">${data.sessions.length ? 'No sessions match.' : 'No sessions yet. Start one with “New session”.'}</div>`; return; }
    list.innerHTML = rows.map((s) => {
      const open = expanded.has(s.id) || s.status === 'waiting';
      const agents = s.agents.length ? s.agents.map((a) => `
        <div class="ag st-${a.status}${a.role === 'sub' ? ' sub-ag' : ''}">
          <span class="dot"></span><span class="an">${a.role === 'sub' ? `<span class="tchip">${esc(a.type || 'agent')}</span> ${esc(a.description || a.name)}` : 'Main'}</span>
          <span class="as">${['running', 'queued', 'waiting'].includes(a.status) || !a.outcome ? (STATUS[a.status] || a.status) : ({ completed: 'Completed', failed: 'Failed', cancelled: 'Stopped' })[a.outcome]}${a.activity && a.status !== 'idle' ? ` · ${esc(a.activity)}` : ''}${a.startedAt ? ` · ${since(a.startedAt)}` : ''}</span>
          ${['running', 'queued', 'waiting'].includes(a.status) ? `<button class="icon-btn" data-stop="${esc(s.id)}|${esc(a.id)}" title="Stop this agent">■</button>` : ''}
        </div>
        ${a.subtasks.filter((t) => !t.done).map((t) => `<div class="sub"><span class="spin"></span>${esc(t.title)} — ${esc(t.last)}</div>`).join('')}
        ${a.contextLimit ? `<div class="ctxmini" title="Context ${k(a.contextUsed)} / ${k(a.contextLimit)}"><div style="width:${Math.min(100, (a.contextUsed / a.contextLimit) * 100)}%"></div></div>` : ''}`).join('')
        : `<div class="muted small">${s.agentCount} agent${s.agentCount === 1 ? '' : 's'} · ${s.turns} message${s.turns === 1 ? '' : 's'} (open to load)</div>`;
      const tok = s.tokens && (s.tokens.prompt + s.tokens.completion) ? ` · ${k(s.tokens.prompt + s.tokens.completion)} tok` : '';
      return `<div class="srow st-${s.status}${s.open ? ' isopen' : ''}" data-id="${esc(s.id)}">
        <div class="shead">
          <button class="caret${open ? ' open' : ''}" data-toggle="${esc(s.id)}" title="Show agents">▸</button>
          <span class="dot" title="${STATUS[s.status] || s.status}"></span>
          <span class="stitle" title="${esc(s.title)}">${esc(s.title)}</span>
          <span class="meta">${s.agentCount > 1 ? `${s.agentCount} agents · ` : ''}${ago(s.updatedAt)}${tok}</span>
          <span class="acts">
            ${s.status === 'running' || s.status === 'waiting' ? `<button class="icon-btn" data-stopall="${esc(s.id)}" title="Stop all agents">■</button>` : ''}
            <button class="icon-btn" data-rename="${esc(s.id)}" title="Rename">✎</button>
            <button class="icon-btn" data-del="${esc(s.id)}" title="Delete">🗑</button>
          </span>
        </div>
        ${open ? `<div class="agents-box">${agents}</div>` : ''}
      </div>`;
    }).join('');
  }
  $('list').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (t?.dataset.toggle) { const id = t.dataset.toggle; if (expanded.has(id)) { expanded.delete(id); } else { expanded.add(id); } persist(); renderSessions(); return; }
    if (t?.dataset.stop) { const [sid, aid] = t.dataset.stop.split('|'); post({ type: 'stopAgent', sid, aid }); return; }
    if (t?.dataset.stopall) { post({ type: 'stopSession', id: t.dataset.stopall }); return; }
    if (t?.dataset.rename) { post({ type: 'renameSession', id: t.dataset.rename }); return; }
    if (t?.dataset.del) { post({ type: 'deleteSession', id: t.dataset.del }); return; }
    const row = e.target.closest('.srow'); if (row) { post({ type: 'openSession', id: row.dataset.id }); }
  });
  document.querySelectorAll('.seg').forEach((b) => (b.onclick = () => { filter = b.dataset.filter; persist(); renderSessions(); }));
  $('search').oninput = (e) => { query = e.target.value; renderSessions(); };
  $('deepSearch').onclick = () => post({ type: 'deepSearch', q: query });
  $('newSession').onclick = () => post({ type: 'newSession' });
  $('refreshBtn').onclick = () => post({ type: 'refresh' });

  /* ---------- storage check ---------- */
  $('verifyBtn').onclick = () => post({ type: 'verify' });
  function renderVerify(r) {
    const counts = { ok: 0, repaired: 0, corrupt: 0 };
    r.items.forEach((i) => { counts[i.status]++; });
    $('verify').innerHTML = `
      <div class="vline ${r.selfTest.ok ? 'ok' : 'bad'}">${r.selfTest.ok ? '✓' : '✕'} Save/load self-test ${r.selfTest.ok ? 'passed' : 'FAILED'} (${r.selfTest.ms} ms) — ${esc(r.selfTest.detail)}</div>
      <div class="vline">${r.items.length} saved session${r.items.length === 1 ? '' : 's'}: <b class="okc">${counts.ok} ok</b>${counts.repaired ? `, <b class="warn">${counts.repaired} repaired</b>` : ''}${counts.corrupt ? `, <b class="bad">${counts.corrupt} unreadable</b>` : ''}</div>
      ${r.items.filter((i) => i.status !== 'ok').map((i) => `<div class="vitem ${i.status}"><b>${esc(i.title)}</b> — ${i.status}<ul>${i.issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}`;
  }

  /* ---------- skills ---------- */
  function renderSkillList() {
    const box = $('skillList'); if (!box) { return; }
    const items = data.skills || [];
    if (!items.length) { box.innerHTML = '<div class="muted small">No skills yet. Skills are reusable instructions run with /name or picked by the agent automatically.</div>'; return; }
    box.innerHTML = items.map((s) => `<div class="skrow" data-name="${esc(s.name)}" title="${esc(s.description)}">
      <span class="skn">/${esc(s.name)}</span><span class="tchip">${s.source === 'user' ? 'personal' : 'project'}</span>${s.modelInvocable ? '<span class="tchip auto" title="The agent can use it automatically">auto</span>' : ''}
      <span class="spacer"></span>${s.userInvocable ? '<button class="icon-btn" data-run title="Run in a new session">▶</button>' : ''}</div>`).join('')
      + (data.skillErrors ? `<div class="warn small">${data.skillErrors} skill file(s) could not be loaded — open Manage… to see why.</div>` : '');
  }
  $('skillList').addEventListener('click', (e) => {
    const row = e.target.closest('.skrow'); if (!row) { return; }
    post({ type: e.target.closest('[data-run]') ? 'runSkill' : 'openSkill', name: row.dataset.name });
  });
  $('skNewSide').onclick = () => post({ type: 'manageSkills', view: 'new' });
  $('skManageSide').onclick = () => post({ type: 'manageSkills' });

  /* ---------- servers ---------- */
  function renderServerList() {
    const servers = data.servers || [];
    const box = $('serverList');
    if (!servers.length) {
      box.innerHTML = '<div class="muted small">No servers configured. Click "Add Server" to configure MCP servers with secure credentials.</div>';
      return;
    }
    box.innerHTML = servers.map((s, idx) => `
      <div class="server-row" data-idx="${idx}">
        <div class="server-header">
          <span class="server-name">${esc(s.name)}</span>
          <span class="tag ${s.status || 'connected'}">${s.status || 'connected'}</span>
        </div>
        <div class="server-details">
          <div class="kv"><span>Command</span><b>${esc(s.command)}</b></div>
          ${s.args && s.args.length ? `<div class="kv"><span>Args</span><b>${esc(s.args.join(' '))}</b></div>` : ''}
          ${s.env ? renderEnvVars(s.env) : ''}
        </div>
        <div class="server-actions">
          <button class="icon-btn" data-edit="${idx}" title="Edit">${EDIT}</button>
          <button class="icon-btn" data-clone="${idx}" title="Clone">${CLONE}</button>
          <button class="icon-btn" data-delete="${idx}" title="Delete">${DELETE}</button>
        </div>
      </div>
    `).join('');
  }

  function renderEnvVars(env) {
    if (!env || !Object.keys(env).length) return '<div class="kv"><span>Environment</span><b class="muted">none</b></div>';
    return `<div class="kv env-vars"><span>Environment</span><div class="env-list">${Object.entries(env).map(([k, v]) => {
      const isSecret = /password|token|api[_-]?key|secret/i.test(k);
      const masked = isSecret ? '••••••••' : esc(v);
      return `<div class="env-item">
        <span class="env-key">${esc(k)}</span>
        <span class="env-value">${masked}</span>
        ${isSecret ? `<button class="icon-btn toggle-secret" title="Show/Hide">${EYE}</button>` : ''}
      </div>`;
    }).join('')}</div></div>`;
  }

  $('serverList').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    
    if (btn.dataset.add) {
      post({ type: 'addServer' });
    } else if (btn.dataset.edit) {
      post({ type: 'editServer', idx: Number(btn.dataset.edit) });
    } else if (btn.dataset.clone) {
      post({ type: 'cloneServer', idx: Number(btn.dataset.clone) });
    } else if (btn.dataset.delete) {
      const idx = Number(btn.dataset.delete);
      if (confirm(`Delete server "${data.servers[idx]?.name}"?`)) {
        post({ type: 'deleteServer', idx });
      }
    } else if (btn.classList.contains('toggle-secret')) {
      const item = btn.closest('.env-item');
      const valueEl = item.querySelector('.env-value');
      const current = valueEl.textContent;
      if (current === '••••••••') {
        const key = item.querySelector('.env-key').textContent;
        const serverIdx = item.closest('.server-row').dataset.idx;
        const server = data.servers[serverIdx];
        if (server && server.env && server.env[key]) {
          valueEl.textContent = server.env[key];
          btn.innerHTML = EYE_OFF;
        }
      } else {
        valueEl.textContent = '••••••••';
        btn.innerHTML = EYE;
      }
    }
  });

  $('addServerBtn').onclick = () => post({ type: 'addServer' });

  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'data') { data = m; renderLlm(); renderSessions(); renderSkillList(); renderServerList(); }
    else if (m.type === 'verifying') { $('verify').innerHTML = '<div class="muted">Checking…</div>'; }
    else if (m.type === 'verifyResult') { renderVerify(m); }
  });
  setInterval(() => { if (data.sessions.some((s) => s.agents.some((a) => a.startedAt))) { renderSessions(); } }, 1000);
  post({ type: 'ready' });
})();
