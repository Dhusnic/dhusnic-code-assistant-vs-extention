import * as vscode from 'vscode';

export const DIFF_SCHEME = 'infraon-diff';

/** Serves proposed/original file contents as read-only virtual documents for vscode.diff. */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private docs = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  onDidChange = this.emitter.event;

  set(uri: vscode.Uri, content: string): void { this.docs.set(uri.toString(), content); }
  provideTextDocumentContent(uri: vscode.Uri): string { return this.docs.get(uri.toString()) ?? ''; }
  clear(): void { this.docs.clear(); }
}
