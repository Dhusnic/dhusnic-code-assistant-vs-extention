import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GatewayClient, Harness, SessionDriver, WebviewDriver, waitFor } from './harness';

/* =====================================================================================================================
 * EXTENSION POINT: adding UI tests for a new feature
 *
 * Add ONE file to src/e2e/suite/flows/, for example src/e2e/suite/flows/60-my-feature.ts:
 *
 *   import * as assert from 'node:assert/strict';
 *   import { reply } from '../harness';
 *   import { Flow } from '../types';
 *
 *   export const flows: Flow[] = [{
 *     name: 'my-feature-shows-the-thing',
 *     async run(t) {
 *       const s = await t.newSession();
 *       await t.gw.script(reply('Hello'));
 *       await s.send('Hi');
 *       await s.waitFor('.msg.assistant .md', { text: 'Hello' });
 *       await t.shot('reply');
 *     },
 *   }];
 *
 * Nothing else needs registering: every compiled file in flows/ is discovered (in file-name order) and its `flows`
 * array is run. Files starting with "_" are ignored. Tables of cases are just arrays mapped to Flow objects.
 *
 * Every flow automatically gets: a time limit, a screenshot on failure, a check that hub.webviewErrors stayed empty,
 * a check that the gateway script was used up exactly, and a clean window for the next flow.
 * ================================================================================================================== */

export interface Flow {
  /** Unique kebab-case name; also the screenshot file name. */
  name: string;
  /** Per-test time limit (default 30 s). */
  timeoutMs?: number;
  /**
   * Set while a real product bug makes this flow fail: describe the bug with file:line. The assertion stays in
   * place; the run reports KNOWN instead of FAIL, and reports XPASS (a failure) once the bug is fixed.
   */
  knownFailure?: string;
  run(t: FlowContext): Promise<void>;
}

/** What a flow gets to work with. */
export class FlowContext {
  readonly screenshots: string[] = [];
  private current?: SessionDriver;

  constructor(readonly h: Harness, readonly flow: Flow) {}

  get hub(): any { return this.h.hub; }
  get gw(): GatewayClient { return this.h.gw; }
  get workspace(): string { return this.h.workspace; }

  /** Opens a new session tab and waits until it is ready. */
  async newSession(): Promise<SessionDriver> {
    const before = new Set<string>(this.hub.openPanelIds());
    await this.hub.newSession();
    return this.adoptNewPanel(before);
  }

  /** Waits for a session tab opened by something else (for example a sidebar button). */
  async adoptNewPanel(before: Set<string>): Promise<SessionDriver> {
    const id = await waitFor('a new session tab', () => (this.hub.openPanelIds() as string[]).find((x) => !before.has(x)));
    return this.attach(id);
  }

  /** Drives a session tab that is already open. */
  async attach(id: string): Promise<SessionDriver> {
    const s = new SessionDriver(this.hub, id);
    await s.ready();
    this.current = s;
    return s;
  }

  /** Shows the Infraon sidebar and waits until it answers. */
  async sidebar(): Promise<WebviewDriver> {
    await vscode.commands.executeCommand('infraonAssistant.sessions.focus');
    const d = new WebviewDriver(this.hub, 'sidebar', 'sidebar');
    await waitFor('the sidebar to render', () => this.hub.probe('sidebar', { action: 'query', selector: '#llm' }, 700), 20_000);
    return d;
  }

  /** Creates a file for this flow; returns its workspace-relative path. */
  fixture(name: string, content: string): string {
    const rel = `e2e-files/${this.flow.name}/${name}`;
    fs.mkdirSync(path.dirname(this.abs(rel)), { recursive: true });
    fs.writeFileSync(this.abs(rel), content, 'utf8');
    return rel;
  }

  abs(rel: string): string { return path.join(this.workspace, ...rel.split('/')); }
  read(rel: string): string { return fs.readFileSync(this.abs(rel), 'utf8'); }
  exists(rel: string): boolean { return fs.existsSync(this.abs(rel)); }

  /**
   * Saves .e2e/screenshots/<flow>--<name>.png with the flow's session tab in front.
   * Pass `{ keepActiveTab: true }` to capture whatever editor is showing instead (for example a diff).
   */
  async shot(name: string, opts: { keepActiveTab?: boolean } = {}): Promise<void> {
    if (!opts.keepActiveTab) { await this.current?.reveal(); }
    const f = await this.h.screenshot(`${this.flow.name}--${name}`);
    if (f) { this.screenshots.push(f); }
  }
}
