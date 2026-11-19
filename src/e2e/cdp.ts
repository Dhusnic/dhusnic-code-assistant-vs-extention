import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';

interface Target { type: string; url: string; webSocketDebuggerUrl?: string }

function getJson(port: number, route: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout: 3000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (data += d));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Minimal Chrome DevTools Protocol client (Node's built-in WebSocket) for the VS Code workbench window. */
export class CdpClient {
  private ws?: any;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(private port: number) {}

  private async workbenchTarget(): Promise<Target> {
    const targets: Target[] = await getJson(this.port, '/json/list');
    const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    const t = pages.find((p) => /workbench/.test(p.url)) ?? pages[0];
    if (!t) { throw new Error(`no workbench page among ${targets.length} DevTools targets`); }
    return t;
  }

  private async connect(): Promise<void> {
    if (this.ws?.readyState === 1) { return; }
    const WS = (globalThis as any).WebSocket;
    if (!WS) { throw new Error('This Node.js has no built-in WebSocket; run the suite with Node 22 or newer.'); }
    const target = await this.workbenchTarget();
    await new Promise<void>((resolve, reject) => {
      const ws = new WS(target.webSocketDebuggerUrl);
      ws.addEventListener('open', () => { this.ws = ws; resolve(); });
      ws.addEventListener('error', () => reject(new Error('could not connect to the DevTools socket')));
      ws.addEventListener('close', () => {
        this.ws = undefined;
        for (const p of this.pending.values()) { p.reject(new Error('DevTools socket closed')); }
        this.pending.clear();
      });
      ws.addEventListener('message', (ev: { data: unknown }) => {
        const m = JSON.parse(String(ev.data));
        const p = m.id ? this.pending.get(m.id) : undefined;
        if (!p) { return; }
        this.pending.delete(m.id);
        if (m.error) { p.reject(new Error(m.error.message)); } else { p.resolve(m.result); }
      });
    });
  }

  private async send(method: string, params: object, timeoutMs: number): Promise<any> {
    await this.connect();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Saves a PNG of the whole VS Code window, webviews included. */
  async screenshot(file: string): Promise<void> {
    const r = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 10_000);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from(r.data, 'base64'));
  }

  close(): void {
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = undefined;
  }
}
