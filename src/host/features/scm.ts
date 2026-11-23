import * as vscode from 'vscode';
import type { Hub } from '../hub';
import { buildCommitMessages, cleanCommitMessage, currentBranch, recentSubjects, stagedOrAllDiff } from '../../core/git';

/**
 * Source Control view integration: the sparkle button in the commit box writes a commit message for the staged
 * changes (or every change when nothing is staged) into that repository's input box. It uses the same prompt, model
 * routing ("commit") and secret masking as the commit draft in a session, and never commits by itself.
 * Loaded the first time the button is used.
 */

/** The subset of the built-in git extension's API used here (vscode.git, API version 1). */
interface GitRepository { rootUri: vscode.Uri; inputBox: { value: string } }
interface GitApi { repositories: GitRepository[] }

const SID = 'scm';

async function gitApi(): Promise<GitApi | undefined> {
  const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
  if (!ext) { return undefined; }
  const exports = ext.isActive ? ext.exports : await ext.activate();
  return exports.getAPI(1);
}

/** The repository the button was pressed on; the one holding the active file; else the only one. */
function pickRepository(api: GitApi, arg: unknown): GitRepository | undefined {
  const root = (arg as { rootUri?: vscode.Uri } | undefined)?.rootUri;
  if (root) { return api.repositories.find((r) => r.rootUri.toString() === root.toString()); }
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  const holding = active ? api.repositories.filter((r) => active.startsWith(r.rootUri.fsPath)).sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0] : undefined;
  return holding ?? (api.repositories.length === 1 ? api.repositories[0] : undefined);
}

export async function generateCommitMessage(hub: Hub, arg?: unknown): Promise<void> {
  const api = await gitApi();
  if (!api) { void vscode.window.showWarningMessage('Infraon: the built-in Git extension is disabled.'); return; }
  const repo = pickRepository(api, arg);
  if (!repo) { void vscode.window.showInformationMessage('Infraon: open a file in the repository first, or use the button in its Source Control section.'); return; }
  const cwd = repo.rootUri.fsPath;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: 'Writing a commit message' }, async () => {
    const snap = await stagedOrAllDiff(cwd);
    if (!snap.diff.trim()) { void vscode.window.showInformationMessage('Infraon: there is nothing to commit.'); return; }
    const [branch, recent] = await Promise.all([currentBranch(cwd), recentSubjects(cwd)]);
    const cfg = await hub.llmConfig(hub.routeModel('commit', hub.defaults().model));
    const res = await hub.llmFor(SID)({ ...cfg, maxTokens: 400 }, buildCommitMessages(snap.diff, recent, branch), [], () => undefined, new AbortController().signal);
    const message = hub.safety.vault(SID).restore(cleanCommitMessage(res.content));
    if (!message) { void vscode.window.showWarningMessage('Infraon: the model returned no commit message. Try again.'); return; }
    repo.inputBox.value = message;
    if (snap.truncated) { void vscode.window.showInformationMessage('Infraon: the diff was large, so the message is based on part of it. Review it before committing.'); }
  });
}
