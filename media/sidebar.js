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
    // state/label come from core/modelHealth.ts: the model list and a probe of the selected model.
    const dot = h.state === 'degraded' ? 'warn' : h.ok === undefined ? 'unknown' : h.ok ? 'ok' : 'bad';
    const healthText = h.label || (h.ok === undefined ? 'checking…' : h.ok ? `Online · ${h.ms} ms` : 'Offline');
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
      ${h.state === 'degraded' ? `<div class="err">The gateway answers, but ${esc(l.model)} did not reply to a test request${h.modelError ? ` (${esc(h.modelError)})` : ''}. Chats will wait or fail until it recovers.</div>` : ''}
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
          <span class="stitle" title="${esc(s.title)}${s.unassigned ? ' (older session saved before sessions were kept per workspace; opening it here assigns it to this workspace)' : ''}">${s.unassigned ? '<span class="muted">◌ </span>' : ''}${esc(s.title)}</span>
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

  /* ---------- servers: MCP and Linux servers (credentials stay in the host's encrypted secret storage) ---------- */
  let editing = null;   // { kind, name } while an existing server is being edited
  let testing = false;  // true while a "Test connection" request is in flight
  const quoteArg = (a) => (/[\s"']/.test(a) || !a ? `"${a.replace(/"/g, '\\"')}"` : a);
  function renderServerList() {
    const mcp = data.mcpServers || [], linux = data.linuxServers || [];
    const box = $('serverList');
    if (!mcp.length && !linux.length) { box.innerHTML = '<div class="muted small">No servers yet. MCP servers give the agent extra tools; Linux servers keep SSH details and credentials in one safe place.</div>'; return; }
    const acts = (editable) => `<span class="sv-acts">${editable ? '<button class="icon-btn" data-sv="edit" title="Edit">✎</button>' : '<span class="tchip alt" title="Defined in the workspace settings">workspace</span>'}<button class="icon-btn" data-sv="clone" title="Duplicate">⧉</button>${editable ? '<button class="icon-btn" data-sv="delete" title="Delete">🗑</button>' : ''}</span>`;
    const envChips = (keys) => (keys.length ? `<div class="sv-env">${keys.map((key) => `<span class="tchip alt">${esc(key)}</span>`).join(' ')}</div>` : '');
    const cmd = (s) => [s.command, ...s.args].map(quoteArg).join(' ');
    const noteLine = (notes) => { const first = String(notes || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean); return first ? `<div class="sv-note" title="${esc(notes)}">${esc(first)}</div>` : ''; };
    box.innerHTML = (mcp.length ? `<h4 class="sv-head">MCP servers</h4>${mcp.map((s) => `<div class="sv-row2" data-kind="mcp" data-name="${esc(s.name)}">
        <div class="sv-top"><span class="sv-name">${esc(s.name)}</span>${s.status ? `<span class="tag ${esc(s.status)}">${esc(s.status)}</span>` : ''}${acts(s.editable)}</div>
        <div class="sv-detail" title="${esc(cmd(s))}">${esc(cmd(s))}</div>${envChips(Object.keys(s.env || {}))}</div>`).join('')}` : '')
      + (linux.length ? `<h4 class="sv-head">Linux servers</h4>${linux.map((s) => `<div class="sv-row2" data-kind="linux" data-name="${esc(s.name)}">
        <div class="sv-top"><span class="sv-name">${esc(s.name)}</span>${s.connected ? '<span class="tag sv-conn" title="The agent has an open SSH connection to this server">connected</span>' : ''}${s.hasCredential ? '' : '<span class="tag error" title="Edit the server to add its credential">no credential</span>'}${acts(true)}</div>
        <div class="sv-detail">${esc(s.user)}@${esc(s.host)}:${Number(s.port)} · ${s.auth === 'key' ? 'SSH key' : 'password'}</div>${noteLine(s.notes)}${envChips(s.envKeys || [])}</div>`).join('')}` : '');
  }
  $('serverList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sv]'); if (!b) { return; }
    const row = b.closest('.sv-row2'), kind = row.dataset.kind, name = row.dataset.name;
    if (b.dataset.sv === 'edit') { openServerDialog(kind, name); } else { post({ type: b.dataset.sv === 'clone' ? 'cloneServer' : 'deleteServer', kind, name }); }
  });

  const envRow = (key, value, keep) => `<div class="env-row"><input class="env-k" placeholder="NAME" value="${esc(key)}" spellcheck="false"><input class="env-v" type="password" placeholder="${keep ? 'unchanged' : 'value'}" value="${esc(value)}" autocomplete="off"><button class="icon-btn env-x" title="Remove">✕</button></div>`;
  function showKind() {
    const linux = $('serverKind').value === 'linux', key = $('serverAuth').value === 'key';
    $('linuxFields').hidden = !linux; $('mcpFields').hidden = linux;
    $('keyGroup').hidden = !key; $('passwordGroup').hidden = key;
    $('serverTestBtn').hidden = !linux;
    if (!linux) { setTestLine('', ''); }
  }
  function setTestLine(text, state) {
    const el = $('serverTest');
    el.textContent = text; el.className = `sv-test small${state ? ` ${state}` : ''}`;
  }
  function openServerDialog(kind, name) {
    const mcp = kind === 'mcp' && name ? (data.mcpServers || []).find((s) => s.name === name) : undefined;
    const linux = kind === 'linux' && name ? (data.linuxServers || []).find((s) => s.name === name) : undefined;
    editing = name ? { kind, name } : null;
    $('dialogTitle').textContent = name ? `Edit ${name}` : 'Add server';
    $('serverKind').value = kind || 'linux'; $('serverKind').disabled = !!name;
    $('serverName').value = name || '';
    $('serverCommand').value = mcp ? [mcp.command, ...mcp.args].map(quoteArg).join(' ') : '';
    $('serverHost').value = linux ? linux.host : ''; $('serverPort').value = linux ? linux.port : 22; $('serverUser').value = linux ? linux.user : '';
    $('serverAuth').value = linux ? linux.auth : 'password';
    $('serverPassword').value = ''; $('serverKey').value = ''; $('serverPassphrase').value = '';
    $('serverPassphrase').placeholder = linux ? 'Leave empty to keep the saved passphrase' : '';
    $('serverNotes').value = linux ? (linux.notes || '') : '';
    testing = false; $('serverTestBtn').disabled = false; setTestLine('', '');
    $('serverPassword').placeholder = linux ? 'Leave empty to keep the saved password' : '';
    $('serverKey').placeholder = linux ? 'Leave empty to keep the saved key' : '-----BEGIN OPENSSH PRIVATE KEY-----';
    // Linux environment values are secret: only their names come back, and an empty value keeps the saved one.
    $('envList').innerHTML = mcp ? Object.entries(mcp.env || {}).map(([key, v]) => envRow(key, v, false)).join('') : linux ? (linux.envKeys || []).map((key) => envRow(key, '', true)).join('') : '';
    $('serverErr').textContent = ''; $('dialogSave').disabled = false; markField();
    showKind();
    $('serverDialog').hidden = false;
    $('serverName').focus();
  }
  const closeServerDialog = () => { $('serverDialog').hidden = true; editing = null; testing = false; };
  $('addServerBtn').onclick = () => openServerDialog();
  $('serverKind').onchange = showKind;
  $('serverAuth').onchange = showKind;
  $('addEnvBtn').onclick = () => { $('envList').insertAdjacentHTML('beforeend', envRow('', '', false)); $('envList').lastElementChild.querySelector('.env-k').focus(); };
  $('envList').addEventListener('click', (e) => { const x = e.target.closest('.env-x'); if (x) { x.closest('.env-row').remove(); } });
  $('dialogClose').onclick = closeServerDialog;
  $('dialogCancel').onclick = closeServerDialog;
  $('serverDialog').addEventListener('mousedown', (e) => { if (e.target === $('serverDialog')) { closeServerDialog(); } });
  $('serverDialog').addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeServerDialog(); } });
  /** The dialog's fields as a saveServer / testServer message. */
  function serverForm(type) {
    const kind = $('serverKind').value;
    const env = [...document.querySelectorAll('#envList .env-row')].map((r) => [r.querySelector('.env-k').value.trim(), r.querySelector('.env-v').value]).filter(([key]) => key);
    const msg = { type, kind, original: editing ? editing.name : '', name: $('serverName').value.trim(), env };
    if (kind === 'mcp') { msg.commandLine = $('serverCommand').value; }
    else {
      const key = $('serverAuth').value === 'key';
      Object.assign(msg, {
        host: $('serverHost').value.trim(), port: Number($('serverPort').value), user: $('serverUser').value.trim(), auth: $('serverAuth').value,
        password: key ? '' : $('serverPassword').value, key: key ? $('serverKey').value : '', passphrase: key ? $('serverPassphrase').value : '',
        notes: $('serverNotes').value,
      });
    }
    return msg;
  }
  $('dialogSave').onclick = () => {
    $('serverErr').textContent = ''; $('dialogSave').disabled = true;
    post(serverForm('saveServer'));
  };
  $('serverTestBtn').onclick = () => {
    if (testing || $('serverKind').value !== 'linux') { return; }
    testing = true; $('serverTestBtn').disabled = true; $('serverErr').textContent = '';
    setTestLine('Connecting…', 'busy');
    post(serverForm('testServer'));
  };
  function onServerTest(m) {
    if (!testing) { return; }   // the dialog was closed or reopened while the test ran
    testing = false; $('serverTestBtn').disabled = false;
    setTestLine(m.ok ? (m.text || 'Connected.') : (m.text || 'Could not connect.'), m.ok ? 'ok' : 'fail');
    markField(m.ok ? undefined : m.field);
  }
  /** Highlights the field a validation error belongs to, and moves the cursor there. */
  const FIELD_IDS = { name: 'serverName', host: 'serverHost', port: 'serverPort', user: 'serverUser', auth: 'serverAuth', password: 'serverPassword', key: 'serverKey', notes: 'serverNotes', command: 'serverCommand', env: 'envList' };
  function markField(field) {
    document.querySelectorAll('#serverDialog .invalid').forEach((el) => { el.classList.remove('invalid'); el.removeAttribute('aria-invalid'); });
    const el = field && $(FIELD_IDS[field]);
    if (!el) { return; }
    el.classList.add('invalid'); el.setAttribute('aria-invalid', 'true');
    el.scrollIntoView({ block: 'nearest' });
    if (el.focus) { el.focus(); }
  }
  $('serverDialog').addEventListener('input', (e) => { if (e.target.classList && e.target.classList.contains('invalid')) { e.target.classList.remove('invalid'); e.target.removeAttribute('aria-invalid'); } });
  function onServerResult(m) {
    if (m.ok) { markField(); closeServerDialog(); return; }
    $('serverErr').textContent = m.error || 'Could not save the server.'; $('dialogSave').disabled = false;
    markField(m.field);
  }

  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'data') { data = m; renderLlm(); renderSessions(); renderSkillList(); renderServerList(); }
    else if (m.type === 'verifying') { $('verify').innerHTML = '<div class="muted">Checking…</div>'; }
    else if (m.type === 'verifyResult') { renderVerify(m); }
    else if (m.type === 'serverResult') { onServerResult(m); }
    else if (m.type === 'serverTest') { onServerTest(m); }
  });
  setInterval(() => { if (data.sessions.some((s) => s.agents.some((a) => a.startedAt))) { renderSessions(); } }, 1000);
  post({ type: 'ready' });
})();
