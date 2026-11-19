import * as vscode from 'vscode';

/**
 * Servers shown in the sidebar. MCP servers live in the `infraonAssistant.mcpServers` setting (user scope only:
 * workspace entries are shown read-only). Linux server details live in global state and every credential
 * (password, private key, environment values) lives in VS Code's encrypted secret storage, never in settings.
 */

export type ServerKind = 'mcp' | 'linux';
export interface McpServerView { name: string; command: string; args: string[]; env: Record<string, string>; status?: string; editable: boolean }
export interface LinuxServer { name: string; host: string; port: number; user: string; auth: 'password' | 'key'; envKeys: string[]; notes?: string; alwaysAsk?: boolean }
export interface LinuxServerView extends LinuxServer { hasCredential: boolean; connected?: boolean }
export interface LinuxSecret { password?: string; key?: string; passphrase?: string; env?: Record<string, string> }

export interface McpInput { name: string; commandLine: string; env: Record<string, string> }
/** For an existing server, an empty password, key or environment value keeps the stored one. */
export interface LinuxInput { name: string; host: string; port: number; user: string; auth: 'password' | 'key'; password?: string; key?: string; passphrase?: string; env: Record<string, string>; notes?: string; alwaysAsk?: boolean }

const STATE_KEY = 'linuxServers';
const NAME_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;
const HOST_RE = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}))$/;
const USER_RE = /^[A-Za-z0-9_][\w.-]{0,63}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const secretKey = (name: string) => `infraonAssistant.linuxServer.${name}`;

