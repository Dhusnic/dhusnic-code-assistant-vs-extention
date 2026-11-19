import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { AgentGuard, GuardDecision, HookOutcome, ToolRequest } from '../../core/agent';
import { AuditLog } from '../../core/audit';
import { CentralPolicy } from '../../core/centralPolicy';
import { HookConfig, HookEvent, hasHooks, mergeHooks, parseHooks, runHooks } from '../../core/hooks';
import { LlmFn } from '../../core/llm';
import { PermissionRule, evaluatePermission, loadPermissionSettings } from '../../core/permissions';
import { requiresApproval } from '../../core/policy';
import { catastrophicReason, isReadOnlyCommand } from '../../core/remoteTools';
import { SecretVault, redactMessages } from '../../core/redact';

const TRUST_KEY = 'trustedProjectSettings';
const RECHECK_MS = 2000;
/** Files that decide what the agent may do. The agent can never change them without the user's approval. */
const PROTECTED = /(^|[\\/])\.(infraon|claude)[\\/]settings(\.local)?\.json$/i;
const PROTECTED_IN_COMMAND = /\.(infraon|claude)[\\/]+settings/i;

export interface GuardHost {
  ctx: vscode.ExtensionContext;
  root: string;
  policy: CentralPolicy;
  policyReady: Promise<void>;
  cfg: vscode.WorkspaceConfiguration;
  output: vscode.OutputChannel;
}

/** Permission rules, hooks, secret masking and the audit log for every agent of this window. */
export class SafetyCenter {
  private rules: PermissionRule[] = [];
  private hooks: HookConfig = {};
  private signature?: string;
  private checkedAt = 0;
  private loading?: Promise<void>;
  private declined = new Set<string>();
  private vaults = new Map<string, SecretVault>();
  private knownSecrets = new Map<string, string>();
  /** Set by the hub: the saved name of a server given by name, IP or user@host. */
  remoteResolve?: (server: unknown) => string | undefined;
  private auditLog?: AuditLog;
  errors: string[] = [];

  constructor(private host: GuardHost) {}

  private get files() {
    const root = this.host.root;
    return { user: path.join(os.homedir(), '.infraon', 'settings.json'), project: path.join(root, '.infraon', 'settings.json'), local: path.join(root, '.infraon', 'settings.local.json') };
  }

  get redacting(): boolean { return this.host.policy.redactSecrets ?? this.host.cfg.get<boolean>('redactSecrets', true); }
  private get auditing(): boolean { return this.host.policy.auditLog ?? this.host.cfg.get<boolean>('auditLog', true); }

  get audit(): AuditLog {
    this.auditLog ??= new AuditLog(path.join(this.host.ctx.globalStorageUri.fsPath, 'audit'), { redact: (s) => new SecretVault().redact(s).text });
    return this.auditLog;
  }

  vault(sid: string): SecretVault {
    let v = this.vaults.get(sid);
    if (!v) { v = new SecretVault(); for (const [s, k] of this.knownSecrets) { v.addKnown(s, k); } this.vaults.set(sid, v); }
    return v;
  }

  forget(sid: string): void { this.vaults.delete(sid); }

  /** A value that must always be masked (a saved server password, for example), in every session. */
  addKnownSecret(value: string, kind: string): void {
    if (this.knownSecrets.has(value)) { return; }
    this.knownSecrets.set(value, kind);
    for (const v of this.vaults.values()) { v.addKnown(value, kind); }
  }
  async flush(): Promise<void> { await this.auditLog?.flush(); }

  /** Masks secrets in everything sent to the LLM. */
  wrapLlm(sid: string, llm: LlmFn): LlmFn {
    return (cfg, messages, tools, onToken, signal) => llm(cfg, this.redacting ? redactMessages(messages, this.vault(sid)) : messages, tools, onToken, signal);
  }

  private record(entry: Parameters<AuditLog['append']>[0]): void { if (this.auditing) { this.audit.append(entry); } }

  private async fileSignature(): Promise<string> {
    const stamps = await Promise.all(Object.values(this.files).map((f) => fs.stat(f).then((s) => `${s.mtimeMs}:${s.size}`, () => '-')));
    return `${stamps.join('|')}|${JSON.stringify(this.host.policy.permissions ?? null)}`;
  }

