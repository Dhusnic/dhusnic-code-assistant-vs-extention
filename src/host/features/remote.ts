import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RemoteHost, RemoteServerInfo, createRemoteTools, parseHostSpec, resolveServer } from '../../core/remoteTools';
import { HostKeyInfo, SshPool, SshTarget } from '../../core/ssh';
import { Tool, fnSpec } from '../../core/tool';
import { ServerRegistry, checkLinux } from './servers';

const HOST_KEYS = 'sshHostKeys';
const MAX_ATTEMPTS = 3;

/** The prompts connect_server shows; replaceable so the UI tests can answer them. */
export interface ConnectPrompts {
  input(o: vscode.InputBoxOptions, token: vscode.CancellationToken): Thenable<string | undefined>;
  pickKeyFile(): Thenable<vscode.Uri[] | undefined>;
}

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
  private connectToolDef?: Tool;
  prompts: ConnectPrompts = {
    input: (o, token) => vscode.window.showInputBox(o, token),
    pickKeyFile: () => vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use this private key', title: 'Choose your SSH private key', defaultUri: vscode.Uri.file(path.join(os.homedir(), '.ssh')) }),
  };

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

  /** connect_server is always offered, so the agent can add the first server; the rest once a server is saved. */
  tools(): Tool[] {
    this.connectToolDef ??= this.connectTool();
    if (!this.deps.servers.linuxSync().length) { return [this.connectToolDef]; }
    this.toolset ??= createRemoteTools(this.host());
    return [...this.toolset.tools, this.connectToolDef];
  }

  private connectTool(): Tool {
    return {
      kind: 'meta',
      spec: fnSpec('connect_server', 'Connect to a Linux server that is not saved yet. VS Code asks the user for the user name (if you do not pass it) and the password or private key in a secure prompt that you never see, tests the connection, and saves the server so remote_exec and the other remote tools can use it. Use it whenever the user asks you to work on a server address that list_servers does not show. Never ask for the password in the chat, even if the user offers it: this prompt is the safe way.', {
        host: { type: 'string', description: 'IP address or host name; user@host and host:port also work.' },
        user: { type: 'string', description: 'User name, if the user said it (for example root).' },
        port: { type: 'number', description: 'SSH port (default 22).' },
        name: { type: 'string', description: 'Optional name to save it under (default: the address).' },
        notes: { type: 'string', description: 'Optional notes for later work: app folder, service names, health check.' },
      }, ['host']),
      describe: (a) => { const h = parseHostSpec(a.host, a.user, a.port); return `Connect to ${h.user ? `${h.user}@` : ''}${h.host} (you enter the credentials)`; },
      run: (a, ctx) => this.connectAndSave(a, ctx.signal),
    };
  }

  /** Asks the user for credentials, tests them (up to three tries) and saves the server on success. */
  async connectAndSave(a: any, signal: AbortSignal): Promise<string> {
    const spec = parseHostSpec(a.host, a.user, a.port);
    const servers = this.deps.servers;
    const already = resolveServer(servers.linuxSync(), spec.user ? `${spec.user}@${spec.host}` : spec.host);
    if (already && (!spec.user || already.user === spec.user) && already.port === spec.port) {
      return `${already.user}@${already.host}:${already.port} is already saved as "${already.name}". Use server "${already.name}" with remote_exec.`;
    }
    const cts = new vscode.CancellationTokenSource();
    const onAbort = () => cts.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    const cancelled = () => (signal.aborted ? 'Cancelled.' : `The user cancelled connecting to ${spec.host}. Ask how they want to continue.`);
    try {
      const probe = checkLinux({ name: 'x', host: spec.host, port: spec.port, user: spec.user ?? 'root', auth: 'password', password: 'x', env: {} }, false);
      if (probe && probe.field !== 'user') { throw new Error(`${probe.message} (${String(a.host)})`); }
      let user = spec.user;
      if (!user) {
        user = (await this.prompts.input({
          title: `Connect to ${spec.host}:${spec.port}`, prompt: 'User name for SSH', value: 'root', ignoreFocusOut: true,
          validateInput: (v) => (checkLinux({ name: 'x', host: spec.host, port: spec.port, user: v.trim(), auth: 'password', password: 'x', env: {} }, false)?.field === 'user' ? 'Enter a valid user name.' : undefined),
        }, cts.token))?.trim();
        if (!user) { return cancelled(); }
      }
      let problem = '';
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const password = await this.prompts.input({
          title: `Connect to ${user}@${spec.host}:${spec.port}${attempt > 1 ? ` (try ${attempt} of ${MAX_ATTEMPTS})` : ''}`,
          prompt: problem || 'Password. Leave empty to use a private key file instead. It is stored in encrypted storage and never shown to the AI.',
          password: true, ignoreFocusOut: true,
        }, cts.token);
        if (password === undefined) { return cancelled(); }
        let key: string | undefined, passphrase: string | undefined;
        if (!password) {
          const files = await this.prompts.pickKeyFile();
          if (!files?.length) { return cancelled(); }
          key = await fs.readFile(files[0].fsPath, 'utf8');
          if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) { problem = `${path.basename(files[0].fsPath)} is not a private key file. Try again.`; continue; }
          if (/ENCRYPTED/.test(key) || /bcrypt/.test(Buffer.from(key.replace(/-----[^-]+-----|\s/g, ''), 'base64').toString('latin1'))) {
            passphrase = await this.prompts.input({ title: 'Key passphrase', prompt: 'This key is protected by a passphrase.', password: true, ignoreFocusOut: true }, cts.token);
            if (passphrase === undefined) { return cancelled(); }
          }
        }
        if (password) { this.deps.addKnownSecret(password, 'server_password'); }
        let out: string;
        try {
          out = await this.test({ name: spec.host, host: spec.host, port: spec.port, user, password: password || undefined, privateKey: key, passphrase });
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          if (/Authentication/i.test(msg) && attempt < MAX_ATTEMPTS) { problem = `That ${key ? 'key' : 'password'} was not accepted for ${user}@${spec.host}. Try again.`; continue; }
          return `Could not connect to ${user}@${spec.host}:${spec.port}: ${msg} Nothing was saved.`;
        }
        const name = this.freeName(String(a.name ?? '').trim() || `${user}@${spec.host}`);
        await servers.saveLinux(undefined, { name, host: spec.host, port: spec.port, user, auth: key ? 'key' : 'password', password: password || undefined, key, passphrase, env: {}, notes: typeof a.notes === 'string' ? a.notes : undefined });
        this.deps.onStatus();
        void vscode.window.showInformationMessage(`Saved the server "${name}" (${user}@${spec.host}). Its credentials are in encrypted storage.`);
        return `Connected: ${out}\nSaved as "${name}" (${user}@${spec.host}:${spec.port}). Use server "${name}" (or its IP) with remote_exec. The credentials are stored securely and you never see them.`;
      }
      return `The credentials for ${user}@${spec.host} were not accepted ${MAX_ATTEMPTS} times. Nothing was saved.`;
    } finally {
      signal.removeEventListener('abort', onAbort);
      cts.dispose();
    }
  }

  /** A server name that is not taken yet. */
  private freeName(wanted: string): string {
    const clean = wanted.replace(/[^\w .@-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60) || 'server';
    const taken = new Set(this.deps.servers.linuxSync().map((s) => s.name.toLowerCase()));
    if (!taken.has(clean.toLowerCase())) { return clean; }
    for (let i = 2; ; i++) { const n = `${clean}-${i}`; if (!taken.has(n.toLowerCase())) { return n; } }
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
