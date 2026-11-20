import * as vscode from 'vscode';
import * as path from 'path';
import { Tool, fnSpec } from '../core/tool';
import { clip, resolveIn } from '../core/fstools';
import { waitForQuiet } from '../core/settle';

const SEVERITIES: Record<string, vscode.DiagnosticSeverity[]> = {
  error: [vscode.DiagnosticSeverity.Error],
  warning: [vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning],
};

export function createVsCodeTools(): Tool[] {
  return [
    {
      kind: 'read',
      spec: fnSpec('get_diagnostics',
        'Get editor errors/warnings for a file (or all files if path omitted). Call it after editing files: it opens the file and waits for the language server to finish updating, so results reflect your latest changes.',
        {
          path: { type: 'string' },
          severity: { type: 'string', enum: ['error', 'warning', 'all'], description: 'error: errors only; warning: errors and warnings; all (default): everything' },
        }, []),
      describe: (a) => (a.path ? `Diagnostics for ${a.path}` : 'Diagnostics (workspace)'),
      async run(a, ctx) {
        const uri = a.path ? vscode.Uri.file(resolveIn(ctx, a.path)) : undefined;
        if (uri) {
          // Opening the document makes sure a language server is attached and checks the file's current contents.
          try { await vscode.workspace.openTextDocument(uri); } catch { /* not a text file, or missing */ }
        }
        const key = uri?.toString();
        const settled = await waitForQuiet(
          (onChange) => vscode.languages.onDidChangeDiagnostics((e) => { if (!key || e.uris.some((u) => u.toString() === key)) { onChange(); } }),
          uri ? { quietMs: 800, maxMs: 5000, signal: ctx.signal } : { quietMs: 500, maxMs: 3000, signal: ctx.signal },
        );
        if (settled === 'aborted') { throw new Error('Cancelled'); }
        const allowed = SEVERITIES[String(a.severity ?? '')];
        const all: ReadonlyArray<readonly [vscode.Uri, vscode.Diagnostic[]]> = uri
          ? [[uri, vscode.languages.getDiagnostics(uri)] as const]
          : vscode.languages.getDiagnostics();
        const out: string[] = [];
        for (const [u, diags] of all) {
          for (const d of diags) {
            if (allowed && !allowed.includes(d.severity)) { continue; }
            out.push(`${path.relative(ctx.root, u.fsPath)}:${d.range.start.line + 1} [${vscode.DiagnosticSeverity[d.severity]}] ${d.message}`);
          }
        }
        const note = settled === 'timeout' ? '\n(language server still updating; results may be incomplete)' : '';
        return clip((out.join('\n') || 'No diagnostics.') + note);
      },
    },
  ];
}
