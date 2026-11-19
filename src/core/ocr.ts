import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';

/**
 * Offline OCR. Windows: the built-in Windows.Media.Ocr engine via scripts/ocr.ps1 (no install needed).
 * Elsewhere: the `tesseract` CLI if it is on PATH. Nothing is ever sent over the network.
 */
export async function ocrImage(extensionRoot: string, buf: Buffer, ext: string, timeoutMs = 45000, platform: string = process.platform): Promise<string> {
  const tmp = path.join(os.tmpdir(), `ica-ocr-${randomBytes(6).toString('hex')}.${ext}`);
  await fs.writeFile(tmp, buf);
  try {
    const [cmd, args] = platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(extensionRoot, 'scripts', 'ocr.ps1'), '-ImagePath', tmp]]
      : ['tesseract', [tmp, 'stdout']];
    return (await run(cmd, args as string[], timeoutMs)).replace(/\r\n/g, '\n').trim();
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error(`OCR timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? (cmd === 'tesseract' ? 'OCR needs the "tesseract" command on this OS (not installed)' : `${cmd} not found`) : e.message));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) { resolve(out); } else { reject(new Error((err.trim().split('\n').find((l) => l.trim() && !l.startsWith('At ') && !l.startsWith('+')) ?? `exit ${code}`).trim())); }
    });
  });
}
