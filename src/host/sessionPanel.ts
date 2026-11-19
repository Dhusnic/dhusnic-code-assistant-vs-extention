import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { ImageInput, OcrOutcome, decodeDataUrl, screenshotBlock, validateImages } from '../core/attachments';
import { buildSessionHtml } from '../core/html';
import { AgentSnapshot, summarizeSession } from '../core/handoff';
import { expandMentions } from '../core/mentions';
import { ocrImage } from '../core/ocr';
import { clampMode } from '../core/centralPolicy';
import { EFFORT_INFO, MODES, MODE_INFO, Mode, isEffort, isMode } from '../core/policy';
import { UiEvent } from '../core/runtime';
import { COMMANDS, SlashApi, parseSlash, runSlash } from '../core/slash';
import { SKILL_TEMPLATE, expandSkill, findSkill, validateNewSkill } from '../core/skills';
import { DIFF_SCHEME } from './diffProvider';
import type { Hub } from './hub';

/**
 * One editor tab = one session = one main conversation (Claude-style). Sub-agents launched from it can be watched
 * live in the same tab; any number of tabs can run in parallel.
 */
/** Slash commands that only show or change settings, so they are fine while the agent works. */
const SAFE_WHILE_BUSY = new Set(['help', 'mode', 'effort', 'model', 'permissions', 'changes', 'audit', 'history', 'search', 'export', 'skills', 'agents', 'mcp', 'memory', 'schedule']);

export class SessionPanel {
  focused: string;
  private lastTitle = '';
  private headerTimer?: NodeJS.Timeout;

  constructor(private hub: Hub, readonly panel: vscode.WebviewPanel, readonly sid: string, private prefill?: string, private skillsView?: 'list' | 'new' | 'ai') {
    this.focused = hub.manager.session(sid).main().id;
    panel.iconPath = vscode.Uri.joinPath(hub.media, 'icon.png');
    panel.webview.options = { enableScripts: true, localResourceRoots: [hub.media] };
    void this.render();
    panel.webview.onDidReceiveMessage((m) => void this.onMessage(m).catch((e) => this.info(`Error: ${e.message ?? e}`, true)));
    const onSkills = () => { this.post({ type: 'state', state: this.uiState() }); this.post({ type: 'skills', items: this.hub.skillViews(), errors: this.hub.skillErrors }); };
    hub.skillListeners.add(onSkills);
    panel.onDidDispose(() => { clearTimeout(this.headerTimer); hub.skillListeners.delete(onSkills); hub.panelClosed(sid); });
    this.refreshTitle();
  }

  private get mgr() { return this.hub.manager; }
  private get mainId(): string { return this.mgr.session(this.sid).main().id; }

