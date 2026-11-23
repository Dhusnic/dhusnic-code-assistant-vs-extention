/**
 * Language-server symbols for the repo map (core/repoMap.ts `SymbolProvider`).
 *
 * Design:
 * - One call per file: open the document (so a language server can attach) and run
 *   `vscode.executeDocumentSymbolProvider`. The result is turned into the vscode-free `LsSymbol` tree; core decides
 *   what to keep, which files to ask about, the time boxes, caching and the regex fallback.
 * - Each symbol carries the source line of its name, so core can read visibility keywords (public/private) that
 *   document symbols do not report.
 * - Only files inside a workspace folder are asked about: agent worktrees and other outside folders would start
 *   language servers on loose files. `undefined` means "no answer" and core keeps its regex definitions.
 * - `enabled` is read on every call (infraonAssistant.repoMap.useLanguageServer), so the setting applies at once.
 */
import * as vscode from 'vscode';
import type { LsSymbol, SymbolProvider } from '../core/repoMap';

type Sym = vscode.DocumentSymbol | vscode.SymbolInformation;

function toLs(symbols: Sym[], doc: vscode.TextDocument, depth = 0): LsSymbol[] {
  if (depth > 8) { return []; }
  return symbols.filter((s) => s && typeof s.name === 'string').map((s) => {
    const range = 'selectionRange' in s && s.selectionRange ? s.selectionRange : 'location' in s ? s.location.range : s.range;
    const n = range?.start.line ?? -1;
    return {
      name: s.name,
      kind: vscode.SymbolKind[s.kind] ?? 'Unknown',
      line: n >= 0 && n < doc.lineCount ? doc.lineAt(n).text.slice(0, 400) : undefined,
      children: 'children' in s && s.children?.length ? toLs(s.children, doc, depth + 1) : undefined,
    };
  });
}

/** The repo map's symbol provider for a root, or undefined when turned off or the root is not a workspace folder. */
export function repoMapSymbolsFor(enabled: () => boolean): (root: string) => SymbolProvider | undefined {
  const provider: SymbolProvider = async (absPath, signal) => {
    const uri = vscode.Uri.file(absPath);
    if (!enabled() || !vscode.workspace.getWorkspaceFolder(uri)) { return undefined; }
    const doc = await vscode.workspace.openTextDocument(uri);
    if (signal.aborted) { return undefined; }
    const res = await vscode.commands.executeCommand<Sym[]>('vscode.executeDocumentSymbolProvider', uri);
    return res?.length ? toLs(res, doc) : undefined;
  };
  return (root) => (enabled() && vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root)) ? provider : undefined);
}
