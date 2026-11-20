import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { createHash, generateKeyPairSync, sign } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { validatePolicy } from '../core/centralPolicy';
import { UPDATE_PUBLIC_KEY } from '../core/updateKey';
import {
  checkForUpdate, compareVersions, defaultUpdateUrl, downloadUpdate, httpGet, parseManifest, sameOrigin, signedMessage, UPDATE_PATH, verifySignature,
} from '../core/updater';

const keys = generateKeyPairSync('ed25519');
const PUB = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('ed25519');

function release(version: string, body: Buffer, extra: Record<string, unknown> = {}, key = keys.privateKey) {
  const sha256 = createHash('sha256').update(body).digest('hex');
  return { version, url: `infraon-code-assistant-${version}.vsix`, sha256, signature: sign(null, signedMessage(version, sha256), key).toString('base64'), ...extra };
}

/** Serves `routes` (path -> [status, body]) and records request headers. */
async function serve(routes: Record<string, [number, Buffer | string]>) {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    const r = routes[req.url ?? ''];
    if (!r) { res.writeHead(404).end(); return; }
    res.writeHead(r[0]).end(r[1]);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, seen, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'infraon-upd-'));

/* ------------------------------------------------------------------ pure helpers */

test('compareVersions orders releases and pre-releases', () => {
  assert.ok(compareVersions('0.26.0', '0.25.0') > 0);
  assert.ok(compareVersions('0.25.0', '0.25.1') < 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0, 'numeric, not string, comparison');
  assert.equal(compareVersions('0.25.0', '0.25.0'), 0);
  assert.ok(compareVersions('0.26.0-beta.1', '0.26.0') < 0);
  assert.throws(() => compareVersions('latest', '0.1.0'));
});

test('defaultUpdateUrl uses the gateway origin, not its /v1 path', () => {
  assert.equal(defaultUpdateUrl('https://172.16.48.75:30400/v1'), `https://172.16.48.75:30400${UPDATE_PATH}`);
  assert.equal(defaultUpdateUrl('not a url'), undefined);
  assert.equal(defaultUpdateUrl('file:///x'), undefined);
});

test('sameOrigin only matches scheme, host and port', () => {
  assert.ok(sameOrigin('https://a:1/x', 'https://a:1/v1'));
  assert.ok(!sameOrigin('https://a:1/x', 'https://a:2/v1'));
  assert.ok(!sameOrigin('http://a:1/x', 'https://a:1/v1'));
});

test('parseManifest resolves the package URL and rejects other servers', () => {
  const base = 'https://gw:30400/infraon-assistant/updates/latest.json';
  const ok = parseManifest(release('1.2.3', Buffer.from('x')), base);
  assert.equal(ok.manifest?.url, 'https://gw:30400/infraon-assistant/updates/infraon-code-assistant-1.2.3.vsix');
  assert.equal(ok.manifest?.mandatory, false);
  assert.match(parseManifest({ ...release('1.2.3', Buffer.from('x')), url: 'https://evil.example/x.vsix' }, base).error!, /same server/);
  assert.match(parseManifest({ ...release('1.2.3', Buffer.from('x')), url: '//evil.example/x.vsix' }, base).error!, /same server/);
  assert.match(parseManifest({ ...release('1.2.3', Buffer.from('x')), sha256: 'abc' }, base).error!, /sha256/);
  assert.match(parseManifest({ ...release('1.2.3', Buffer.from('x')), signature: '' }, base).error!, /not signed/);
  assert.match(parseManifest({ ...release('1.2.3', Buffer.from('x')), version: 'v2' }, base).error!, /version/);
  assert.match(parseManifest([], base).error!, /object/);
});

test('signature binds version and hash', () => {
  const r = release('1.0.0', Buffer.from('pkg'));
  assert.ok(verifySignature(r, PUB));
  assert.ok(!verifySignature({ ...r, version: '9.0.0' }, PUB), 'a version relabel is rejected');
  assert.ok(!verifySignature({ ...r, sha256: '0'.repeat(64) }, PUB), 'a different package is rejected');
  assert.ok(!verifySignature(release('1.0.0', Buffer.from('pkg'), {}, other.privateKey), PUB), 'another key is rejected');
  assert.ok(!verifySignature({ ...r, signature: '!!' }, PUB));
});

/* ------------------------------------------------------------------ check + download over HTTP */

test('checkForUpdate: available, current, incompatible', async () => {
  const body = Buffer.from('vsix-bytes');
  for (const [served, current, vscodeVersion, extra, want] of [
    ['0.26.0', '0.25.0', '1.95.0', {}, 'available'],
    ['0.25.0', '0.25.0', '1.95.0', {}, 'current'],
    ['0.24.0', '0.25.0', '1.95.0', {}, 'current'],
    ['0.26.0', '0.25.0', '1.89.0', { minVscode: '1.90.0' }, 'incompatible'],
    ['0.26.0', '0.25.0', '1.96.0-insider', { minVscode: '1.90.0' }, 'available'],
  ] as const) {
    const srv = await serve({ [UPDATE_PATH]: [200, JSON.stringify(release(served, body, extra))] });
    try {
      const r = await checkForUpdate({ manifestUrl: srv.origin + UPDATE_PATH, currentVersion: current, vscodeVersion, publicKeyPem: PUB, allowSelfSigned: false });
      assert.equal(r.kind, want, `${served} vs ${current}`);
    } finally { await srv.close(); }
  }
});

