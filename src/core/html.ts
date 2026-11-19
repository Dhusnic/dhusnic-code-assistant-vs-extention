export interface HtmlParts { nonce: string; cspSource: string; cssUri: string; jsUri: string; mdUri: string; logoSvg: string; mermaidUri?: string; probeUri?: string }

const ARROW_UP = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5l5 5-1.1 1.1L8.8 5.5V13.5H7.2V5.5L4.1 8.6 3 7.5z"/></svg>';
const STOP = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2"/></svg>';
const CHEVRON = '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M3 6l5 5 5-5z"/></svg>';
const LIST = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12v1.3H2zm0 4.35h12v1.3H2zm0 4.35h12V13H2z"/></svg>';
const PLUS = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M7.35 2h1.3v5.35H14v1.3H8.65V14h-1.3V8.65H2v-1.3h5.35z"/></svg>';
const SUMMARY = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 1.8h5.5L12.5 5v9.2H4z"/><path d="M9.3 1.8V5h3.2M6 8h4.5M6 10.3h4.5M6 12.5h2.8"/></svg>';
const BOLT = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M9 1.5L3.5 9h4L7 14.5 12.5 7h-4z"/></svg>';
const BOOKMARK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 2.5h8v11l-4-2.8-4 2.8z"/></svg>';
const PENCIL = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.2.7.7-3.2z"/><path d="M9.4 4.1l2.5 2.5"/></svg>';
const FILES = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.5 1.8h6L12.5 5v9.2h-9z"/><path d="M8 6.5v4M6 8.5h4"/></svg>';
const CLIP ='<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10.5 4.5l-5 5a1.5 1.5 0 002 2l5.5-5.5a3 3 0 00-4-4L3.5 7.5a4.5 4.5 0 006.5 6.5l4-4"/></svg>';
const SERVER = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 6h4M6 9h4"/></svg>';
const KEY = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M12.5 4.5a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z"/><path d="M8 7v2.5a3.5 3.5 0 003.5 3.5h1.5"/></svg>';
const EYE = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1 8s4-5 7-5 7 5 7 5-4 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2.5"/></svg>';
const EYE_OFF = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1 1l14 14"/><path d="M10.5 5.5A4.5 4.5 0 0114.5 8c0 2-4 5-7 5a7 7 0 01-4.5-1.5"/><path d="M5 5.5a3.5 3.5 0 015 5"/><circle cx="8" cy="8" r="1"/></svg>';
const EDIT = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M11.5 3.5l1 1L8.5 9.5 6.5 9l2-2 3-3z"/><path d="M12.5 2.5l1 1 1-1-1-1z"/></svg>';
const DELETE = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 4h10M5 4V2h6v2M6 4v10M10 4v10M3 4v10a2 2 0 002 2h8a2 2 0 002-2V4"/></svg>';
const CLONE = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="3" width="9" height="9" rx="2"/><rect x="5" y="9" width="9" height="9" rx="2"/></svg>';
const PLUS_SMALL = '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M7.35 2h1.3v5.35H14v1.3H8.65V14h-1.3V8.65H2v-1.3h5.35z"/></svg>';

/**
 * CSP: scripts only via nonce. Inline styles are allowed because Mermaid writes <style> into its SVGs;
 * images only from the extension or data: URLs (pasted screenshots).
 */
function head(p: HtmlParts): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${p.cspSource} 'unsafe-inline'; img-src ${p.cspSource} data:; font-src ${p.cspSource}; script-src 'nonce-${p.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${p.cssUri}">
</head>`;
}

/** Mermaid (3.5 MB) is not loaded here: session.js fetches it from body[data-mermaid] when the first diagram appears. */
const scripts = (p: HtmlParts): string =>
  `${p.probeUri ? `<script nonce="${p.nonce}" src="${p.probeUri}"></script>\n` : ''}<script nonce="${p.nonce}" src="${p.mdUri}"></script>
<script nonce="${p.nonce}" src="${p.jsUri}"></script>`;

/** One editor tab = one session (with any number of agents). */
export function buildSessionHtml(p: HtmlParts): string {
  const logo = p.logoSvg.replace('<svg ', '<svg class="logo" ');
  return `${head(p)}<body class="session"${p.mermaidUri ? ` data-mermaid="${p.mermaidUri}"` : ''}>
<div id="hdr" class="compact">${logo}<span class="title" id="title" title="Click to rename">New session</span><button class="icon-btn title-edit" id="titleEdit" title="Rename session">${PENCIL}</button><span class="branch-tag" id="branchTag" hidden></span>
  <button class="agent-btn" id="agentBtn" title="Agents in this session" aria-haspopup="menu"><span class="dot"></span><span id="agentName">Agent 1</span><span class="badge" id="agentCount"></span>${CHEVRON}</button>
  <div id="ctxRing" class="ring" title="Context usage" role="img" aria-label="Context usage"><svg viewBox="0 0 36 36"><circle class="track" cx="18" cy="18" r="15.5"/><circle class="arc" id="ctxArc" cx="18" cy="18" r="15.5"/></svg><span id="ctxPct">0%</span></div>
  <button class="icon-btn hdr-icon changes-btn" id="changesBtn" title="Review the files this session changed">${FILES}<span class="badge" id="changesCount" hidden></span></button>
  <button class="icon-btn hdr-icon" id="sumBtn" title="Summarize this session: a handoff you can paste into a new session">${SUMMARY}</button>
  <button class="icon-btn hdr-icon" id="bmBtn" title="Bookmarked replies">${BOOKMARK}</button>
  <button class="icon-btn hdr-icon" id="sidebarBtn" title="Session manager">${LIST}</button>
  <button class="icon-btn hdr-icon" id="newBtn" title="New session in a new tab (Ctrl+Alt+N)">${PLUS}</button></div>
