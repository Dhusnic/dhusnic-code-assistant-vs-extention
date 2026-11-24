import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { Tool, ToolCtx, fnSpec } from './tool';
import { resolveIn } from './fstools';
import { RENDER_DIR_PREFIX } from './imageView';

/**
 * screenshot: captures the user's desktop (every display), the window in front (usually VS Code itself), a window
 * found by its title, or a rectangle of the screen, using only what the OS ships: .NET System.Drawing through
 * PowerShell on Windows (PrintWindow for a window, so one hidden behind others still renders), screencapture on macOS,
 * and grim / gnome-screenshot / ImageMagick import / scrot on Linux. Nothing leaves the machine unless the agent asks
 * a question about the image, which goes to the vision model through view_image (same gateway as every LLM call).
 *
 * The PNG lands in <tmp>/infraon-render-screens/ (a folder view_image may read) or, with save_to, in the workspace.
 * Kind 'exec': the screen can show anything, including other apps, so the call is approved like a command.
 */
export const SCREENSHOT_TOOL = 'screenshot';
export const SCREEN_DIR = `${RENDER_DIR_PREFIX}screens`;

export interface Region { x: number; y: number; width: number; height: number }
export interface CaptureRequest { target: 'screen' | 'window' | 'region'; windowTitle?: string; region?: Region; out: string }

