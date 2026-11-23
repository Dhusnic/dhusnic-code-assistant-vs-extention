/**
 * The editor side of core/editDiagnostics.ts: reads Error-severity diagnostics from VS Code's language servers so
 * the edit tools can report the errors an edit introduced.
 *
 * baseline() is synchronous and cheap: it reads the diagnostics VS Code already holds for the file. It treats the
 * baseline as known only when the file is open or already has diagnostics; otherwise the language server has not
 * looked at it yet, and errors found after the edit are reported as "may predate it". A document with unsaved
 * changes is skipped, because its diagnostics describe the editor buffer, not the file the tool wrote. Prose and
 * data files with no language server are skipped too, so editing them costs no wait.
 *
 * errorsAfterWrite() subscribes to onDidChangeDiagnostics before opening the document (opening attaches a language
 * server, like get_diagnostics does), then waits for the first change for the file and a short quiet period, at most
 * two seconds; no change in 1.5 s means the errors did not change. The setting infraonAssistant.diagnosticsAfterEdit
 * is read on every call, so turning it off takes effect at once.
 */
import * as vscode from 'vscode';
import { DiagEntry, EditDiagnostics, waitForRecheck } from '../core/editDiagnostics';

/** Files that usually have no language server: checking them would only add a wait. */
const NO_DIAGNOSTICS = /\.(md|markdown|txt|text|log|csv|tsv|rst|adoc|svg|png|jpe?g|gif|ico|pdf|lock)$/i;

function errorsOf(uri: vscode.Uri): DiagEntry[] {
  return vscode.languages.getDiagnostics(uri)
    .filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
    .map((d) => ({ line: d.range.start.line + 1, message: d.message, source: d.source }));
}

export function createEditDiagnostics(enabled: () => boolean): EditDiagnostics {
  return {
    baseline(abs) {
      if (!enabled() || NO_DIAGNOSTICS.test(abs)) { return undefined; }
      const uri = vscode.Uri.file(abs);
      const key = uri.toString();
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
      if (doc?.isDirty) { return undefined; }
      const errors = errorsOf(uri);
      return { known: !!doc || vscode.languages.getDiagnostics(uri).length > 0, errors };
    },
    async errorsAfterWrite(abs, signal) {
      const uri = vscode.Uri.file(abs);
      const key = uri.toString();
      const settled = waitForRecheck(
        (onChange) => vscode.languages.onDidChangeDiagnostics((e) => { if (e.uris.some((u) => u.toString() === key)) { onChange(); } }),
        { firstMs: 1500, quietMs: 300, maxMs: 2000, signal },
      );
      try { await vscode.workspace.openTextDocument(uri); } catch { /* not a text file */ }
      if (await settled === 'aborted') { return undefined; }
      return errorsOf(uri);
    },
  };
}
