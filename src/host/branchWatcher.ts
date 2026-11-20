import * as vscode from 'vscode';
import * as path from 'path';
import { resolveGitDirs } from '../core/gitHead';

/**
 * Tells listeners when the checked-out branch (HEAD) of a folder's repository may have changed: a checkout in a
 * terminal, VS Code's branch picker, the agent running git, a new branch. Two independent sources, so it works with
 * the built-in git extension disabled: the git extension's repository state, and file watchers on HEAD and refs.
 * One watcher per repository folder, shared by every listener and disposed with the last one.
 */

const DEBOUNCE_MS = 300;

/** The parts of the built-in git extension's API (vscode.git, API v1) used here. */
interface GitRepository { readonly rootUri: vscode.Uri; readonly state: { readonly HEAD?: { name?: string; commit?: string }; readonly onDidChange: vscode.Event<void> } }
interface GitApi {
  getRepository(uri: vscode.Uri): GitRepository | null;
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
}

const headKey = (r: GitRepository): string => `${r.state.HEAD?.name ?? ''}\0${r.state.HEAD?.commit ?? ''}`;

class RootWatcher {
  readonly listeners = new Set<() => void>();
  private disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;
  private disposed = false;

  constructor(private readonly root: string) {
    void this.watchFiles().catch(() => undefined);
    void this.watchGitApi().catch(() => undefined);
  }

  private readonly fire = (): void => {
    if (this.disposed) { return; }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { for (const l of [...this.listeners]) { try { l(); } catch { /* a listener's failure is its own */ } } }, DEBOUNCE_MS);
  };

  private keep(d: vscode.Disposable): void {
    if (this.disposed) { d.dispose(); } else { this.disposables.push(d); }
  }

  /** HEAD lives in the per-worktree git dir; branch refs in the shared one (they differ for linked worktrees). */
  private async watchFiles(): Promise<void> {
    const dirs = await resolveGitDirs(this.root);
    if (!dirs || this.disposed) { return; }
    const watch = (base: string, glob: string) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
      w.onDidChange(this.fire); w.onDidCreate(this.fire); w.onDidDelete(this.fire);
      this.keep(w);
    };
    watch(dirs.gitDir, 'HEAD');
    watch(dirs.commonDir, '{packed-refs,refs/heads/**}');
  }

  private async watchGitApi(): Promise<void> {
    const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git');
    if (!ext) { return; }
    const api = (ext.isActive ? ext.exports : await ext.activate())?.getAPI(1);
    if (!api || this.disposed) { return; }
    const uri = vscode.Uri.file(this.root);
    let bound: GitRepository | undefined;
    let sub: vscode.Disposable | undefined;
    const bind = () => {
      const repo = api.getRepository(uri) ?? undefined;
      if (repo === bound) { return; }
      sub?.dispose();
      bound = repo;
      sub = undefined;
      if (repo) {
        let key = headKey(repo);
        sub = repo.state.onDidChange(() => { const k = headKey(repo); if (k !== key) { key = k; this.fire(); } });
      }
      this.fire();
    };
    bind();
    this.keep(api.onDidOpenRepository(bind));
    this.keep(api.onDidCloseRepository(bind));
    this.keep({ dispose: () => sub?.dispose() });
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const d of this.disposables.splice(0)) { try { d.dispose(); } catch { /* already gone */ } }
  }
}

const watchers = new Map<string, RootWatcher>();
const keyOf = (root: string): string => { const p = path.resolve(root); return process.platform === 'linux' ? p : p.toLowerCase(); };

/** Calls `onChange` (debounced) whenever HEAD of the repository containing `root` may have moved. */
export function watchBranch(root: string, onChange: () => void): vscode.Disposable {
  const key = keyOf(root);
  let w = watchers.get(key);
  if (!w) { w = new RootWatcher(root); watchers.set(key, w); }
  const watcher = w;
  watcher.listeners.add(onChange);
  return {
    dispose: () => {
      watcher.listeners.delete(onChange);
      if (!watcher.listeners.size && watchers.get(key) === watcher) { watchers.delete(key); watcher.dispose(); }
    },
  };
}
