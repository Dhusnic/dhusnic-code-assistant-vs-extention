import * as vscode from 'vscode';
import * as path from 'path';
import { Tool, fnSpec } from '../core/tool';
import { clip, resolveSafe } from '../core/fstools';

export function createVsCodeTools(): Tool[] {
  return [
    {
      kind: 'read',
      spec: fnSpec('get_diagnostics', 'Get current editor errors/warnings for a file (or all files if path omitted).', { path: { type: 'string' } }, []),
      describe: (a) => (a.path ? `Diagnostics for ${a.path}` : 'Diagnostics (workspace)'),
      async run(a, ctx) {
        const all: ReadonlyArray<readonly [vscode.Uri, vscode.Diagnostic[]]> = a.path
          ? [[vscode.Uri.file(resolveSafe(ctx.root, a.path)), vscode.languages.getDiagnostics(vscode.Uri.file(resolveSafe(ctx.root, a.path)))] as const]
          : vscode.languages.getDiagnostics();
        const out: string[] = [];
        for (const [uri, diags] of all) {
          for (const d of diags) {
            out.push(`${path.relative(ctx.root, uri.fsPath)}:${d.range.start.line + 1} [${vscode.DiagnosticSeverity[d.severity]}] ${d.message}`);
          }
        }
        return clip(out.join('\n') || 'No diagnostics.');
      },
    },
  ];
}
