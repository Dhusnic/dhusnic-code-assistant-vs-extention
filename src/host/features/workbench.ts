import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ChangeSource, acceptAll, acceptFile, collectChanges, originalText, revertAll, revertFile } from '../../core/changes';
import { buildCommitMessages, cleanCommitMessage, commit, currentBranch, isGitRepo, mergeAgentWorktree, recentSubjects, removeAgentWorktree, stagedOrAllDiff, worktreeDiffStat } from '../../core/git';
import { createMemoryFile, listEditableMemory } from '../../core/memoryFiles';
import { exportSessionHtml, exportSessionMarkdown, searchSessions } from '../../core/sessionSearch';
import { expandSkill, findSkill } from '../../core/skills';
import { DIFF_SCHEME } from '../diffProvider';
import type { Hub } from '../hub';

/** Everything behind the on-demand slash commands. This module is loaded the first time one of them is used. */
export interface FeaturePanel { sid: string; info(text: string, error?: boolean): void; post(m: unknown): void; send(prompt: string, display: string): Promise<void> }

const SETTINGS_TEMPLATE = `{
  // Rules are checked on every tool call. deny wins over ask, and ask wins over allow.
  "permissions": {
    "allow": ["run_command(npm test*)"],
    "ask": ["run_command(git push*)"],
    "deny": ["run_command(rm -rf*)", "read(.env*)", "edit(.env*)"]
  },
  // Run your own scripts at set moments. Exit code 2 from a PreToolUse hook blocks the tool.
  "hooks": {}
}
`;

function sources(hub: Hub, sid: string): ChangeSource[] {
  return [...hub.manager.session(sid).agents.values()].filter((a) => !a.worktree).map((a) => ({ agentId: a.id, store: hub.checkpointsFor(sid, a.id) }));
}

export async function changesView(hub: Hub, sid: string) {
  const agents = [...hub.manager.session(sid).agents.values()];
  const label = (id: string) => { const a = agents.find((x) => x.id === id); return a?.role === 'sub' ? (a.description ?? a.name) : 'Main'; };
  const files = await collectChanges(hub.root, sources(hub, sid));
  const worktrees = await Promise.all(agents.filter((a) => a.worktree).map(async (a) => {
    const stat = await worktreeDiffStat(hub.root, a.worktree!).catch(() => ({ files: [], added: 0, removed: 0 }));
    return { agentId: a.id, name: a.description ?? a.name, branch: a.worktree!.branch, busy: a.busy, files: stat.files.length, added: stat.added, removed: stat.removed };
  }));
  return { files: files.map((f) => ({ ...f, agents: f.agents.map(label) })), worktrees };
}

/** Header details: current branch and how many files are waiting for review. */
export async function headerInfo(hub: Hub, sid: string): Promise<{ branch: string; changes: number }> {
  const branch = await isGitRepo(hub.root) ? await currentBranch(hub.root).catch(() => '') : '';
  const changes = hub.manager.sessions.has(sid) ? (await collectChanges(hub.root, sources(hub, sid)).catch(() => [])).length : 0;
  return { branch, changes };
}

async function confirm(message: string, action: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
}

