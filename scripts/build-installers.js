#!/usr/bin/env node
/*
 * Builds InfraonCodeAssistant-Installer.zip (Windows) and InfraonCodeAssistant-Mac-Installer.zip from the committed tree:
 *   node scripts/build-installers.js            (uses infraon-code-assistant-<package.json version>.vsix in the repo root)
 * Installer files are read from HEAD, never the working tree, so a zip cannot ship uncommitted edits; the script refuses
 * to run while they have changes. Only the current .vsix is packed (no older ones), scripts keep their executable bit
 * on macOS, and timestamps are fixed so the same commit and package always give the same zip.
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yazl = require('yazl');                 // ships with @vscode/vsce

const root = path.resolve(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const MTIME = new Date('2026-01-01T00:00:00Z');
const TARGETS = [
  { dir: 'installer', zip: 'InfraonCodeAssistant-Installer.zip', exec: [] },
  { dir: 'installer-mac', zip: 'InfraonCodeAssistant-Mac-Installer.zip', exec: ['install.sh', 'Install-InfraonAssistant.command'] },
];
const NOT_SHIPPED = new Set(['TEAMS_MESSAGE.txt']);

function build(t, version, vsix) {
  const dirty = git('status', '--porcelain', '--', t.dir).toString().split('\n').filter((l) => l && !l.endsWith('.vsix'));
  if (dirty.length) { throw new Error(`${t.dir} has uncommitted changes; commit them first:\n${dirty.join('\n')}`); }
  const files = git('ls-files', '--', t.dir).toString().split('\n').filter(Boolean)
    .map((f) => f.slice(t.dir.length + 1)).filter((f) => !NOT_SHIPPED.has(f) && !f.endsWith('.vsix'));
  for (const f of [...t.exec, 'README.txt']) { if (!files.includes(f)) { throw new Error(`${t.dir}/${f} is not committed`); } }
  const readme = git('show', `HEAD:${t.dir}/README.txt`).toString();
  if (!readme.includes(version)) { throw new Error(`${t.dir}/README.txt does not mention ${version}`); }

  // Keep the local folder in step (the installer picks the newest .vsix next to it).
  for (const old of fs.readdirSync(path.join(root, t.dir))) { if (old.endsWith('.vsix')) { fs.rmSync(path.join(root, t.dir, old)); } }
  fs.copyFileSync(vsix, path.join(root, t.dir, path.basename(vsix)));

  const zip = new yazl.ZipFile();
  for (const f of files.sort()) {
    zip.addBuffer(git('show', `HEAD:${t.dir}/${f}`), f, { mtime: MTIME, mode: (t.exec.includes(f) ? 0o755 : 0o644) | 0o100000 });
  }
  zip.addBuffer(fs.readFileSync(vsix), path.basename(vsix), { mtime: MTIME, mode: 0o100644, compress: false });
  zip.end();
  const out = path.join(root, t.zip);
  return new Promise((resolve, reject) => {
    const tmp = `${out}.tmp`;
    zip.outputStream.pipe(fs.createWriteStream(tmp)).on('close', () => { fs.renameSync(tmp, out); resolve({ zip: t.zip, files: [...files, path.basename(vsix)] }); }).on('error', reject);
  });
}

async function main() {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const vsix = path.join(root, `infraon-code-assistant-${version}.vsix`);
  if (!fs.existsSync(vsix)) { throw new Error(`${path.basename(vsix)} not found; run deploy.ps1 -Version ${version} first`); }
  for (const t of TARGETS) {
    const r = await build(t, version, vsix);
    console.log(`${r.zip} (${(fs.statSync(path.join(root, r.zip)).size / 1024).toFixed(0)} KB): ${r.files.join(', ')}`);
  }
}

main().catch((e) => { console.error(`build-installers: ${e.message}`); process.exit(1); });
