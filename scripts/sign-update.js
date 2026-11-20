#!/usr/bin/env node
/*
 * Prepares an update release for the company server:
 *   node scripts/sign-update.js --vsix <file.vsix> --out <dir> [--key <private.pem>] [--notes "..."] [--mandatory] [--min-vscode 1.90.0]
 * Writes <dir>/<file.vsix> and <dir>/latest.json (signed). Copy both into the server's /infraon-assistant/updates/ folder,
 * the .vsix first, so clients never see a manifest whose package is not there yet.
 * The private key defaults to %USERPROFILE%\.infraon-signing\update-signing-key.pem and must never be committed.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function args(argv) {
  const out = { mandatory: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) { throw new Error(`${a} needs a value`); } return v; };
    if (a === '--vsix') { out.vsix = next(); }
    else if (a === '--out') { out.out = next(); }
    else if (a === '--key') { out.key = next(); }
    else if (a === '--notes') { out.notes = next(); }
    else if (a === '--min-vscode') { out.minVscode = next(); }
    else if (a === '--mandatory') { out.mandatory = true; }
    else { throw new Error(`unknown argument ${a}`); }
  }
  if (!out.vsix || !out.out) { throw new Error('usage: sign-update.js --vsix <file> --out <dir> [--key <pem>] [--notes text] [--mandatory] [--min-vscode x.y.z]'); }
  return out;
}

function main() {
  const o = args(process.argv.slice(2));
  const root = path.resolve(__dirname, '..');
  const vsix = path.resolve(o.vsix);
  const m = /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.vsix$/.exec(path.basename(vsix));
  if (!m) { throw new Error(`cannot read the version from ${path.basename(vsix)}`); }
  const version = m[1];
  const minVscode = o.minVscode ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).engines.vscode.replace(/^[^\d]*/, '');

  const keyFile = path.resolve(o.key ?? path.join(os.homedir(), '.infraon-signing', 'update-signing-key.pem'));
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile));
  // Refuse to sign with a key the shipped extension would not accept.
  const shipped = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/.exec(fs.readFileSync(path.join(root, 'src', 'core', 'updateKey.ts'), 'utf8'));
  const derived = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString().trim();
  if (!shipped || shipped[0].replace(/\r/g, '') !== derived.replace(/\r/g, '')) { throw new Error(`${keyFile} does not match the public key in src/core/updateKey.ts`); }

  const body = fs.readFileSync(vsix);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const message = Buffer.from(`infraon-code-assistant\n${version}\n${sha256}\n`, 'utf8');   // must match signedMessage() in src/core/updater.ts
  const signature = crypto.sign(null, message, privateKey).toString('base64');

  fs.mkdirSync(o.out, { recursive: true });
  fs.copyFileSync(vsix, path.join(o.out, path.basename(vsix)));
  const manifest = {
    version, url: path.basename(vsix), sha256, signature, minVscode, mandatory: o.mandatory,
    ...(o.notes ? { notes: o.notes } : {}), publishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(o.out, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Signed ${version} (sha256 ${sha256.slice(0, 12)}…) -> ${path.resolve(o.out)}`);
}

try { main(); } catch (e) { console.error(`sign-update: ${e.message}`); process.exit(1); }
