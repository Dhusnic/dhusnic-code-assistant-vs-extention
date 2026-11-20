import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ApprovalPreview, Tool, ToolCtx, fnSpec } from '../core/tool';
import { clip, resolveIn, rootOf } from '../core/fstools';
import {
  MAX_REFERENCES, MAX_WORKSPACE_SYMBOLS, NavLocation, OffsetEdit, OutlineNode,
  applyTextEdits, displayPath, findSymbolColumn, formatLocations, formatOutline, isValidNewName, offsetAt,
} from '../core/nav';

const NO_SERVER = 'The language server may not support this file type or is still loading; fall back to grep.';

const POSITION_ARGS = {
  path: { type: 'string', description: 'file containing the symbol, relative to the workspace' },
  line: { type: 'number', description: '1-based line where the symbol appears (from read_file or grep)' },
  symbol: { type: 'string', description: 'the identifier as written on that line' },
};

/** Opens the file (so a language server attaches) and resolves the symbol's position near the given line. */
async function locate(a: any, ctx: ToolCtx): Promise<{ uri: vscode.Uri; doc: vscode.TextDocument; pos: vscode.Position }> {
  const abs = resolveIn(ctx, String(a.path ?? ''));
  const uri = vscode.Uri.file(abs);
  const doc = await vscode.workspace.openTextDocument(uri);
  const lines = doc.getText().split('\n');
  const found = findSymbolColumn(lines, Number(a.line), String(a.symbol ?? ''));
  if (!found) {
    throw new Error(`"${a.symbol}" was not found as a whole word on line ${a.line} of ${a.path} (or within 3 lines of it). Read the file and pass the exact line number and identifier.`);
  }
  return { uri, doc, pos: new vscode.Position(found.line, found.character) };
}

type Loc = vscode.Location | vscode.LocationLink;
const toNav = (l: Loc): NavLocation => {
  const uri = 'targetUri' in l ? l.targetUri : l.uri;
  const range = 'targetUri' in l ? (l.targetSelectionRange ?? l.targetRange) : l.range;
  return { file: uri.fsPath, line: range.start.line, character: range.start.character };
};

/** Reads source lines for the result listing; caches each file once. */
function lineReader(): { prime(files: string[]): Promise<void>; at(file: string, line: number): string | undefined } {
  const cache = new Map<string, string[]>();
  return {
    async prime(files) {
      await Promise.all([...new Set(files)].map(async (f) => {
        if (cache.has(f)) { return; }
        const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === f);
        try { cache.set(f, (open ? open.getText() : await fs.readFile(f, 'utf8')).split('\n')); } catch { cache.set(f, []); }
      }));
    },
    at: (f, line) => cache.get(f)?.[line],
  };
}

/** In a multi-root workspace, shows files of other workspace folders as "<folder name>/path" instead of "outside workspace". */
function inOtherRoots(ctx: ToolCtx, text: string): string {
  let out = text;
  for (const r of ctx.roots ?? []) {
    if (path.resolve(r.path).toLowerCase() === path.resolve(ctx.root).toLowerCase()) { continue; }
    const esc = path.resolve(r.path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`${esc}[\\\\/]([^\\n]*?) \\(outside workspace\\)`, process.platform === 'win32' ? 'gi' : 'g'), (_m, rel: string) => `${r.name}/${rel.replace(/\\/g, '/')}`);
  }
  return out;
}
const shown = (ctx: ToolCtx, abs: string): string => inOtherRoots(ctx, displayPath(ctx.root, abs));

async function listLocations(locs: NavLocation[], root: string, cap = MAX_REFERENCES): Promise<string> {
  const reader = lineReader();
  await reader.prime(locs.slice(0, cap * 2).map((l) => l.file));
  return formatLocations(locs, root, (f, l) => reader.at(f, l), cap);
}

function outlineOf(symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>): OutlineNode[] {
  return symbols.map((s) => {
    const range = 'location' in s ? s.location.range : s.range;
    return {
      name: s.name, kind: vscode.SymbolKind[s.kind] ?? 'symbol',
      startLine: range.start.line + 1, endLine: range.end.line + 1,
      detail: 'detail' in s && s.detail ? s.detail : undefined,
      children: 'children' in s && s.children?.length ? outlineOf(s.children) : undefined,
    };
  });
}