  private async render(): Promise<void> {
    const w = this.panel.webview;
    const u = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.hub.media, f)).toString();
    w.html = buildSessionHtml({
      nonce: randomBytes(16).toString('hex'), cspSource: w.cspSource,
      logoSvg: await fs.readFile(vscode.Uri.joinPath(this.hub.media, 'logo.svg').fsPath, 'utf8'),
      cssUri: u('chat.css'), jsUri: u('session.js'), mdUri: u('md.js'), mermaidUri: u('vendor/mermaid.min.js'), probeUri: u('probe.js'),
    });
  }

  post(m: unknown): void { void this.panel.webview.postMessage(m); }
  private info(text: string, error = false): void { this.post({ type: 'info', text, error, transient: true }); }

  /* ------------------------------------------------------------ host → view */

  onAgentEvent(aid: string, ev: UiEvent): void {
    if (ev.type === 'end') { this.refreshHeader(); }
    if (aid === this.focused) {
      this.post(ev.type === 'agentSettings' ? { type: 'state', state: this.uiState() } : ev);
    }
  }

  /** Branch name and pending-review count; the git and review code loads shortly after the tab opens. */
  private refreshHeader(): void {
    clearTimeout(this.headerTimer);
    this.headerTimer = setTimeout(() => {
      void import('./features/workbench').then((w) => w.headerInfo(this.hub, this.sid)).then((h) => this.post({ type: 'gitInfo', ...h })).catch(() => undefined);
    }, 700);
  }

  private featurePanel() {
    return { sid: this.sid, info: (t: string, e?: boolean) => this.info(t, e), post: (m: unknown) => this.post(m), send: (p: string, d: string) => this.dispatch(p, d, []) };
  }

  refreshAgents(): void {
    if (!this.mgr.sessions.has(this.sid)) { return; }
    const s = this.mgr.session(this.sid);
    this.post({ type: 'agents', focused: this.focused, mainId: s.main().id, title: s.title || 'New session', agents: [...s.agents.values()].map((a) => a.view()) });
    this.refreshTitle();
  }

  private refreshTitle(): void {
    const s = this.mgr.sessions.get(this.sid);
    const busy = s ? [...s.agents.values()].some((a) => a.busy) : false;
    const title = `${busy ? '● ' : ''}${s?.title || 'New session'}`;
    if (title !== this.lastTitle) { this.panel.title = title.length > 40 ? `${title.slice(0, 39)}…` : title; this.lastTitle = title; }
  }

  private uiState() {
    const rt = this.mgr.agent(this.sid, this.focused);
    return {
      ...rt.settings, models: this.hub.models, modeInfo: MODE_INFO, effortInfo: EFFORT_INFO, commands: [...COMMANDS, ...this.hub.skills.filter((s) => s.userInvocable && !COMMANDS.some((c) => c.name === s.name)).map((s) => ({ name: s.name, description: s.description, args: s.argumentHint, skill: true, source: s.source }))],
      sessionId: this.sid, agentId: this.focused, mainId: this.mainId, viewingSub: rt.role === 'sub',
      focusedAgent: { name: rt.name, type: rt.type, description: rt.description, status: rt.status, outcome: rt.outcome },
      agentTypes: this.hub.agentTypes.map((t) => ({ name: t.name, description: t.description, readOnly: !!t.readOnly, source: t.source })),
      contextLimit: this.hub.cfg.get<number>('contextWindow', 262144), e2e: this.hub.e2e,
    };
  }

  private replay(): void {
    const { events, view, queue } = this.mgr.transcript(this.sid, this.focused);
    const bookmarks = this.mgr.agent(this.sid, this.focused).bookmarks;
    this.post({ type: 'replay', agentId: this.focused, events, view, bookmarks, queue, state: this.uiState() });
    this.refreshAgents();
  }

  private focus(aid: string): void {
    if (!this.mgr.session(this.sid).agents.has(aid)) { return; }
    this.focused = aid;
    this.replay();
  }

  /* ------------------------------------------------------------ view → host */

  private async onMessage(m: any): Promise<void> {
    const mgr = this.mgr;
    switch (m.type) {
      case '__probeResult': this.hub.resolveProbe(m.id, m.result); return;
      case '__error': this.hub.logWebviewError(`session ${this.sid}`, m); return;
      case 'ready': {
        const logo = await fs.readFile(vscode.Uri.joinPath(this.hub.media, 'logo.svg').fsPath, 'utf8');
        this.post({ type: 'init', logo: logo.replace('<svg ', '<svg class="logo" '), state: this.uiState() });
        this.replay();
        if (this.prefill) { this.post({ type: 'prefill', text: this.prefill }); this.prefill = undefined; }
        if (this.skillsView) { this.showSkills(this.skillsView); this.skillsView = undefined; }
        void this.hub.ensureMcp();
        this.refreshHeader();
        if (!this.hub.models.length) { void this.hub.checkHealth().then(() => this.post({ type: 'state', state: this.uiState() })); }
        break;
      }
      case 'send': await this.handleSend(String(m.text ?? ''), m.images); break;
      case 'stop': mgr.stop(this.sid, this.focused); break;
      case 'unqueue': {
        const item = mgr.unqueue(this.sid, this.focused, String(m.id));
        if (item && m.edit) { this.post({ type: 'prefill', text: item.display }); }
        break;
      }
      case 'stopAgent': if (mgr.session(this.sid).agents.has(m.id)) { mgr.stop(this.sid, m.id); } break;
      case 'approval': mgr.resolveApproval(this.sid, this.focused, m.id, !!m.ok, isMode(m.setMode) ? m.setMode : undefined); break;
      case 'answer': mgr.resolveQuestion(this.sid, this.focused, String(m.id), m.answers === null ? null : m.answers); break;
      case 'planDecision': mgr.resolveApproval(this.sid, this.focused, m.id, isMode(m.mode) && m.mode !== 'plan' ? m.mode : null); break;
      case 'setMode': if (isMode(m.value)) { this.setSetting({ mode: m.value }); } break;
      case 'cycleMode': { const cur = mgr.agent(this.sid, this.focused).settings.mode; this.setSetting({ mode: MODES[(MODES.indexOf(cur) + 1) % MODES.length] }); break; }
      case 'setEffort': if (isEffort(m.value)) { this.setSetting({ effort: m.value }); } break;
      case 'setModel': if (typeof m.value === 'string') { this.setSetting({ model: m.value }); } break;
      case 'refreshModels': await this.hub.checkHealth(); this.post({ type: 'state', state: this.uiState() }); break;
      case 'viewAgent': this.focus(String(m.id)); break;
      case 'backToMain': this.focus(this.mainId); break;
      case 'spawnAgent': {
        const r = await mgr.spawnFromUser(this.sid, String(m.agentType || 'general-purpose'), String(m.prompt ?? '').trim());
        if (!r.ok) { this.info(r.text, true); }
        break;
      }
      case 'removeAgent': await this.removeAgent(String(m.id)); break;
      case 'renameSession': await this.hub.renameSession(this.sid); break;
      case 'setTitle': {
        const t = String(m.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (t) { mgr.rename(this.sid, t); this.refreshAgents(); this.hub.scheduleRefresh(); }
        break;
      }
      case 'rewind': await mgr.rewind(this.sid, this.focused, Number(m.turn)); break;
      case 'openDiff': await this.openDiff(String(m.id)); break;
      case 'queryFiles': this.post({ type: 'files', req: m.req, items: await this.hub.files(String(m.q ?? '')) }); break;
      case 'newSession': await this.hub.newSession(); break;
      case 'openSidebar': await vscode.commands.executeCommand('infraonAssistant.sessions.focus'); break;
      case 'bookmark': {
        const b = { turn: Number(m.turn), hash: String(m.hash ?? ''), preview: String(m.preview ?? '') };
        if (Number.isInteger(b.turn) && b.hash) { mgr.setBookmark(this.sid, this.focused, b, !!m.on); }
        this.post({ type: 'bookmarks', items: mgr.bookmarks(this.sid) });
        break;
      }
      case 'listBookmarks': this.post({ type: 'bookmarks', items: mgr.bookmarks(this.sid) }); break;
      case 'gotoBookmark':
        if (m.agentId !== this.focused) { this.focus(String(m.agentId)); }
        this.post({ type: 'scrollTo', turn: m.turn, hash: m.hash });
        break;
      case 'summarize': await this.summarize(); break;
      case 'startWithHandoff': if (typeof m.text === 'string' && m.text.trim()) { await this.hub.newSession(m.text); } break;
      case 'listSkills': this.post({ type: 'skills', items: this.hub.skillViews(), errors: this.hub.skillErrors, template: SKILL_TEMPLATE }); break;
      case 'createSkill': {
        const input = m.skill ?? {};
        const err = validateNewSkill(input);
        if (err) { this.post({ type: 'skillResult', ok: false, error: err }); break; }
        try {
          await this.hub.createSkill(m.scope === 'personal' ? 'personal' : 'project', {
            name: String(input.name), description: String(input.description), instructions: String(input.instructions),
            argumentHint: input.argumentHint ? String(input.argumentHint) : undefined,
            allowedTools: Array.isArray(input.allowedTools) ? input.allowedTools.map(String) : undefined,
            modelInvocable: input.modelInvocable !== false, userInvocable: input.userInvocable !== false,
          });
          this.post({ type: 'skillResult', ok: true, name: input.name });
        } catch (e: any) { this.post({ type: 'skillResult', ok: false, error: e.message ?? String(e) }); }
        break;
      }
      case 'getSkill': try { this.post({ type: 'skillDetail', skill: this.hub.skillDetail(String(m.name)) }); } catch (e: any) { this.info(e.message, true); } break;
      case 'lintSkill': this.post({ type: 'skillLint', req: m.req, issues: this.hub.lintDraft(m.skill ?? {}, m.originalName ? String(m.originalName) : undefined) }); break;
      case 'updateSkill': {
        const input = m.skill ?? {};
        try {
          await this.hub.editSkill(String(m.originalName), {
            name: String(input.name ?? ''), description: String(input.description ?? ''), instructions: String(input.instructions ?? ''),
            argumentHint: input.argumentHint ? String(input.argumentHint) : undefined,
            allowedTools: Array.isArray(input.allowedTools) ? input.allowedTools.map(String) : undefined,
            modelInvocable: input.modelInvocable !== false, userInvocable: input.userInvocable !== false,
          });
          this.post({ type: 'skillResult', ok: true, name: input.name, updated: true });
        } catch (e: any) { this.post({ type: 'skillResult', ok: false, error: e.message ?? String(e) }); }
        break;
      }
      case 'copySkill':
        try {
          await this.hub.duplicateSkill(String(m.name), m.scope === 'personal' ? 'personal' : 'project', m.newName ? String(m.newName) : undefined);
          this.info(`Copied /${m.name} to ${m.scope === 'personal' ? 'your personal skills (~/.claude/skills)' : 'the project (.claude/skills — commit it to share with the team)'}.`);
        } catch (e: any) { this.info(e.message ?? String(e), true); }
        break;
      case 'addSkillFile':
        try { await this.hub.addFileToSkill(String(m.name), String(m.path ?? ''), String(m.content ?? '')); this.post({ type: 'skillDetail', skill: this.hub.skillDetail(String(m.name)) }); }
        catch (e: any) { this.post({ type: 'skillFileError', error: e.message ?? String(e) }); }
        break;
      case 'testSkill': await this.handleSend(`/${String(m.name)}${m.args ? ` ${String(m.args)}` : ''}`, []); break;
      case 'toggleSkill': try { await this.hub.toggleSkill(String(m.name), !!m.enabled); } catch (e: any) { this.info(e.message, true); } break;
      case 'deleteSkill': await this.hub.removeSkill(String(m.name)); break;
      case 'editSkill': await this.hub.openSkill(String(m.name)); break;
      case 'revealSkill': await this.hub.openSkill(String(m.name), true); break;
      case 'aiCreateSkill': {
        const what = String(m.description ?? '').trim();
        if (!what) { break; }
        const base = '.claude/skills';
        await this.dispatch(`Create a new skill for this workspace.

What the skill should do: ${what}

Write it to ${base}/<name>/SKILL.md, choosing a short lowercase-hyphen name, in exactly this format:
---
name: <name>
description: <one or two sentences saying what it does AND when to use it; this is how the skill gets picked>
argument-hint: <optional, e.g. "[work item id]">
---
# Goal
# Steps   (specific files, commands and tools for THIS repository)
# Rules
# Output

Look at the code first if that helps make the steps concrete. If anything important is unclear, ask me with ask_user_question before writing. Keep it concise. When done, tell me the skill's name and how to run it (/<name>).`, `Create a skill: ${what}`, []);
        break;
      }
      case 'contextDetails': this.post({ type: 'contextDetails', data: this.contextDetails() }); break;
      case 'openChanges': await this.feature('changes', ''); break;
      case 'changeAction': { const w = await import('./features/workbench'); await w.changeAction(this.hub, this.featurePanel(), m); this.refreshHeader(); break; }
      case 'doCommit': { const w = await import('./features/workbench'); await w.doCommit(this.hub, this.featurePanel(), String(m.message ?? ''), String(m.source ?? '')); this.refreshHeader(); break; }
    }
  }

  /** Builds the copy-pasteable handoff summary of this whole session (main conversation + sub-agents). */
  private async summarize(): Promise<void> {
    const s = this.mgr.session(this.sid);
    const snapshots: AgentSnapshot[] = [...s.agents.values()].map((a) => ({
      id: a.id, role: a.role, name: a.name, type: a.type, description: a.description, outcome: a.outcome, result: a.result,
      history: a.agent.exportState().history, todos: a.todos,
    }));
    try {
      const main = s.main();
      const r = await summarizeSession(s.title || 'Untitled session', snapshots, this.hub.llmFor(this.sid), await this.hub.llmConfig(this.hub.routeModel('summary', main.settings.model)), new AbortController().signal, this.hub.root);
      this.post({ type: 'handoff', text: r.text, usedLlm: r.usedLlm, error: r.error, files: r.facts.files.length, commands: r.facts.commands.length });
    } catch (e: any) {
      this.post({ type: 'handoff', error: e.message ?? String(e) });
    }
  }

  showSkills(view: 'list' | 'new' | 'ai' = 'list'): void { this.post({ type: 'openSkills', view }); }

  private contextDetails() {
    const rt = this.mgr.agent(this.sid, this.focused);
    const limit = this.hub.cfg.get<number>('contextWindow', 131072);
    const ratio = this.hub.cfg.get<number>('autoCompactThreshold', 0.75);
    const b = rt.agent.contextBreakdown(limit, ratio);
    return {
      ...b, model: rt.settings.model, agentName: rt.role === 'main' ? 'Main conversation' : `${rt.type} · ${rt.description}`,
      memoryFile: this.hub.memoryFile ? { name: this.hub.memoryFile.name, tokens: Math.ceil(this.hub.memoryFile.chars / 3.5) } : null,
      mcp: this.hub.mcpBreakdown(), compactAt: Math.round(limit * ratio),
    };
  }

  private async feature(name: string, args: string): Promise<void> {
    const w = await import('./features/workbench');
    await w.runFeature(this.hub, this.featurePanel(), name, args);
  }

  private setSetting(p: Partial<{ mode: Mode; effort: any; model: string }>): void {
    if (p.mode) { p = { ...p, mode: clampMode(this.hub.policy, p.mode) }; }
    this.mgr.setSettings(this.sid, this.focused, p);
    this.hub.setDefaults(p);
    this.post({ type: 'state', state: this.uiState() });
  }

  private async removeAgent(aid: string): Promise<void> {
    const rt = this.mgr.agent(this.sid, aid);
    const ok = await vscode.window.showWarningMessage(`Remove the sub-agent "${rt.description ?? rt.name}" and its transcript?`, { modal: true }, 'Remove');
    if (ok !== 'Remove') { return; }
    try {
      await this.mgr.removeAgent(this.sid, aid);
      if (this.focused === aid) { this.focus(this.mainId); } else { this.refreshAgents(); }
    } catch (e: any) { this.info(e.message, true); }
  }

  private async openDiff(id: string): Promise<void> {
    const pv = this.mgr.preview(this.sid, this.focused, id);
    if (!pv) { return; }
    const base = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${this.sid}/${this.focused}/${id}/${pv.path}` });
    const left = base.with({ query: 'original' }), right = base.with({ query: 'proposed' });
    this.hub.diffs.set(left, pv.oldText);
    this.hub.diffs.set(right, pv.newText);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(pv.path)} (proposed changes)`);
  }

  /* ------------------------------------------------------------ sending */

  private slashApi(): SlashApi {
    const mgr = this.mgr;
    const rt = () => mgr.agent(this.sid, this.focused);
    return {
      info: (text) => this.info(text),
      newChat: () => { void this.hub.newSession(); },
      undo: async () => {
        if (rt().agent.turnCount === 0) { this.info('Nothing to undo.'); return; }
        await mgr.rewind(this.sid, this.focused, rt().agent.turnCount - 1);
      },
      compact: async () => {
        if (rt().agent.turnCount < 2) { this.info('Nothing to compact yet.'); return; }
        await mgr.compact(this.sid, this.focused);
      },
      mcp: async (args) => { if (args.trim() === 'reload') { await this.hub.loadMcp(); } this.info(this.hub.mcpReport()); },
      skills: () => { this.post({ type: 'openSkills' }); },
      agents: () => {
        const types = this.hub.agentTypes.map((t) => `• ${t.name}${t.readOnly ? ' (read-only)' : ''}${t.source !== 'builtin' ? ` [${t.source}]` : ''}: ${t.description}`);
        const subs = [...mgr.session(this.sid).agents.values()].filter((a) => a.role === 'sub')
          .map((a) => `• ${a.id} ${a.type} — ${a.description}: ${a.busy ? a.status : a.outcome ?? a.status}`);
        const errors = this.hub.agentTypeErrors.map((e) => `! ${e}`);
        this.info([`Agent types (add your own in .claude/agents/*.md or .infraon/agents/*.md):`, ...types, '', subs.length ? 'Sub-agents in this session:' : 'No sub-agents in this session yet.', ...subs, ...errors].join('\n'));
      },
      openHistory: () => { void vscode.commands.executeCommand('infraonAssistant.sessions.focus'); },
      setMode: (m) => this.setSetting({ mode: m }),
      setEffort: (e) => this.setSetting({ effort: e }),
      setModel: (n) => this.setSetting({ model: n }),
      currentModel: () => rt().settings.model,
      models: () => this.hub.models,
      send: (prompt, display) => this.dispatch(prompt, display ?? prompt, []),
      feature: (name, args) => this.feature(name, args),
    };
  }

  private async handleSend(text: string, images: unknown): Promise<void> {
    if (this.focused !== this.mainId) {
      this.info('Sub-agents are steered by the main conversation. Go back to Main to send a message (the main agent can use send_message to instruct this agent).', true);
      return;
    }
    const imgs = validateImages(images);
    if (imgs.errors.length) { this.info(`Some images were skipped: ${imgs.errors.join('; ')}`, true); }
    if (!imgs.ok.length) {
      const slash = parseSlash(text);
      const skill = slash && !slash.known ? findSkill(this.hub.skills, slash.name) : undefined;
      if (slash && skill) {
        if (!skill.userInvocable) { this.info(`/${skill.name} is configured to be used by the agent only (user-invocable: false).`, true); return; }
        await this.dispatch(`The user ran the skill /${skill.name}${slash.args ? ` with arguments: ${slash.args}` : ''}. Follow its instructions now.\n\n${expandSkill(skill, slash.args)}`, `/${skill.name}${slash.args ? ` ${slash.args}` : ''}`, []);
        return;
      }
      if (slash && slash.known && this.mgr.agent(this.sid, this.focused).busy && !SAFE_WHILE_BUSY.has(slash.name)) {
        this.info(`/${slash.name} cannot run while the agent is working. Wait for it or press Stop.`, true);
        return;
      }
      if (slash) { await runSlash(slash, this.slashApi()); return; }
    }
    if (!text.trim() && !imgs.ok.length) { return; }
    const exp = await expandMentions(text, this.hub.root);
    if (exp.missing.length) { this.info(`Could not attach: ${exp.missing.join(', ')}`); }
    let prompt = exp.text;
    if (imgs.ok.length) {
      this.info(`Reading text from ${imgs.ok.length} screenshot${imgs.ok.length > 1 ? 's' : ''} (local OCR)…`);
      prompt += screenshotBlock(await this.ocrAll(imgs.ok));
    }
    const display = text.trim() || '(screenshot)';
    await this.dispatch(prompt || display, display, [...exp.files, ...imgs.ok.map((i) => `🖼 ${i.name}`)], imgs.ok.map((i) => i.thumb).filter((t): t is string => !!t));
  }

  private async ocrAll(images: ImageInput[]): Promise<OcrOutcome[]> {
    return Promise.all(images.map(async (img): Promise<OcrOutcome> => {
      try {
        const { buf, ext } = decodeDataUrl(img.dataUrl);
        return { name: img.name, text: await ocrImage(this.hub.ctx.extensionUri.fsPath, buf, ext) };
      } catch (e: any) { return { name: img.name, error: e.message ?? String(e) }; }
    }));
  }

  private async dispatch(prompt: string, display: string, files: string[], thumbs: string[] = []): Promise<void> {
    try {
      const r = this.mgr.sendOrQueue(this.sid, this.focused, prompt, { display, files, thumbs });
      if (!r.queued) { await r.run; }
    } catch (e: any) {
      this.info(e.message ?? String(e), true);
    }
  }
}