async function diffUris(hub: Hub, sid: string, rel: string): Promise<[vscode.Uri, vscode.Uri] | undefined> {
  const abs = path.join(hub.root, rel);
  const original = await originalText(sources(hub, sid), abs);
  if (original === undefined) { return undefined; }
  const left = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${sid}/review/${rel.split(path.sep).join('/')}`, query: 'original' });
  hub.diffs.set(left, original);
  return [left, vscode.Uri.file(abs)];
}

/** Handles one action from the Changes panel, then sends the refreshed list. */
export async function changeAction(hub: Hub, panel: FeaturePanel, m: any): Promise<void> {
  const sid = panel.sid, rel = String(m.rel ?? ''), abs = path.join(hub.root, rel);
  const src = sources(hub, sid);
  const report = (results: Array<{ abs: string; ok: boolean; error?: string }>) => {
    const failed = results.filter((r) => !r.ok);
    if (failed.length) { panel.info(`${failed.length} file${failed.length === 1 ? '' : 's'} could not be changed: ${failed.map((f) => `${path.basename(f.abs)} (${f.error})`).join(', ')}`, true); }
  };
  switch (m.action) {
    case 'diff': {
      const uris = await diffUris(hub, sid, rel);
      if (!uris) { panel.info('This file is binary, so it has no text diff.', true); return; }
      await vscode.commands.executeCommand('vscode.diff', uris[0], uris[1], `${path.basename(rel)} (session changes)`);
      return;
    }
    case 'diffAll': {
      const { files } = await changesView(hub, sid);
      const rows = (await Promise.all(files.filter((f) => !f.binary).map(async (f) => ({ f, uris: await diffUris(hub, sid, f.rel) })))).filter((r) => r.uris);
      if (!rows.length) { panel.info('There are no text changes to show.'); return; }
      await vscode.commands.executeCommand('vscode.changes', 'Session changes', rows.map((r) => [vscode.Uri.file(r.f.abs), r.uris![0], r.uris![1]]));
      return;
    }
    case 'accept': await acceptFile(src, abs); break;
    case 'revert':
      if (!await confirm(`Revert ${rel} to how it was before this session?`, 'Revert')) { return; }
      await revertFile(src, abs, hub.root);
      break;
    case 'acceptAll': report(await acceptAll(hub.root, src)); break;
    case 'revertAll':
      if (!await confirm('Revert every file this session changed? This cannot be undone.', 'Revert all')) { return; }
      report(await revertAll(hub.root, src));
      break;
    case 'merge': case 'discard': await worktreeAction(hub, panel, m.action, String(m.agentId)); break;
  }
  panel.post({ type: 'changes', ...await changesView(hub, sid) });
}

async function worktreeAction(hub: Hub, panel: FeaturePanel, action: 'merge' | 'discard', aid: string): Promise<void> {
  const rt = hub.manager.agent(panel.sid, aid);
  if (!rt.worktree) { return; }
  if (rt.busy) { panel.info('Wait for this agent to finish first.', true); return; }
  if (action === 'discard') {
    if (!await confirm(`Discard all work on branch ${rt.worktree.branch}? This cannot be undone.`, 'Discard')) { return; }
    await removeAgentWorktree(hub.root, rt.worktree, { deleteBranch: true, force: true, timeoutMs: 120000 });
    rt.worktree = undefined;
    return;
  }
  const r = await mergeAgentWorktree(hub.root, rt.worktree, { timeoutMs: 120000 });
  if (!r.ok) {
    panel.info(r.conflicts.length ? `Merge stopped because of conflicts in ${r.conflicts.join(', ')}. Your workspace was left unchanged.` : `Merge did not run: ${r.detail ?? r.reason}.`, true);
    return;
  }
  await removeAgentWorktree(hub.root, rt.worktree, { deleteBranch: true, timeoutMs: 120000 });
  rt.worktree = undefined;
  panel.info('Agent work merged into your current branch.');
}

async function draftCommit(hub: Hub, panel: FeaturePanel): Promise<void> {
  if (!await isGitRepo(hub.root)) { panel.info('This workspace is not a git repository.', true); return; }
  const snap = await stagedOrAllDiff(hub.root);
  if (!snap.diff.trim()) { panel.info('There is nothing to commit.'); return; }
  panel.info('Writing a commit message…');
  const branch = await currentBranch(hub.root);
  const selected = hub.manager.session(panel.sid).main().settings.model;
  const cfg = await hub.llmConfig(hub.routeModel('commit', selected));
  const res = await hub.llmFor(panel.sid)({ ...cfg, maxTokens: 400 }, buildCommitMessages(snap.diff, await recentSubjects(hub.root), branch), [], () => undefined, new AbortController().signal);
  panel.post({ type: 'commitDraft', message: hub.safety.vault(panel.sid).restore(cleanCommitMessage(res.content)), branch, source: snap.source, truncated: snap.truncated });
}

export async function doCommit(hub: Hub, panel: FeaturePanel, message: string, source: string): Promise<void> {
  try {
    const r = await commit(hub.root, message, { stageAll: source !== 'staged', timeoutMs: 180000 });
    panel.info(`Committed ${r.sha.slice(0, 8)}: ${r.subject}`);
    panel.post({ type: 'commitDone' });
  } catch (e: any) { panel.post({ type: 'commitFailed', error: String(e.stderr || e.message || e).slice(0, 2000) }); }
}

/** Live full-text search across every saved session. */
export function searchPicker(hub: Hub, initial = ''): void {
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { id: string }>();
  qp.placeholder = 'Search the text of this workspace\'s saved sessions'; qp.matchOnDescription = true; qp.matchOnDetail = true; qp.value = initial;
  let ctl: AbortController | undefined, timer: NodeJS.Timeout | undefined;
  const run = (q: string) => {
    ctl?.abort(); clearTimeout(timer);
    if (q.trim().length < 2) { qp.items = []; qp.busy = false; return; }
    timer = setTimeout(() => {
      const c = ctl = new AbortController();
      qp.busy = true;
      // Only this window's workspace: other repos' sessions are neither searched nor shown.
      const include = async (sid: string) => hub.manager.sessions.has(sid) || (await hub.scope.ownership(sid)) !== 'other';
      searchSessions(hub.store.dir, q, { signal: c.signal, limit: 30, include }).then((hits) => {
        if (c.signal.aborted) { return; }
        qp.items = hits.map((h) => ({ id: h.sessionId, label: h.title || 'Untitled session', alwaysShow: true, description: new Date(h.updatedAt).toLocaleDateString(), detail: h.matches[0]?.snippet }));
        qp.busy = false;
      }, () => { if (!c.signal.aborted) { qp.busy = false; } });
    }, 200);
  };
  qp.onDidChangeValue(run);
  qp.onDidAccept(() => { const it = qp.selectedItems[0]; qp.hide(); if (it) { void hub.openSession(it.id); } });
  qp.onDidHide(() => { ctl?.abort(); clearTimeout(timer); qp.dispose(); });
  qp.show();
  if (initial) { run(initial); }
}

async function exportSession(hub: Hub, panel: FeaturePanel, format: string): Promise<void> {
  const html = format.trim().toLowerCase() === 'html';
  await hub.manager.shutdown();
  const loaded = await hub.store.loadSession(panel.sid);
  if (!loaded) { panel.info('Send a message first: there is nothing to export yet.', true); return; }
  const safe = (loaded.meta.title || 'session').replace(/[^\w -]+/g, '').trim().slice(0, 60) || 'session';
  const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(hub.root, `${safe}.${html ? 'html' : 'md'}`)), filters: html ? { HTML: ['html'] } : { Markdown: ['md'] } });
  if (!target) { return; }
  await fs.writeFile(target.fsPath, html ? exportSessionHtml(loaded) : exportSessionMarkdown(loaded), 'utf8');
  panel.info(`Saved to ${target.fsPath}`);
}

export async function editMemory(hub: Hub): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  const active = ed?.document.uri.scheme === 'file' ? path.relative(hub.root, ed.document.uri.fsPath).split(path.sep).join('/') : undefined;
  const files = await listEditableMemory(hub.root, os.homedir(), active && !active.startsWith('..') ? active : undefined);
  const pick = await vscode.window.showQuickPick(files.map((f) => ({ label: f.rel, description: `${f.level}${f.exists ? '' : ' · create new'}`, file: f })), { placeHolder: 'Choose a memory file to edit' });
  if (!pick) { return; }
  if (!pick.file.exists) { await createMemoryFile(pick.file.path); }
  await vscode.window.showTextDocument(vscode.Uri.file(pick.file.path), { preview: false });
}

export async function editPermissions(hub: Hub): Promise<void> {
  const file = hub.safety.settingsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, SETTINGS_TEMPLATE, { flag: 'wx' }).catch((e) => { if (e.code !== 'EEXIST') { throw e; } });
  await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
}

/** Runs a slash command from FEATURE_COMMANDS. */
export async function runFeature(hub: Hub, panel: FeaturePanel, name: string, args: string): Promise<void> {
  switch (name) {
    case 'changes': panel.post({ type: 'openChanges', ...await changesView(hub, panel.sid) }); break;
    case 'commit': await draftCommit(hub, panel); break;
    case 'pr': {
      const skill = findSkill(hub.skills, 'pr-creation');
      if (!skill) { panel.info('No pr-creation skill was found. Add one to .claude/skills to use /pr.', true); break; }
      await panel.send(`The user ran the skill /${skill.name}. Follow its instructions now.\n\n${expandSkill(skill, args)}`, '/pr');
      break;
    }
    case 'memory': await editMemory(hub); break;
    case 'search': searchPicker(hub, args); break;
    case 'export': await exportSession(hub, panel, args); break;
    case 'permissions':
      if (args.trim() === 'edit') { await editPermissions(hub); break; }
      await hub.safety.ensure();
      panel.info(`${hub.safety.describeRules()}\n\nUse /permissions edit to change them.`);
      break;
    case 'audit': {
      await hub.safety.flush();
      const entries = await hub.safety.audit.read(panel.sid);
      if (!entries.length) { panel.info('Nothing has been logged for this session yet.'); break; }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: hub.safety.audit.toCsv(entries), language: 'csv' }), { preview: false });
      break;
    }
    case 'schedule': await (await hub.getScheduler()).manage(); break;
    case 'sources': {
      if (args.trim() === 'save') {
        const file = await hub.web.saveSources(panel.sid, hub.root);
        await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
        panel.info(`Sources saved to ${path.relative(hub.root, file)}.`);
        break;
      }
      panel.info(`${hub.web.sources(panel.sid).toMarkdown()}\n\nUse /sources save to write them to a Markdown file.`);
      break;
    }
    case 'web': {
      const a = args.trim().toLowerCase();
      if (a === 'key' || a === 'keys') { await hub.web.setKey(); break; }
      if (a === 'clear-cache' || a === 'clear') { panel.info(await hub.web.clearCache()); break; }
      panel.info(await hub.web.status(panel.sid));
      break;
    }
  }
}
