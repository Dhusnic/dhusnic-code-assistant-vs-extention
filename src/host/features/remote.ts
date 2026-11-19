import * as vscode from 'vscode';
import { RemoteHost, RemoteServerInfo, createRemoteTools, resolveServer } from '../../core/remoteTools';
import { HostKeyInfo, SshPool, SshTarget } from '../../core/ssh';
import { Tool } from '../../core/tool';
import type { ServerRegistry } from './servers';

const HOST_KEYS = 'sshHostKeys';

export interface RemoteDeps {
  ctx: vscode.ExtensionContext;
  servers: ServerRegistry;
  /** Tells the secret masker about a credential so it never reaches the LLM, even if a command prints it. */
  addKnownSecret(value: string, kind: string): void;
  onStatus(): void;
}

/**
 * Connects the agent to the Linux servers saved in the sidebar. Credentials come from the server registry's
 * encrypted secret storage; host keys are trusted once by the user and checked on every later connection.
 */
export class RemoteService implements vscode.Disposable {
  readonly pool: SshPool;
  private toolset?: ReturnType<typeof createRemoteTools>;

  constructor(private deps: RemoteDeps) {
    this.pool = new SshPool({ verifyHostKey: (i) => this.verifyHostKey(i), onStatus: () => deps.onStatus() });
  }

  private hostKeys(): Record<string, string> { return { ...this.deps.ctx.globalState.get<Record<string, string>>(HOST_KEYS, {}) }; }

  /** Trust on first use, with the fingerprint shown to the user; a changed key is always refused. */
  async verifyHostKey(i: HostKeyInfo): Promise<boolean> {
    const id = `${i.host}:${i.port}`;
    const keys = this.hostKeys();
    if (keys[id] === i.fingerprint) { return true; }
    if (keys[id]) {
      void vscode.window.showErrorMessage(
        `The host key of ${i.server} (${id}) has changed, so the connection was refused. This happens when the server was reinstalled, but it can also mean someone is intercepting the connection. If you are sure the change is expected, run "Infraon Assistant: Forget SSH Host Key".`,
        { modal: true });
      throw new Error(`The host key of ${i.server} changed (now ${i.fingerprint}). The connection was refused for safety; the user must confirm the change.`);
    }
    const pick = await vscode.window.showWarningMessage(`Connect to ${i.server} (${id}) for the first time?`, {
      modal: true, detail: `Its host key fingerprint is:\n${i.fingerprint}\n\nCompare it with the server's real fingerprint (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub) before trusting it.`,
    }, 'Trust and connect');
    if (pick !== 'Trust and connect') { return false; }
    await this.deps.ctx.globalState.update(HOST_KEYS, { ...this.hostKeys(), [id]: i.fingerprint });
    return true;
  }

  async forgetHostKey(): Promise<void> {
    const keys = this.hostKeys();
    const ids = Object.keys(keys);
    if (!ids.length) { void vscode.window.showInformationMessage('No SSH host keys are saved.'); return; }
    const pick = await vscode.window.showQuickPick(ids.map((id) => ({ label: id, description: keys[id] })), { placeHolder: 'Forget the saved host key of…' });
    if (!pick) { return; }
    delete keys[pick.label];
    await this.deps.ctx.globalState.update(HOST_KEYS, keys);
    void vscode.window.showInformationMessage(`Forgot the host key of ${pick.label}. The next connection asks you to trust it again.`);
  }

  /** Connection details for a saved server, with its credentials registered for masking. */
  async target(name: string): Promise<SshTarget> {
    const s = this.deps.servers.linuxSync().find((x) => x.name === name);
    if (!s) { throw new Error(`Unknown server "${name}".`); }
    const c = await this.deps.servers.credentials(name);
    for (const [value, kind] of [[c.password, 'server_password'], [c.passphrase, 'server_password'], ...Object.values(c.env ?? {}).map((v) => [v, 'server_env'])] as Array<[string | undefined, string]>) {
      if (value && value.length >= 4) { this.deps.addKnownSecret(value, kind); }
    }
    if (s.auth === 'key' ? !c.key : !c.password) { throw new Error(`No ${s.auth === 'key' ? 'private key' : 'password'} is saved for ${name}. Edit the server in the Infraon sidebar to add it.`); }
    return { name, host: s.host, port: s.port, user: s.user, password: s.auth === 'password' ? c.password : undefined, privateKey: s.auth === 'key' ? c.key : undefined, passphrase: c.passphrase, env: c.env };
  }

  /** Registers every saved credential with the masker, so secrets typed into a chat are masked even before first use. */
  async preloadSecrets(): Promise<void> {
    for (const s of this.deps.servers.linuxSync()) { await this.target(s.name).catch(() => undefined); }
  }

  private host(): RemoteHost {
    return {
      pool: this.pool,
      target: (name) => this.target(name),
      servers: (): RemoteServerInfo[] => this.deps.servers.linuxSync().map((s) => ({ name: s.name, host: s.host, port: s.port, user: s.user, auth: s.auth, notes: s.notes, alwaysAsk: s.alwaysAsk === true })),
    };
  }

  /** The remote tools, offered only while at least one Linux server is saved (no token cost otherwise). */
  tools(): Tool[] {
    if (!this.deps.servers.linuxSync().length) { return []; }
    this.toolset ??= createRemoteTools(this.host());
    return this.toolset.tools;
  }

  /** The saved name of the server a tool call refers to (by name, IP or user@host). */
  resolveName(server: unknown): string | undefined { return resolveServer(this.deps.servers.linuxSync(), server)?.name; }

  /** Whether a remote tool call targets a server that wants approval for every change, even in Auto-execute. */
  alwaysAsk(server: unknown): boolean {
    const s = resolveServer(this.deps.servers.linuxSync(), server);
    return s?.alwaysAsk === true;
  }

  /** Connects with the given details and runs a harmless command. Used by "Test connection". */
  async test(t: SshTarget): Promise<string> {
    const probe = new SshPool({ verifyHostKey: (i) => this.verifyHostKey(i), connectTimeoutMs: 15_000 });
    try {
      const r = await probe.exec(t, 'echo "connected as $(whoami) on $(hostname)"; uname -srm', { timeoutMs: 15_000 });
      return `${r.output.trim()}${r.code ? ` (exit ${r.code})` : ''}`;
    } finally { probe.dispose(); }
  }

  isConnected(name: string): boolean { return this.pool.connected.has(name); }

  dispose(): void { this.toolset?.dispose(); this.pool.dispose(); }
}