<div id="activity"></div>
<div id="subBanner"></div>
<div id="log"></div>
<div id="composer">
  <div id="queued" hidden></div>
  <div id="attach"></div>
  <textarea id="in" rows="2" placeholder="Ask anything, @ to mention a file, / for commands, paste a screenshot"></textarea>
  <div id="tools">
    <button class="pill" id="clipBtn" title="Attach screenshots or images">${CLIP}</button>
    <button class="pill" id="skillsPill" title="Skills: create, manage and run (/skills)">${BOLT}<span>Skills</span></button>
    <button class="pill" id="modePill" title="Permission mode (Shift+Tab to cycle)"><span>Ask before edits</span>${CHEVRON}</button>
    <button class="pill" id="effortPill" title="Reasoning effort"><span>Effort: Medium</span>${CHEVRON}</button>
    <button class="pill" id="modelPill" title="Model"><span>Model</span>${CHEVRON}</button>
    <span class="spacer"></span>
    <button id="stop" title="Stop this agent">${STOP}</button>
    <button id="send" title="Send (Enter)">${ARROW_UP}</button>
  </div>
  <input type="file" id="file" accept="image/*" multiple hidden>
</div>
${scripts(p)}
</body></html>`;
}

/** Activity-bar view: LLM status/usage + the session manager. */
export function buildSidebarHtml(p: HtmlParts): string {
  const logo = p.logoSvg.replace('<svg ', '<svg class="logo" ');
  return `${head(p)}<body class="sidebar">
<div id="hdr">${logo}<span class="title">Infraon Assistant</span><button class="icon-btn" id="refreshBtn" title="Refresh">⟳</button></div>
<section id="llmSec" class="sec open"><h3 class="sec-h" data-sec="llmSec">LLM</h3><div class="sec-b" id="llm"></div></section>
<section id="sessSec" class="sec open"><h3 class="sec-h" data-sec="sessSec">Session manager</h3><div class="sec-b">
  <button class="newsess" id="newSession">＋ New session</button>
  <div class="filters"><button class="seg active" data-filter="all">All</button><button class="seg" data-filter="active" id="activeSeg">Active</button>
    <input id="search" type="search" placeholder="Search sessions"></div>
  <button class="link" id="deepSearch">Search inside all conversations…</button>
  <div id="list"></div></div></section>
<section id="skillSec" class="sec open"><h3 class="sec-h" data-sec="skillSec">Skills</h3><div class="sec-b">
  <div class="sk-sbar"><button class="link" id="skNewSide">＋ New skill</button><button class="link" id="skManageSide">Manage…</button></div>
  <div id="skillList"></div></div></section>
<section id="serverSec" class="sec open"><h3 class="sec-h" data-sec="serverSec"><span class="icon">${SERVER}</span> Servers</h3><div class="sec-b">
  <div class="server-bar">
    <button class="btn sec-btn" id="addServerBtn">＋ Add Server</button>
  </div>
  <div id="serverList"></div>
</div></section>
<section id="storeSec" class="sec"><h3 class="sec-h" data-sec="storeSec">Storage</h3><div class="sec-b">
  <p class="muted">Checks that every saved session can be read back, repairs what it can, and runs a write → read → compare self-test.</p>
  <button class="btn sec-btn" id="verifyBtn">Check storage</button><div id="verify"></div></div></section>

<!-- Server Dialog -->
<div id="serverDialog" class="dialog-overlay" hidden>
  <div class="dialog-content">
    <div class="dialog-header">
      <h3 id="dialogTitle">Add Server</h3>
      <button class="icon-btn dialog-close" id="dialogClose">✕</button>
    </div>
    <div class="dialog-body">
      <div class="form-group">
        <label for="serverName">Server Name</label>
        <input type="text" id="serverName" placeholder="e.g., github, openai" required>
      </div>
      <div class="form-group">
        <label for="serverCommand">Command</label>
        <input type="text" id="serverCommand" placeholder="e.g., npx" required>
      </div>
      <div class="form-group">
        <label for="serverArgs">Arguments (optional)</label>
        <input type="text" id="serverArgs" placeholder="e.g., -y @modelcontextprotocol/server-github">
      </div>
      <div class="form-group">
        <label>Environment Variables</label>
        <div id="envList"></div>
        <button class="btn small" id="addEnvBtn">＋ Add Variable</button>
      </div>
    </div>
    <div class="dialog-footer">
      <button class="btn" id="dialogCancel">Cancel</button>
      <button class="btn primary" id="dialogSave">Save Server</button>
    </div>
  </div>
</div>
${scripts({ ...p, mermaidUri: undefined })}
</body></html>`;
}
