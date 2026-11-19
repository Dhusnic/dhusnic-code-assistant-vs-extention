import * as vscode from 'vscode';
import * as path from 'path';
import type { LlmConfig, LlmFn } from '../../core/llm';
import { buildFixPrompt, buildInlineEditMessages, cleanInlineEdit } from '../../core/inlineEdit';

export interface EditorHost { llmConfig(): Promise<LlmConfig>; llm: LlmFn; root: string; startSession(prompt: string): Promise<void> }

const SCHEME = 'infraon-inline-edit';
const PENDING_KEY = 'infraonAssistant.inlineEditPending';
const MAX_SELECTION_CHARS = 60000;
const MAX_DIAGNOSTICS = 10;

interface Pending { uri: vscode.Uri; version: number; range: vscode.Range; selection: string; text: string; left: vscode.Uri; right: vscode.Uri }

const editable = (doc: vscode.TextDocument): boolean => doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled';
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Whole lines covered by a range, without a final line the range only touches at column 0. */
function wholeLines(doc: vscode.TextDocument, r: vscode.Range): vscode.Range {
  const last = r.end.character === 0 && r.end.line > r.start.line ? r.end.line - 1 : r.end.line;
  return new vscode.Range(r.start.line, 0, last, doc.lineAt(last).text.length);
}

/** Accepts a Range, or the plain JSON form a Range takes when it comes through a command link or keybinding. */
function toRange(r: any): vscode.Range | undefined {
  if (r instanceof vscode.Range) { return r; }
  const s = r?.start ?? r?.[0], e = r?.end ?? r?.[1];
  return typeof s?.line === 'number' && typeof e?.line === 'number' ? new vscode.Range(s.line, s.character ?? 0, e.line, e.character ?? 0) : undefined;
}

function problemsIn(doc: vscode.TextDocument, range: vscode.Range): string[] {
  return vscode.languages.getDiagnostics(doc.uri)
    .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning && d.range.intersection(range))
    .slice(0, MAX_DIAGNOSTICS).map((d) => `line ${d.range.start.line + 1}: ${d.message}`);
}