  /** Re-reads the settings only when one of the files changed (checked at most every two seconds). */
  async ensure(): Promise<void> {
    if (Date.now() - this.checkedAt < RECHECK_MS && this.signature !== undefined) { return; }
    this.loading ??= this.reload().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async reload(): Promise<void> {
    await this.host.policyReady;
    const signature = await this.fileSignature();
    this.checkedAt = Date.now();
    if (signature === this.signature) { return; }
    this.signature = signature;
    const policy = this.host.policy.permissions ? { permissions: this.host.policy.permissions } : undefined;
    const loaded = await loadPermissionSettings(this.files, policy);
    const parsed = (['user', 'project', 'local'] as const).map((source) => ({ source, ...parseHooks(loaded.hooks[source] ?? {}) }));
    const errors = [...loaded.errors, ...parsed.flatMap((p) => p.errors)];
    const repoAllow = loaded.rules.filter((r) => r.effect === 'allow' && (r.source === 'project' || r.source === 'local'));
    const repoHooks = parsed.filter((p) => p.source !== 'user' && Object.keys(p.config).length);
    const trusted = await this.trusted(repoAllow, repoHooks.map((p) => p.config));
    this.rules = trusted ? loaded.rules : loaded.rules.filter((r) => !repoAllow.includes(r));
    this.hooks = mergeHooks(parsed.filter((p) => trusted || p.source === 'user').map((p) => p.config));
    this.errors = errors;
    for (const e of errors) { this.host.output.appendLine(`[settings] ${e}`); }
  }

  /** Allow rules and hooks in a repository can run code, so they apply only after the user has reviewed them. */
  private async trusted(allow: PermissionRule[], hooks: HookConfig[]): Promise<boolean> {
    if (!allow.length && !hooks.length) { return true; }
    const hash = createHash('sha256').update(JSON.stringify({ allow: allow.map((r) => r.raw).sort(), hooks })).digest('hex');
    const state = this.host.ctx.workspaceState;
    if (state.get<string>(TRUST_KEY) === hash) { return true; }
    if (this.declined.has(hash)) { return false; }
    const commands = hooks.flatMap((c) => Object.values(c).flat()).flatMap((m) => m?.hooks ?? []).map((h) => h.command);
    const detail = [...allow.map((r) => `Always allow: ${r.raw}`), ...commands.map((c) => `Run hook: ${c}`)].slice(0, 20).join('\n');
    const pick = await vscode.window.showWarningMessage('This repository wants to set agent permissions and hooks. Allow them only if you trust it.', { modal: true, detail }, 'Trust');
    if (pick !== 'Trust') { this.declined.add(hash); return false; }
    await state.update(TRUST_KEY, hash);
    return true;
  }

  private async fire(event: HookEvent, payload: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<HookOutcome> {
    await this.ensure();
    if (!hasHooks(this.hooks, event)) { return { blocked: false }; }
    const r = await runHooks(event, { hook_event_name: event, cwd, ...payload }, this.hooks, { cwd, signal });
    for (const h of r.results) { this.record({ sessionId: String(payload.session_id), agentId: String(payload.agent_id), kind: 'hook', tool: event, detail: h.command, outcome: h.timedOut ? 'timeout' : `exit ${h.code}`, ms: h.ms }); }
    return { blocked: r.blocked, reason: r.reason, context: r.context };
  }

  private async decide(req: ToolRequest, sid: string, aid: string): Promise<GuardDecision> {
    await this.ensure();
    // Rules and approvals are keyed by the saved name, so a server given by its IP gets the same treatment.
    if (req.tool.startsWith('remote_') && req.args && typeof req.args === 'object' && 'server' in req.args) {
      const name = this.remoteResolve?.(req.args.server);
      if (name) { req.args.server = name; }
    }
    const d = evaluatePermission(this.rules, { tool: req.tool, kind: req.kind, args: req.args, root: req.root });
    if (d.effect) { this.record({ sessionId: sid, agentId: aid, kind: 'permission', tool: req.tool, detail: describe(req), outcome: d.effect, ruleRaw: d.rule?.raw }); }
    if (d.effect === 'deny') { return { effect: 'deny', reason: d.rule?.raw ?? d.reason }; }
    // Transfers touch local files too: read rules guard what is uploaded, edit rules what is downloaded.
    if (req.tool === 'remote_upload' || req.tool === 'remote_download') {
      const up = req.tool === 'remote_upload';
      const local = evaluatePermission(this.rules, { tool: up ? 'read_file' : 'write_file', kind: up ? 'read' : 'edit', args: { path: req.args?.local_path }, root: req.root });
      if (local.effect === 'deny') { return { effect: 'deny', reason: local.rule?.raw ?? local.reason }; }
      if (!up && PROTECTED.test(String(req.args?.local_path ?? ''))) { return { effect: 'ask', reason: 'agent permission settings are protected' }; }
    }
    // Auto-execute runs everything without asking. The one exception, unless the user turned it off, is a command that
    // could wreck the server and cannot be undone (reboot, formatting a disk, deleting system folders).
    if (req.tool === 'remote_exec' && d.effect !== 'allow' && this.host.cfg.get<boolean>('confirmDangerousRemoteCommands', true)) {
      const danger = catastrophicReason(req.args?.command);
      if (danger) { return { effect: 'ask', reason: `this command could ${danger} (turn off "Confirm Dangerous Remote Commands" in settings to skip this)` }; }
    }
    // Commands that only look at a server are as harmless as reading a file, so "Edit automatically" runs them too.
    if (req.tool === 'remote_exec' && d.effect === undefined && req.mode === 'auto-edit' && isReadOnlyCommand(req.args?.command)) { return { effect: 'allow', reason: 'read-only command' }; }
    const target = String(req.args?.path ?? '');
    if ((req.kind === 'edit' && PROTECTED.test(target)) || (req.kind === 'exec' && PROTECTED_IN_COMMAND.test(String(req.args?.command ?? '')))) {
      return { effect: 'ask', reason: 'agent permission settings are protected' };
    }
    // A saved session may still be in auto mode after the policy turned that mode off.
    if (this.host.policy.disableAutoMode && req.mode === 'auto' && d.effect !== 'allow' && requiresApproval('auto-edit', req.kind)) { return { effect: 'ask', reason: 'auto mode is disabled by policy' }; }
    return { effect: d.effect, reason: d.rule ? `the permission rule "${d.rule.raw}" (${d.rule.source} settings) says so` : undefined };
  }

  guardFor(sid: string, aid: string, root: string, isSub: boolean): AgentGuard {
    const ids = { session_id: sid, agent_id: aid };
    return {
      restoreArgs: (args) => {
        const vault = this.vault(sid);
        const restored = vault.restoreValue(args);
        if (vault.hasUnknownPlaceholder(JSON.stringify(restored))) { throw new Error('These arguments contain a masked secret from an earlier VS Code session, so they were not applied. Read the file again and retry.'); }
        return restored;
      },
      decide: (req) => this.decide(req, sid, aid),
      beforeTool: (req, signal) => this.fire('PreToolUse', { ...ids, tool_name: req.tool, tool_input: req.args }, root, signal),
      afterTool: async (req, ok, result, ms, signal) => {
        this.record({ sessionId: sid, agentId: aid, kind: 'tool', tool: req.tool, detail: describe(req), outcome: ok ? 'ok' : 'failed', ms });
        return this.fire('PostToolUse', { ...ids, tool_name: req.tool, tool_input: req.args, tool_response: result.slice(0, 20000), success: ok }, root, signal);
      },
      onApproval: (req, outcome) => {
        this.record({ sessionId: sid, agentId: aid, kind: 'approval', tool: req.tool, detail: describe(req), outcome });
        if (outcome === 'asked') { void this.fire('Notification', { ...ids, message: `Approval needed: ${describe(req)}` }, root).catch(() => undefined); }
      },
      onPrompt: (text, signal) => {
        this.record({ sessionId: sid, agentId: aid, kind: 'prompt', detail: text });
        return this.fire('UserPromptSubmit', { ...ids, prompt: text }, root, signal);
      },
      onStop: (signal) => this.fire(isSub ? 'SubagentStop' : 'Stop', ids, root, signal),
    };
  }

  describeRules(): string {
    const rows = this.rules.map((r) => `${r.effect.padEnd(5)} ${r.raw}  (${r.source})`);
    const hookCount = Object.values(this.hooks).flat().reduce((n, m) => n + (m?.hooks.length ?? 0), 0);
    return [rows.length ? rows.join('\n') : 'No permission rules are set.', `${hookCount} hook${hookCount === 1 ? '' : 's'} active.`, ...this.errors.map((e) => `! ${e}`)].join('\n');
  }

  settingsFile(): string { return this.files.project; }
}

function describe(req: ToolRequest): string {
  const where = req.args?.server ? `${req.args.server}: ` : '';
  return where + String(req.args?.command ?? req.args?.path ?? req.args?.local_path ?? req.args?.pattern ?? JSON.stringify(req.args ?? {}));
}