test('checkForUpdate rejects a manifest signed with another key, a 404 and bad JSON', async () => {
  const srv = await serve({
    '/bad-sig.json': [200, JSON.stringify(release('9.0.0', Buffer.from('x'), {}, other.privateKey))],
    '/bad.json': [200, '{nope'],
  });
  const opts = { currentVersion: '0.1.0', vscodeVersion: '1.95.0', publicKeyPem: PUB, allowSelfSigned: false };
  try {
    await assert.rejects(checkForUpdate({ ...opts, manifestUrl: `${srv.origin}/bad-sig.json` }), /signature is invalid/);
    await assert.rejects(checkForUpdate({ ...opts, manifestUrl: `${srv.origin}/missing.json` }), /no update manifest/);
    await assert.rejects(checkForUpdate({ ...opts, manifestUrl: `${srv.origin}/bad.json` }), /not valid JSON/);
  } finally { await srv.close(); }
});

test('checkForUpdate sends the API key only when given one', async () => {
  const srv = await serve({ [UPDATE_PATH]: [200, JSON.stringify(release('0.1.0', Buffer.from('x')))] });
  try {
    const base = { manifestUrl: srv.origin + UPDATE_PATH, currentVersion: '0.1.0', vscodeVersion: '1.95.0', publicKeyPem: PUB, allowSelfSigned: false };
    await checkForUpdate({ ...base, apiKey: 'k-123' });
    await checkForUpdate(base);
    assert.equal(srv.seen[0].authorization, 'Bearer k-123');
    assert.equal(srv.seen[1].authorization, undefined);
  } finally { await srv.close(); }
});

test('downloadUpdate verifies the hash, writes the package and removes older ones', async () => {
  const body = Buffer.from('real package');
  const rel = release('0.26.0', body);
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'infraon-code-assistant-0.25.0.vsix'), 'old');
  const srv = await serve({ [`/u/${rel.url}`]: [200, body], '/u/tampered.vsix': [200, Buffer.from('evil package')] });
  try {
    const { manifest } = parseManifest(rel, `${srv.origin}/u/latest.json`);
    const file = await downloadUpdate(manifest!, { dir, allowSelfSigned: false });
    assert.deepEqual(fs.readFileSync(file), body);
    assert.deepEqual(fs.readdirSync(dir), ['infraon-code-assistant-0.26.0.vsix']);

    const tampered = { ...manifest!, url: `${srv.origin}/u/tampered.vsix` };
    await assert.rejects(downloadUpdate(tampered, { dir, allowSelfSigned: false }), /does not match the signed hash/);
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('httpGet enforces the size cap and does not follow redirects', async () => {
  const srv = await serve({ '/big': [200, Buffer.alloc(5000)], '/moved': [302, ''] });
  try {
    await assert.rejects(httpGet(`${srv.origin}/big`, { allowSelfSigned: false, maxBytes: 1000, timeoutMs: 5000 }), /larger than/);
    assert.equal((await httpGet(`${srv.origin}/moved`, { allowSelfSigned: false, maxBytes: 1000, timeoutMs: 5000 })).status, 302);
  } finally { await srv.close(); }
});

/* ------------------------------------------------------------------ policy + signing script */

test('policy: disableAutoUpdate and updateUrl', () => {
  assert.deepEqual(validatePolicy({ disableAutoUpdate: true, updateUrl: 'https://gw/x/latest.json' }).policy, { disableAutoUpdate: true, updateUrl: 'https://gw/x/latest.json' });
  const bad = validatePolicy({ disableAutoUpdate: 'yes', updateUrl: 'ftp://x' });
  assert.equal(bad.policy.disableAutoUpdate, true, 'an unreadable flag fails closed');
  assert.equal(bad.policy.updateUrl, undefined);
  assert.equal(bad.errors.length, 2);
});

const script = path.join(__dirname, '..', '..', 'scripts', 'sign-update.js');

test('sign-update.js refuses a key that does not match the shipped public key', () => {
  const dir = tmpDir();
  try {
    const key = path.join(dir, 'k.pem');
    fs.writeFileSync(key, other.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const vsix = path.join(dir, 'infraon-code-assistant-9.9.9.vsix');
    fs.writeFileSync(vsix, 'pkg');
    assert.throws(() => execFileSync(process.execPath, [script, '--vsix', vsix, '--out', path.join(dir, 'out'), '--key', key], { stdio: 'pipe' }), /does not match the public key/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const realKey = path.join(os.homedir(), '.infraon-signing', 'update-signing-key.pem');
test('sign-update.js output is accepted by the extension (build machine only)', { skip: !fs.existsSync(realKey) && 'no signing key on this machine' }, async () => {
  const dir = tmpDir();
  try {
    const vsix = path.join(dir, 'infraon-code-assistant-9.9.9.vsix');
    fs.writeFileSync(vsix, 'pkg-bytes');
    const out = path.join(dir, 'out');
    execFileSync(process.execPath, [script, '--vsix', vsix, '--out', out, '--notes', 'hello', '--mandatory'], { stdio: 'pipe' });
    const raw = JSON.parse(fs.readFileSync(path.join(out, 'latest.json'), 'utf8'));
    const { manifest } = parseManifest(raw, 'https://gw/infraon-assistant/updates/latest.json');
    assert.ok(manifest && verifySignature(manifest, UPDATE_PUBLIC_KEY));
    assert.equal(manifest.mandatory, true);
    assert.equal(manifest.notes, 'hello');
    assert.ok(fs.existsSync(path.join(out, 'infraon-code-assistant-9.9.9.vsix')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