export function registerEditorActions(ctx: vscode.ExtensionContext, getHost: () => Promise<EditorHost>): vscode.Disposable {
  const contents = new Map<string, string>();
  let contentSub: vscode.Disposable | undefined;
  let tabSub: vscode.Disposable | undefined;
  let running: AbortController | undefined;
  let pending: Pending | undefined;
  let seq = 0;

  const relative = (root: string, doc: vscode.TextDocument): string => {
    if (doc.uri.scheme !== 'file') { return doc.fileName; }
    const rel = path.relative(root, doc.uri.fsPath);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : path.basename(doc.fileName);
  };

  const isDiffOf = (t: vscode.Tab, p: Pending): boolean => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === p.right.toString();

  const closeDiff = async (p: Pending): Promise<void> => {
    try {
      const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => isDiffOf(t, p));
      if (tabs.length) { await vscode.window.tabGroups.close(tabs); }
    } catch { /* the tab is already gone */ }
    contents.delete(p.left.toString());
    contents.delete(p.right.toString());
  };

  const setPending = (p: Pending | undefined): void => {
    pending = p;
    void vscode.commands.executeCommand('setContext', PENDING_KEY, !!p);
  };

  /** Cancels the request in flight and discards the edit under review: only one exists at a time. */
  const discard = async (): Promise<void> => {
    running?.abort();
    running = undefined;
    const p = pending;
    if (p) { setPending(undefined); await closeDiff(p); }
  };

  const safe = <A extends unknown[]>(fn: (...a: A) => Promise<void>) => async (...a: A): Promise<void> => {
    try { await fn(...a); } catch (e) { void vscode.window.showErrorMessage(`Infraon: ${errorText(e)}`); }
  };

  const accept = safe(async () => {
    const p = pending;
    if (!p) { void vscode.window.showInformationMessage('Infraon: no edit is waiting for review.'); return; }
    setPending(undefined);
    try {
      const doc = await vscode.workspace.openTextDocument(p.uri);
      if (doc.version !== p.version || doc.getText(p.range) !== p.selection) {
        void vscode.window.showWarningMessage('Infraon: the file changed after this edit was requested, so it was not applied. Run the edit again.');
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(p.uri, p.range, p.text);
      if (!await vscode.workspace.applyEdit(edit)) { void vscode.window.showErrorMessage('Infraon: VS Code could not apply the edit.'); }
    } finally { await closeDiff(p); }
  });

  const reject = safe(async () => {
    const p = pending;
    if (!p) { return; }
    setPending(undefined);
    await closeDiff(p);
  });

  const showDiff = async (doc: vscode.TextDocument, p: Omit<Pending, 'left' | 'right'>): Promise<void> => {
    contentSub ??= vscode.workspace.registerTextDocumentContentProvider(SCHEME, { provideTextDocumentContent: (u) => contents.get(u.toString()) ?? '' });
    const name = path.basename(doc.fileName) || 'untitled';
    const id = ++seq;
    const left = vscode.Uri.from({ scheme: SCHEME, path: `/${id}/original/${name}` });
    const right = vscode.Uri.from({ scheme: SCHEME, path: `/${id}/proposed/${name}` });
    const full = doc.getText();
    contents.set(left.toString(), full);
    contents.set(right.toString(), full.slice(0, doc.offsetAt(p.range.start)) + p.text + full.slice(doc.offsetAt(p.range.end)));
    const entry: Pending = { ...p, left, right };
    setPending(entry);
    // Closing the review tab counts as rejecting: an edit nobody can see must not stay acceptable by keybinding.
    tabSub ??= vscode.window.tabGroups.onDidChangeTabs((e) => {
      const cur = pending;
      if (!cur || !e.closed.some((t) => isDiffOf(t, cur))) { return; }
      if (!vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => isDiffOf(t, cur)))) { void reject(); }
    });
    try {
      await vscode.commands.executeCommand('vscode.diff', left, right, `Infraon: proposed edit to ${name}`, { preview: false });
    } catch (e) {
      setPending(undefined);
      await closeDiff(entry);
      throw e;
    }
    vscode.window.showInformationMessage(`Infraon: review the proposed edit to ${name}.`, 'Accept', 'Reject').then((choice) => {
      if (pending !== entry) { return; }
      if (choice === 'Accept') { void accept(); } else if (choice === 'Reject') { void reject(); }
    }, () => undefined);
  };

  /** Asks the model for a replacement of `range` and opens it for review. */
  const propose = async (doc: vscode.TextDocument, range: vscode.Range, version: number, instruction: string, title: string): Promise<void> => {
    await discard();
    const selection = doc.getText(range);
    if (selection.length > MAX_SELECTION_CHARS) { throw new Error('the selection is too large for an inline edit. Select less, or use a session.'); }
    running?.abort(); // another request may have started while the previous edit was being discarded
    const ac = new AbortController();
    running = ac;
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const before = doc.getText(new vscode.Range(new vscode.Position(0, 0), range.start));
    const after = doc.getText(new vscode.Range(range.end, doc.lineAt(doc.lineCount - 1).range.end));
    let raw: string;
    try {
      raw = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Infraon: ${title}`, cancellable: true }, async (progress, token) => {
        const sub = token.onCancellationRequested(() => ac.abort());
        try {
          const host = await getHost();
          const cfg = await host.llmConfig();
          if (ac.signal.aborted) { return ''; }
          const messages = buildInlineEditMessages({
            instruction, language: doc.languageId, file: relative(host.root, doc), before, selection, after, diagnostics: problemsIn(doc, range),
          });
          let chars = 0, shown = 0;
          const res = await host.llm(cfg, messages, [], (t) => {
            chars += t.length;
            if (chars - shown >= 80) { shown = chars; progress.report({ message: `${chars} characters` }); }
          }, ac.signal);
          return res.content;
        } finally { sub.dispose(); }
      });
    } catch (e) {
      if (ac.signal.aborted) { return; }
      throw e;
    } finally { if (running === ac) { running = undefined; } }
    if (ac.signal.aborted) { return; }
    const text = cleanInlineEdit(raw, selection, { eol, before, after });
    if (!text) { void vscode.window.showInformationMessage('Infraon: no change was suggested.'); return; }
    await showDiff(doc, { uri: doc.uri, version, range, selection, text });
  };

  const inlineEdit = safe(async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editable(editor.document)) { void vscode.window.showInformationMessage('Infraon: open a file to edit first.'); return; }
    const doc = editor.document;
    const version = doc.version;
    const range = editor.selection.isEmpty ? doc.lineAt(editor.selection.active.line).range : new vscode.Range(editor.selection.start, editor.selection.end);
    const instruction = (await vscode.window.showInputBox({ title: 'Edit with Infraon', prompt: 'Describe the change', placeHolder: 'e.g. add error handling', ignoreFocusOut: true }))?.trim();
    if (!instruction) { return; }
    if (doc.version !== version) { void vscode.window.showWarningMessage('Infraon: the file changed while you were typing. Run the edit again.'); return; }
    await propose(doc, range, version, instruction, 'editing the selection');
  });

  const target = async (uri: unknown, r: unknown): Promise<{ doc: vscode.TextDocument; range: vscode.Range } | undefined> => {
    const range = toRange(r);
    if (!(uri instanceof vscode.Uri) || !range) { void vscode.window.showInformationMessage('Infraon: use this from the light bulb on a problem.'); return undefined; }
    const doc = await vscode.workspace.openTextDocument(uri);
    return { doc, range: wholeLines(doc, doc.validateRange(range)) };
  };

  const fixDiagnostic = safe(async (uri: unknown, r: unknown, message: unknown) => {
    const t = await target(uri, r);
    if (!t) { return; }
    await propose(t.doc, t.range, t.doc.version, `Fix this problem, changing only what is needed: ${String(message ?? 'the reported problem')}`, 'fixing the problem');
  });

  const fixInSession = safe(async (uri: unknown, r: unknown, message: unknown) => {
    const t = await target(uri, r);
    if (!t) { return; }
    const host = await getHost();
    await host.startSession(buildFixPrompt({ message: String(message ?? 'the reported problem') }, relative(host.root, t.doc), t.range.start.line + 1, t.doc.getText(t.range)));
  });

  const kinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite];
  const provider: vscode.CodeActionProvider = {
    provideCodeActions(doc, range, cc) {
      if (!editable(doc)) { return []; }
      const out: vscode.CodeAction[] = [];
      const wants = (k: vscode.CodeActionKind): boolean => !cc.only || cc.only.contains(k);
      const problems = cc.diagnostics.filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning);
      if (problems.length && wants(vscode.CodeActionKind.QuickFix)) {
        for (const d of problems) {
          const title = problems.length > 1 ? `Fix with Infraon: ${d.message.split('\n')[0].slice(0, 60)}` : 'Fix with Infraon';
          const fix = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
          fix.diagnostics = [d];
          fix.command = { command: 'infraonAssistant.fixDiagnostic', title, arguments: [doc.uri, d.range, d.message] };
          out.push(fix);
        }
        const first = problems[0];
        const session = new vscode.CodeAction('Fix in a session', vscode.CodeActionKind.QuickFix);
        session.diagnostics = [first];
        session.command = { command: 'infraonAssistant.fixInSession', title: 'Fix in a session', arguments: [doc.uri, first.range, first.message] };
        out.push(session);
      }
      if (!range.isEmpty && wants(vscode.CodeActionKind.RefactorRewrite)) {
        const rewrite = new vscode.CodeAction('Edit with Infraon', vscode.CodeActionKind.RefactorRewrite);
        rewrite.command = { command: 'infraonAssistant.inlineEdit', title: 'Edit with Infraon' };
        out.push(rewrite);
      }
      return out;
    },
  };

  const subs: vscode.Disposable[] = [
    vscode.languages.registerCodeActionsProvider([{ scheme: 'file' }, { scheme: 'untitled' }], provider, { providedCodeActionKinds: kinds }),
    vscode.commands.registerCommand('infraonAssistant.inlineEdit', inlineEdit),
    vscode.commands.registerCommand('infraonAssistant.fixDiagnostic', fixDiagnostic),
    vscode.commands.registerCommand('infraonAssistant.fixInSession', fixInSession),
    vscode.commands.registerCommand('infraonAssistant.inlineEdit.accept', accept),
    vscode.commands.registerCommand('infraonAssistant.inlineEdit.reject', reject),
  ];

  let disposed = false;
  const disposable = new vscode.Disposable(() => {
    if (disposed) { return; }
    disposed = true;
    void discard().catch(() => undefined);
    contentSub?.dispose();
    tabSub?.dispose();
    for (const s of subs) { s.dispose(); }
  });
  ctx.subscriptions.push(disposable);
  return disposable;
}