export interface ScreenshotDeps {
  /** Looks at a saved image (view_image); used when the call asks a question. */
  view?: (absPath: string, question: string, ctx: ToolCtx) => Promise<string>;
  /** Replaces the OS capture (tests). */
  capture?: (req: CaptureRequest, signal: AbortSignal) => Promise<void>;
  tmpDir?: string;
  platform?: NodeJS.Platform;
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The PowerShell script for a Windows capture. Exported for tests: it is only checked, never run there. */
export function windowsScript(req: CaptureRequest): string {
  const lines = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public static class IcaWin {',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }',
    '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);',
    '}',
    '"@',
    '[void][IcaWin]::SetProcessDPIAware()',
    `$out = ${psQuote(req.out)}`,
  ];
  if (req.target === 'window') {
    lines.push(req.windowTitle
      ? `$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like ${psQuote(`*${req.windowTitle}*`)} } | Select-Object -First 1
if (-not $p) { throw "No open window has a title containing '${req.windowTitle.replace(/['"`$]/g, '')}'." }
$h = $p.MainWindowHandle`
      : '$h = [IcaWin]::GetForegroundWindow()');
    lines.push(
      'if ([IcaWin]::IsIconic($h)) { throw "The window is minimized; restore it first." }',
      '$r = New-Object IcaWin+RECT; [void][IcaWin]::GetWindowRect($h, [ref]$r)',
      '$w = $r.R - $r.L; $hh = $r.B - $r.T',
      'if ($w -le 0 -or $hh -le 0) { throw "The window has no visible area." }',
      '$bmp = New-Object System.Drawing.Bitmap $w, $hh',
      '$g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()',
      '$ok = [IcaWin]::PrintWindow($h, $dc, 2); $g.ReleaseHdc($dc)',
      'if (-not $ok) { $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size) }',
    );
  } else {
    const r = req.region;
    lines.push(r
      ? `$x = ${r.x}; $y = ${r.y}; $w = ${r.width}; $hh = ${r.height}`
      : '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen; $x = $b.X; $y = $b.Y; $w = $b.Width; $hh = $b.Height');
    lines.push(
      '$bmp = New-Object System.Drawing.Bitmap $w, $hh',
      '$g = [System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)',
    );
  }
  lines.push('$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()', 'Write-Output "$w x $hh"');
  return lines.join('\n');
}

const run = (cmd: string, args: string[], signal: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 30000, windowsHide: true, signal, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    if (err) { reject(new Error((String(stderr).trim().split('\n').filter((l) => !/^\s*(At line|\+|CategoryInfo|FullyQualifiedErrorId)/.test(l))[0] || err.message).trim())); } else { resolve(String(stdout)); }
  });
});

async function osCapture(req: CaptureRequest, signal: AbortSignal, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') {
    const encoded = Buffer.from(windowsScript(req), 'utf16le').toString('base64');
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], signal);
    return;
  }
  if (req.target === 'window') { throw new Error(`Capturing one window is supported on Windows only; use target "screen" or "region" on ${platform}.`); }
  const r = req.region;
  if (platform === 'darwin') {
    await run('screencapture', ['-x', ...(r ? ['-R', `${r.x},${r.y},${r.width},${r.height}`] : []), req.out], signal);
    return;
  }
  const attempts: Array<[string, string[]]> = [
    ['grim', [...(r ? ['-g', `${r.x},${r.y} ${r.width}x${r.height}`] : []), req.out]],
    ['import', ['-window', 'root', ...(r ? ['-crop', `${r.width}x${r.height}+${r.x}+${r.y}`] : []), req.out]],
    ...(r ? [] : [['gnome-screenshot', ['-f', req.out]], ['scrot', ['-o', req.out]]] as Array<[string, string[]]>),
  ];
  const errors: string[] = [];
  for (const [cmd, args] of attempts) {
    try { await run(cmd, args, signal); return; } catch (e: any) { errors.push(`${cmd}: ${e.message}`); }
  }
  throw new Error(`No screenshot program worked. Install grim (Wayland) or ImageMagick (X11). ${errors.join('; ')}`);
}

function parseRegion(v: any): Region | undefined {
  if (!v || typeof v !== 'object') { return undefined; }
  const r = { x: Math.round(Number(v.x)), y: Math.round(Number(v.y)), width: Math.round(Number(v.width)), height: Math.round(Number(v.height)) };
  if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) { throw new Error('region needs numeric x, y and a positive width and height (screen pixels).'); }
  return r;
}

export function createScreenshotTool(deps: ScreenshotDeps = {}): Tool {
  const platform = deps.platform ?? process.platform;
  return {
    kind: 'exec',
    spec: fnSpec(SCREENSHOT_TOOL,
      'Take a screenshot of the user\'s screen and save it as a PNG: the whole desktop (target "screen", default), the window in front, usually this editor (target "window"), '
      + 'a window whose title contains window_title (Windows), or a rectangle (target "region"). Give `question` to have the image described (e.g. "Is the dialog showing an error?"). '
      + 'For web pages in the test browser use browser_screenshot instead.',
      {
        target: { type: 'string', enum: ['screen', 'window', 'region'] },
        window_title: { type: 'string', description: 'part of a window title, e.g. "Notepad" (target "window", Windows only)' },
        region: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, description: 'screen pixels, for target "region"' },
        delay_seconds: { type: 'number', description: 'wait before capturing, 0-10' },
        save_to: { type: 'string', description: 'workspace path for the PNG (default: a temp folder)' },
        question: { type: 'string', description: 'what to look for in the screenshot' },
      }, []),
    describe: (a) => `Screenshot ${a.target === 'region' ? 'of a screen region' : a.target === 'window' ? (a.window_title ? `of window "${a.window_title}"` : 'of the front window') : 'of the screen'}${a.save_to ? ` → ${a.save_to}` : ''}`,
    async run(a, ctx) {
      const target = a.target === 'window' || a.target === 'region' ? a.target : (a.window_title ? 'window' : 'screen');
      const region = target === 'region' ? parseRegion(a.region) : undefined;
      if (target === 'region' && !region) { throw new Error('target "region" needs region {x, y, width, height}.'); }
      let out: string;
      if (a.save_to) {
        out = resolveIn(ctx, String(a.save_to));
        if (path.extname(out).toLowerCase() !== '.png') { out += '.png'; }
        await ctx.snapshot(out);
      } else {
        const dir = path.join(deps.tmpDir ?? os.tmpdir(), SCREEN_DIR);
        out = path.join(dir, `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      }
      await fs.mkdir(path.dirname(out), { recursive: true });
      const delay = Math.min(10, Math.max(0, Number(a.delay_seconds) || 0));
      if (delay) { await new Promise((r) => setTimeout(r, delay * 1000)); }
      const req: CaptureRequest = { target, windowTitle: a.window_title ? String(a.window_title) : undefined, region, out };
      await (deps.capture ? deps.capture(req, ctx.signal) : osCapture(req, ctx.signal, platform));
      const st = await fs.stat(out).catch(() => undefined);
      if (!st?.size) { throw new Error('The screenshot program reported success but wrote no image.'); }
      const head = `Saved screenshot to ${out} (${(st.size / 1024).toFixed(0)} KB).`;
      const question = String(a.question ?? '').trim();
      if (!question || !deps.view) { return `${head}${deps.view ? ' Call view_image on it to look at it.' : ''}`; }
      return `${head}\n${await deps.view(out, question, ctx)}`;
    },
  };
}