interface PlannedRename { files: Array<{ uri: vscode.Uri; abs: string; oldText: string; newText: string; edits: number }>; edit: vscode.WorkspaceEdit }

/** Asks the language server for the rename and computes every affected file's new text, without changing anything. */
async function planRename(a: any, ctx: ToolCtx): Promise<PlannedRename> {
  const newName = String(a.new_name ?? '').trim();
  if (!isValidNewName(newName)) { throw new Error('new_name must be a non-empty name without spaces.'); }
  if (newName === String(a.symbol ?? '').trim()) { throw new Error('new_name is the same as the current name.'); }
  const { uri, pos } = await locate(a, ctx);
  let edit: vscode.WorkspaceEdit | undefined;
  try {
    edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', uri, pos, newName);
  } catch (e: any) {
    throw new Error(`The language server refused the rename: ${e?.message ?? e}`);
  }
  const entries = edit ? edit.entries() : [];
  if (!edit || !entries.length) { throw new Error(`No rename available for "${a.symbol}". ${NO_SERVER} (For a rename with grep, use edit_file with replace_all per file.)`); }
  const files: PlannedRename['files'] = [];
  for (const [u, textEdits] of entries) {
    const abs = u.fsPath;
    if (u.scheme !== 'file' || !rootOf(ctx, abs)) {
      throw new Error(`The rename would change ${shown(ctx, abs)}, which is outside the workspace; nothing was changed.`);
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
    const oldText = open ? open.getText() : await fs.readFile(abs, 'utf8');
    const offs: OffsetEdit[] = textEdits.map((t) => ({
      startOffset: offsetAt(oldText, t.range.start.line, t.range.start.character),
      endOffset: offsetAt(oldText, t.range.end.line, t.range.end.character),
      newText: t.newText,
    }));
    files.push({ uri: u, abs, oldText, newText: applyTextEdits(oldText, offs), edits: textEdits.length });
  }
  files.sort((x, y) => y.edits - x.edits);
  return { files, edit };
}

export function createNavTools(): Tool[] {
  return [
    {
      kind: 'read',
      spec: fnSpec('find_definition',
        'Go to the definition of a symbol using the language server (exact, follows imports across files). Prefer it over grep when you need where a function, class, type or variable is really defined. Give the file and 1-based line where the symbol is used, and the identifier.',
        POSITION_ARGS, ['path', 'line', 'symbol']),
      describe: (a) => `Definition of ${a.symbol} (${a.path}:${a.line})`,
      async run(a, ctx) {
        const { uri, pos } = await locate(a, ctx);
        const res = (await vscode.commands.executeCommand<Loc[]>('vscode.executeDefinitionProvider', uri, pos)) ?? [];
        if (!res.length) { return `No definition found for "${a.symbol}". ${NO_SERVER}`; }
        return clip(inOtherRoots(ctx, await listLocations(res.map(toNav), ctx.root)));
      },
    },
    {
      kind: 'read',
      spec: fnSpec('find_references',
        'Find every usage of a symbol across the workspace using the language server. Prefer it over grep before changing a function signature, renaming, or deleting code: it finds real references only (no same-named strings or comments). Give the file and 1-based line where the symbol appears, and the identifier.',
        { ...POSITION_ARGS, include_declaration: { type: 'boolean', description: 'also list the declaration itself (default false)' } },
        ['path', 'line', 'symbol']),
      describe: (a) => `References to ${a.symbol}`,
      async run(a, ctx) {
        const { uri, pos } = await locate(a, ctx);
        const res = (await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, pos, { includeDeclaration: a.include_declaration === true })) ?? [];
        if (!res.length) { return `No references found for "${a.symbol}". ${NO_SERVER}`; }
        return clip(inOtherRoots(ctx, await listLocations(res.map(toNav), ctx.root, MAX_REFERENCES)));
      },
    },
    {
      kind: 'read',
      spec: fnSpec('document_symbols',
        'Outline of a file from the language server: classes, functions, methods, fields with their line ranges, nested. Use it to understand a large file quickly, then read_file only the ranges you need.',
        { path: { type: 'string' } }, ['path']),
      describe: (a) => `Outline of ${a.path}`,
      async run(a, ctx) {
        const uri = vscode.Uri.file(resolveIn(ctx, String(a.path ?? '')));
        await vscode.workspace.openTextDocument(uri);
        const res = (await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>('vscode.executeDocumentSymbolProvider', uri)) ?? [];
        if (!res.length) { return `No symbols found in ${a.path}. ${NO_SERVER}`; }
        return clip(formatOutline(outlineOf(res)));
      },
    },
    {
      kind: 'read',
      spec: fnSpec('workspace_symbols',
        'Search symbol names (classes, functions, types) across the whole workspace using the language server. Faster and more precise than grep for "where is class X / function Y declared".',
        { query: { type: 'string', description: 'symbol name or part of it' } }, ['query']),
      describe: (a) => `Symbols matching "${a.query}"`,
      async run(a, ctx) {
        const q = String(a.query ?? '').trim();
        if (!q) { throw new Error('query must not be empty.'); }
        const res = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', q)) ?? [];
        if (!res.length) { return `No symbols match "${q}". ${NO_SERVER}`; }
        const rows = res.slice(0, MAX_WORKSPACE_SYMBOLS).map((s) => {
          const where = displayPath(ctx.root, s.location.uri.fsPath);
          if (where.endsWith('(outside workspace)') && rootOf(ctx, s.location.uri.fsPath)) { return `${vscode.SymbolKind[s.kind]?.toLowerCase() ?? 'symbol'} ${s.name}${s.containerName ? ` (in ${s.containerName})` : ''}  ${shown(ctx, s.location.uri.fsPath)}:${s.location.range.start.line + 1}`; }
          return `${vscode.SymbolKind[s.kind]?.toLowerCase() ?? 'symbol'} ${s.name}${s.containerName ? ` (in ${s.containerName})` : ''}  ${where.replace(/ \(outside workspace\)$/, '')}:${s.location.range.start.line + 1}${where.endsWith('(outside workspace)') ? ' (outside workspace)' : ''}`;
        });
        if (res.length > MAX_WORKSPACE_SYMBOLS) { rows.push(`[${res.length - MAX_WORKSPACE_SYMBOLS} more; use a more specific query]`); }
        return clip(rows.join('\n'));
      },
    },
    {
      kind: 'edit',
      spec: fnSpec('rename_symbol',
        'Rename a symbol everywhere it is used, through the language server (updates imports and references in every file, skips same-named strings and comments). Prefer it over find-and-replace for renaming functions, classes, methods, variables and types. Give the file and 1-based line where the symbol appears, the current identifier and new_name.',
        { ...POSITION_ARGS, new_name: { type: 'string' } }, ['path', 'line', 'symbol', 'new_name']),
      describe: (a) => `Rename ${a.symbol} → ${a.new_name}`,
      async preview(a, ctx): Promise<ApprovalPreview> {
        const plan = await planRename(a, ctx);
        const top = plan.files[0];
        const others = plan.files.length - 1;
        return { path: `${shown(ctx, top.abs)}${others ? ` (+${others} other file${others === 1 ? '' : 's'})` : ''}`, oldText: top.oldText, newText: top.newText };
      },
      async run(a, ctx) {
        const plan = await planRename(a, ctx);
        for (const f of plan.files) { await ctx.snapshot(f.abs); }
        const ok = await vscode.workspace.applyEdit(plan.edit);
        if (!ok) { throw new Error('VS Code could not apply the rename; nothing was changed.'); }
        const unsaved: string[] = [];
        for (const f of plan.files) {
          try {
            const doc = await vscode.workspace.openTextDocument(f.uri);
            if (doc.isDirty && !(await doc.save())) { unsaved.push(shown(ctx, f.abs)); }
          } catch { unsaved.push(shown(ctx, f.abs)); }
        }
        const total = plan.files.reduce((n, f) => n + f.edits, 0);
        const list = plan.files.map((f) => `- ${shown(ctx, f.abs)} (${f.edits} edit${f.edits === 1 ? '' : 's'})`).join('\n');
        return clip(`Renamed ${a.symbol} to ${String(a.new_name).trim()}: ${total} edit${total === 1 ? '' : 's'} in ${plan.files.length} file${plan.files.length === 1 ? '' : 's'}\n${list}${unsaved.length ? `\nCould not save: ${unsaved.join(', ')}` : ''}`);
      },
    },
  ];
}