/** Splits a command line into words, honouring single and double quotes. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', quote: string | undefined, has = false;
  for (const ch of line.trim()) {
    if (quote) { if (ch === quote) { quote = undefined; } else { cur += ch; } continue; }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) { out.push(cur); cur = ''; has = false; } continue; }
    cur += ch; has = true;
  }
  if (quote) { throw new Error('The command has an unclosed quote.'); }
  if (has || cur) { out.push(cur); }
  return out;
}

export const joinCommandLine = (command: string, args: string[] = []): string =>
  [command, ...args].map((a) => (/[\s"']/.test(a) || !a ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');

function checkEnv(env: Record<string, string>): string | undefined {
  const bad = Object.keys(env).find((k) => !ENV_RE.test(k));
  return bad === undefined ? undefined : `"${bad}" is not a valid environment variable name.`;
}

export function validateMcp(input: McpInput): string | undefined {
  if (!NAME_RE.test(input.name)) { return 'Use a name of letters, digits, dots, dashes or underscores (up to 64).'; }
  let words: string[];
  try { words = splitCommandLine(input.commandLine); } catch (e: any) { return e.message; }
  if (!words.length || !words[0]) { return 'Enter the command that starts the MCP server.'; }
  return checkEnv(input.env);
}

export function validateLinux(input: LinuxInput, isNew: boolean): string | undefined {
  if (!NAME_RE.test(input.name)) { return 'Use a name of letters, digits, dots, dashes or underscores (up to 64).'; }
  if (!HOST_RE.test(input.host)) { return 'Enter a valid IP address or host name.'; }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) { return 'The port must be a number from 1 to 65535.'; }
  if (!USER_RE.test(input.user)) { return 'Enter a valid user name.'; }
  if (input.auth !== 'password' && input.auth !== 'key') { return 'Choose password or SSH key authentication.'; }
  if (isNew && input.auth === 'password' && !input.password) { return 'Enter the password.'; }
  if (isNew && input.auth === 'key' && !input.key?.trim()) { return 'Paste the private key.'; }
  if (input.key?.trim() && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(input.key)) { return 'That does not look like a private key (it should start with -----BEGIN … PRIVATE KEY-----).'; }
  if ((input.notes ?? '').length > 4000) { return 'Keep the notes under 4000 characters.'; }
  return checkEnv(input.env);
}

export class ServerRegistry {
  constructor(
    private ctx: vscode.ExtensionContext,
    private reloadMcp: () => Promise<void>,
    private mcpStatus: (name: string) => string | undefined,
  ) {}

  private get cfg() { return vscode.workspace.getConfiguration('infraonAssistant'); }
  /** Only user-level entries are written; configuration values are read-only, so they are always copied first. */
  private userMcp(): Record<string, any> { return JSON.parse(JSON.stringify(this.cfg.inspect<Record<string, any>>('mcpServers')?.globalValue ?? {})); }

  mcpList(): McpServerView[] {
    const user = this.userMcp();
    const all = this.cfg.get<Record<string, any>>('mcpServers', {});
    return Object.entries(all).map(([name, c]) => ({
      name, command: String(c?.command ?? ''), args: Array.isArray(c?.args) ? c.args.map(String) : [], env: c?.env && typeof c.env === 'object' ? { ...c.env } : {},
      status: this.mcpStatus(name), editable: Object.prototype.hasOwnProperty.call(user, name),
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Saved Linux servers (no credentials). */
  linuxSync(): LinuxServer[] { return this.linux(); }

  private linux(): LinuxServer[] { return [...(this.ctx.globalState.get<LinuxServer[]>(STATE_KEY) ?? [])]; }
  private async saveLinuxList(list: LinuxServer[]): Promise<void> { await this.ctx.globalState.update(STATE_KEY, list.sort((a, b) => a.name.localeCompare(b.name))); }
  private async secret(name: string): Promise<LinuxSecret> {
    try { return JSON.parse((await this.ctx.secrets.get(secretKey(name))) ?? '{}'); } catch { return {}; }
  }

  async linuxList(): Promise<LinuxServerView[]> {
    return Promise.all(this.linux().map(async (s) => { const c = await this.secret(s.name); return { ...s, hasCredential: !!(s.auth === 'key' ? c.key : c.password) }; }));
  }

  /** Credentials for a Linux server, for code that connects to it. */
  async credentials(name: string): Promise<LinuxSecret> { return this.secret(name); }

  async saveMcp(original: string | undefined, input: McpInput): Promise<void> {
    const err = validateMcp(input);
    if (err) { throw new Error(err); }
    const servers = this.userMcp();
    if (original && !servers[original]) { throw new Error(`"${original}" is defined in the workspace settings and cannot be edited here.`); }
    if (input.name !== original && this.cfg.get<Record<string, any>>('mcpServers', {})[input.name]) { throw new Error(`A server named "${input.name}" already exists.`); }
    const [command, ...args] = splitCommandLine(input.commandLine);
    const previous = original ? servers[original] : undefined;
    if (original) { delete servers[original]; }
    servers[input.name] = { ...previous, command, args, env: input.env };
    await this.cfg.update('mcpServers', servers, vscode.ConfigurationTarget.Global);
    await this.reloadMcp();
  }

  async saveLinux(original: string | undefined, input: LinuxInput): Promise<void> {
    const err = validateLinux(input, !original);
    if (err) { throw new Error(err); }
    const list = this.linux();
    if (original && !list.some((s) => s.name === original)) { throw new Error(`The server "${original}" no longer exists.`); }
    if (input.name !== original && list.some((s) => s.name === input.name)) { throw new Error(`A server named "${input.name}" already exists.`); }
    const old = original ? await this.secret(original) : {};
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.env)) { env[k] = v || old.env?.[k] || ''; }
    const secret: LinuxSecret = {
      password: input.auth === 'password' ? (input.password || old.password) : undefined,
      key: input.auth === 'key' ? (input.key?.trim() ? input.key : old.key) : undefined,
      passphrase: input.auth === 'key' ? (input.passphrase || (input.key?.trim() ? undefined : old.passphrase)) : undefined,
      env,
    };
    if (input.auth === 'password' && !secret.password) { throw new Error('Enter the password.'); }
    if (input.auth === 'key' && !secret.key) { throw new Error('Paste the private key.'); }
    // Write the new secret before removing the old one, so a failure never loses the credential.
    await this.ctx.secrets.store(secretKey(input.name), JSON.stringify(secret));
    if (original && original !== input.name) { await this.ctx.secrets.delete(secretKey(original)); }
    const entry: LinuxServer = { name: input.name, host: input.host, port: input.port, user: input.user, auth: input.auth, envKeys: Object.keys(env), notes: input.notes?.trim() || undefined, alwaysAsk: input.alwaysAsk !== false };
    await this.saveLinuxList([...list.filter((s) => s.name !== original && s.name !== input.name), entry]);
  }

  async remove(kind: ServerKind, name: string): Promise<boolean> {
    if (kind === 'mcp') {
      const servers = this.userMcp();
      if (!servers[name]) { return false; }
      delete servers[name];
      await this.cfg.update('mcpServers', Object.keys(servers).length ? servers : undefined, vscode.ConfigurationTarget.Global);
      await this.reloadMcp();
      return true;
    }
    const list = this.linux();
    if (!list.some((s) => s.name === name)) { return false; }
    await this.saveLinuxList(list.filter((s) => s.name !== name));
    await this.ctx.secrets.delete(secretKey(name));
    return true;
  }

  async clone(kind: ServerKind, name: string, newName: string): Promise<void> {
    if (!NAME_RE.test(newName)) { throw new Error('Use a name of letters, digits, dots, dashes or underscores (up to 64).'); }
    if (kind === 'mcp') {
      const all = this.cfg.get<Record<string, any>>('mcpServers', {});
      if (!all[name]) { throw new Error(`The server "${name}" no longer exists.`); }
      if (all[newName]) { throw new Error(`A server named "${newName}" already exists.`); }
      const servers = this.userMcp();
      servers[newName] = JSON.parse(JSON.stringify(all[name]));
      await this.cfg.update('mcpServers', servers, vscode.ConfigurationTarget.Global);
      await this.reloadMcp();
      return;
    }
    const list = this.linux();
    const src = list.find((s) => s.name === name);
    if (!src) { throw new Error(`The server "${name}" no longer exists.`); }
    if (list.some((s) => s.name === newName)) { throw new Error(`A server named "${newName}" already exists.`); }
    await this.ctx.secrets.store(secretKey(newName), JSON.stringify(await this.secret(name)));
    await this.saveLinuxList([...list, { ...src, name: newName }]);
  }
}
