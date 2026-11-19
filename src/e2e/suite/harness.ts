import * as vscode from 'vscode';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { API_KEY, ENV, GatewayState, RecordedMessage, RecordedRequest, ScreenshotResult, ScriptStep, ToolCallSpec } from '../protocol';

export const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_WAIT_MS = 10_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Polls until `fn` returns something truthy. Exceptions count as "not yet"; the last one is included in the
 * timeout message, together with `detail()` when given.
 */
export async function waitFor<T>(what: string, fn: () => T | Promise<T>, timeoutMs = DEFAULT_WAIT_MS, detail?: () => string): Promise<NonNullable<T>> {
  const started = Date.now();
  let lastError = '';
  for (;;) {
    try {
      const v = await fn();
      if (v) { return v as NonNullable<T>; }
      lastError = '';
    } catch (e: any) { lastError = e?.message ?? String(e); }
    if (Date.now() - started > timeoutMs) {
      const extra = [detail?.(), lastError && `last error: ${lastError}`].filter(Boolean).join('; ');
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${extra ? ` (${extra})` : ''}`);
    }
    await sleep(40);
  }
}

/* ------------------------------------------------------------ scripted LLM replies */

export const reply = (text: string, extra: Partial<ScriptStep> = {}): ScriptStep => ({ text, ...extra });
export const callTool = (name: string, args: unknown, extra: Partial<ScriptStep> = {}): ScriptStep => ({ toolCalls: [{ name, args } as ToolCallSpec], ...extra });

/** Talks to the fake gateway running in the test runner process. */
export class GatewayClient {
  constructor(private base: string) {}

  private call(action: string, body?: unknown): Promise<any> {
    const data = body === undefined ? '' : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(`${this.base}/__e2e/${action}`, { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (out += d));
        res.on('end', () => { try { resolve(out ? JSON.parse(out) : {}); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.end(data);
    });
  }

  reset(): Promise<void> { return this.call('reset', {}); }
  script(...steps: ScriptStep[]): Promise<void> { return this.call('script', { steps }); }
  release(name: string): Promise<void> { return this.call('release', { name }); }
  state(): Promise<GatewayState> { return this.call('state', {}); }
  screenshot(name: string): Promise<ScreenshotResult> { return this.call('screenshot', { name }); }
  async requests(): Promise<RecordedRequest[]> { return (await this.state()).requests; }
  /** The most recent chat request. */
  async last(): Promise<RecordedRequest> {
    const all = await this.requests();
    if (!all.length) { throw new Error('the gateway received no chat request'); }
    return all[all.length - 1];
  }
}

/** Text of the last message with a given role in a recorded request. */
export function lastOfRole(r: RecordedRequest, role: string): RecordedMessage | undefined {
  return [...r.messages].reverse().find((m) => m.role === role);
}

/* ------------------------------------------------------------ driving webviews through media/probe.js */

export interface QueryResult { count: number; texts: string[]; visible: boolean; value?: string; disabled: boolean; checked: boolean; attrs?: Record<string, string>; scroll?: { top: number; height: number; client: number } }
export interface WaitOptions { text?: string; count?: number; visible?: boolean; timeoutMs?: number }

export class WebviewDriver {
  constructor(protected hub: any, readonly target: string, readonly label: string) {}

  async probe(msg: Record<string, unknown>, timeoutMs = 2500): Promise<any> {
    const r = await this.hub.probe(this.target, msg, timeoutMs);
    if (r && r.error) { throw new Error(`${this.label}: ${r.error}`); }
    return r;
  }

  query(selector: string, index = 0): Promise<QueryResult> { return this.probe({ action: 'query', selector, index }); }
  async texts(selector: string): Promise<string[]> { return (await this.query(selector)).texts; }
  async text(selector: string): Promise<string> { return (await this.texts(selector)).join('\n'); }
  async count(selector: string): Promise<number> { return (await this.query(selector)).count; }

  /** Waits until `selector` matches, optionally with some element containing `text`, an exact count, or visible. */
  async waitFor(selector: string, o: WaitOptions = {}): Promise<QueryResult> {
    let last: QueryResult | undefined;
    const want = [o.text !== undefined ? `text "${o.text}"` : '', o.count !== undefined ? `count ${o.count}` : '', o.visible ? 'visible' : ''].filter(Boolean).join(', ');
    return waitFor<QueryResult | undefined>(`${this.label} ${selector}${want ? ` [${want}]` : ''}`, async () => {
      const r = last = await this.query(selector);
      if (o.count !== undefined ? r.count !== o.count : !r.count) { return undefined; }
      if (o.text !== undefined && !r.texts.some((t) => t.includes(o.text!))) { return undefined; }
      if (o.visible && !r.visible) { return undefined; }
      return r;
    }, o.timeoutMs, () => (last ? `found ${last.count}: ${JSON.stringify(last.texts.slice(0, 5))}` : 'no answer from the webview'));
  }

  waitGone(selector: string, timeoutMs?: number): Promise<QueryResult> { return this.waitFor(selector, { count: 0, timeoutMs }); }

  async click(selector: string, index = 0): Promise<void> {
    await this.waitFor(selector);
    await this.probe({ action: 'click', selector, index });
  }

  /** Clicks the element whose text equals `text` (or, failing that, contains it). */
  async clickText(selector: string, text: string): Promise<void> {
    const i = await waitFor(`${this.label} ${selector} with text "${text}"`, async () => {
      const t = await this.texts(selector);
      const exact = t.indexOf(text);
      const at = exact >= 0 ? exact : t.findIndex((x) => x.includes(text));
      return at >= 0 ? at + 1 : 0;
    });
    await this.probe({ action: 'click', selector, index: i - 1 });
  }

  async input(selector: string, value: string, index = 0): Promise<void> {
    await this.waitFor(selector);
    await this.probe({ action: 'input', selector, value, index });
  }

  async check(selector: string, value: boolean, index = 0): Promise<void> {
    await this.waitFor(selector);
    await this.probe({ action: 'check', selector, value, index });
  }

  /** Scrolls an element (like the user's mouse wheel). */
  async scrollTo(selector: string, top: number): Promise<void> {
    await this.waitFor(selector);
    await this.probe({ action: 'scroll', selector, value: top });
  }

  async key(selector: string, key: string, mods: { ctrl?: boolean; shift?: boolean } = {}): Promise<void> {
    await this.probe({ action: 'key', selector, key, ...mods });
  }
}

export class SessionDriver extends WebviewDriver {
  constructor(hub: any, readonly id: string) { super(hub, id, `session ${id}`); }

  /** Resolves once the tab has rendered and answers probes. */
  ready(): Promise<unknown> {
    return waitFor(`session tab ${this.id} to render`, () => this.hub.probe(this.id, { action: 'query', selector: '#in' }, 700), 20_000);
  }

  get runtime(): any { return this.hub.manager.sessions.get(this.id); }
  get main(): any { return this.runtime.main(); }
  private get panel(): any { return this.hub.panels?.get(this.id)?.panel; }

  /** Types into the composer and clicks Send, as a user would. */
  async send(text: string): Promise<void> {
    await this.waitFor('#send', { visible: true });
    await this.input('#in', text);
    await this.click('#send');
  }

  /** The agent finished its turn and the composer shows Send again. */
  idle(timeoutMs = 15_000): Promise<unknown> {
    return waitFor(`session ${this.id} to become idle`, async () => {
      const s = this.runtime;
      if (!s || [...s.agents.values()].some((a: any) => a.busy)) { return false; }
      return (await this.query('#send')).visible;
    }, timeoutMs, () => `status ${this.runtime?.main()?.status}`);
  }

  async reveal(): Promise<void> {
    const p = this.panel;
    if (!p) { return; }
    p.reveal();
    await waitFor(`session ${this.id} tab to become active`, () => p.active, 3000).catch(() => undefined);
  }

  /** Closes the tab the way the user does. */
  async close(): Promise<void> {
    await this.reveal();
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await waitFor(`session ${this.id} tab to close`, () => !this.hub.openPanelIds().includes(this.id));
  }
}

/* ------------------------------------------------------------ the harness */

export class Harness {
  private constructor(readonly hub: any, readonly gw: GatewayClient, readonly workspace: string, readonly ext: vscode.Extension<unknown>, readonly pkg: any) {}

  /** Activates the extension and proves it talks only to the fake gateway before any flow runs. */
  static async create(): Promise<Harness> {
    const control = process.env[ENV.control], workspace = process.env[ENV.workspace];
    if (!control || !workspace) { throw new Error(`${ENV.control} and ${ENV.workspace} must be set; start the suite through out/e2e/run.js.`); }
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const ext = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
    if (!ext) { throw new Error(`extension ${pkg.publisher}.${pkg.name} is not loaded in this window`); }
    await ext.activate();
    const hub = await waitFor('the infraonAssistant._test command to return the Hub', async () => {
      const api = await vscode.commands.executeCommand<any>('infraonAssistant._test');
      return api?.hub;
    }, 20_000);

    const baseUrl = String(hub.cfg.get('baseUrl', ''));
    if (!baseUrl.startsWith(`${control}/`)) { throw new Error(`Refusing to run: baseUrl is ${baseUrl}, expected the fake gateway at ${control}.`); }

    await hub.ctx.secrets.store('infraonAssistant.apiKey', API_KEY);
    await hub.checkHealth();
    if (!hub.health?.ok) { throw new Error(`the fake gateway health check failed: ${hub.health?.error}`); }
    return new Harness(hub, new GatewayClient(control), workspace, ext, pkg);
  }

  /** Screenshot through the runner; a failed capture is reported but never fails a test. */
  async screenshot(name: string): Promise<string | undefined> {
    await sleep(250);
    const r = await this.gw.screenshot(name).catch((e) => ({ error: String(e) } as ScreenshotResult));
    if (r.error) { console.warn(`[e2e] screenshot ${name} failed: ${r.error}`); }
    return r.file;
  }
}
