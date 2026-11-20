import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { createHash, generateKeyPairSync, KeyObject, sign } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { validatePolicy } from '../core/centralPolicy';
import { UPDATE_PUBLIC_KEYS } from '../core/updateKey';
import {
  checkForUpdate, compareVersions, defaultUpdateUrl, downloadUpdate, httpGet, LOCK_STALE_MS, parseManifest, readInstallRecord, RECORD_TTL_MS,
  SignedFields, signedMessage, UPDATE_PATH, verifySignature, withInstallLock, withTimeout, writeInstallRecord,
} from '../core/updater';

const keys = generateKeyPairSync('ed25519');
const PUB = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('ed25519');
const OTHER_PUB = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** A manifest as sign-update.js writes it. */
function release(version: string, body: Buffer, extra: Partial<Omit<SignedFields, 'version' | 'sha256'>> = {}, key: KeyObject = keys.privateKey) {
  const sha256 = createHash('sha256').update(body).digest('hex');
  const f: SignedFields = { version, source: extra.source ?? `infraon-code-assistant-${version}.vsix`, sha256, mandatory: extra.mandatory ?? false, minVscode: extra.minVscode, notes: extra.notes };
  return {
    version, url: f.source, sha256, mandatory: f.mandatory,
    ...(f.minVscode ? { minVscode: f.minVscode } : {}), ...(f.notes ? { notes: f.notes } : {}),
    signature: sign(null, signedMessage(f), key).toString('base64'),
  };
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
const base = (manifestUrl: string) => ({ manifestUrl, currentVersion: '0.1.0', vscodeVersion: '1.95.0', publicKeysPem: [PUB], allowSelfSigned: false });

/* ------------------------------------------------------------------ pure helpers */

test('compareVersions orders releases and pre-releases by SemVer', () => {
  assert.ok(compareVersions('0.26.0', '0.25.0') > 0);
  assert.ok(compareVersions('0.25.0', '0.25.1') < 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0, 'numeric, not string, comparison');
  assert.equal(compareVersions('0.25.0', '0.25.0'), 0);
  assert.ok(compareVersions('0.26.0-beta.1', '0.26.0') < 0);
  // SemVer 2 section 11: numeric identifiers compare numerically and sort below alphanumeric ones.
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 1; i < ordered.length; i++) { assert.ok(compareVersions(ordered[i - 1], ordered[i]) < 0, `${ordered[i - 1]} < ${ordered[i]}`); }
  assert.throws(() => compareVersions('latest', '0.1.0'));
});

test('defaultUpdateUrl uses the gateway origin, not its /v1 path', () => {
  assert.equal(defaultUpdateUrl('https://172.16.48.75:30400/v1'), `https://172.16.48.75:30400${UPDATE_PATH}`);
  assert.equal(defaultUpdateUrl('not a url'), undefined);
  assert.equal(defaultUpdateUrl('file:///x'), undefined);
});

test('parseManifest resolves the package URL and rejects other servers', () => {
  const at = 'https://gw:30400/infraon-assistant/updates/latest.json';
  const ok = parseManifest(release('1.2.3', Buffer.from('x')), at);
  assert.equal(ok.manifest?.url, 'https://gw:30400/infraon-assistant/updates/infraon-code-assistant-1.2.3.vsix');
  assert.equal(ok.manifest?.source, 'infraon-code-assistant-1.2.3.vsix');
  assert.equal(ok.manifest?.mandatory, false);
  assert.match(parseManifest({ ...release('1.2.3', Buffer.from('x')), url: 'https://evil.example/x.vsix' }, at).error!, /same server/);
  assert.match(parseManifest({ ...release('1.2.3', Buffer.from('x')), url: '//evil.example/x.vsix' }, at).error!, /same server/);
  assert.match(parseManifest({ ...release('1.2.3', Buffer.from('x')), sha256: 'abc' }, at).error!, /sha256/);
  assert.match(parseManifest({ ...release('1.2.3', Buffer.from('x')), signature: '' }, at).error!, /not signed/);
  assert.match(parseManifest({ ...release('1.2.3', Buffer.from('x')), version: 'v2' }, at).error!, /version/);
  assert.match(parseManifest({ ...release('1.2.3', Buffer.from('x')), notes: 'n'.repeat(2001) }, at).error!, /notes/);
  assert.match(parseManifest([], at).error!, /object/);
});

test('the signature covers every field the client acts on', () => {
  const at = 'https://gw/infraon-assistant/updates/latest.json';
  const good = release('1.0.0', Buffer.from('pkg'), { notes: 'hello', minVscode: '1.90.0' });
  const ok = (raw: object) => verifySignature(parseManifest(raw, at).manifest!, [PUB]);
  assert.ok(ok(good));
  assert.ok(!ok({ ...good, version: '9.0.0' }), 'version');
  assert.ok(!ok({ ...good, sha256: '0'.repeat(64) }), 'package hash');
  assert.ok(!ok({ ...good, url: 'other.vsix' }), 'package location');
  assert.ok(!ok({ ...good, mandatory: true }), 'mandatory flag');
  assert.ok(!ok({ ...good, minVscode: '9.0.0' }), 'minimum VS Code');
  assert.ok(!ok({ ...good, notes: 'Install this, then email your API key to…' }), 'notes');
  const { minVscode: _drop, ...noMin } = good;
  assert.ok(!ok(noMin), 'removing a signed field');
  assert.ok(!ok({ ...good, signature: '!!' }));
});

test('any trusted key is accepted (staged key rotation); other keys are not', () => {
  const at = 'https://gw/infraon-assistant/updates/latest.json';
  const byNew = parseManifest(release('2.0.0', Buffer.from('p'), {}, other.privateKey), at).manifest!;
  assert.ok(!verifySignature(byNew, [PUB]), 'a client that only knows the old key rejects the new one');
  assert.ok(verifySignature(byNew, [PUB, OTHER_PUB]), 'a client that knows both accepts it');
  assert.ok(verifySignature(parseManifest(release('2.0.0', Buffer.from('p')), at).manifest!, [PUB, OTHER_PUB]), 'and still accepts the old key');
  assert.ok(!verifySignature(byNew, ['not a key']));
});

/* ------------------------------------------------------------------ check + download over HTTP */

test('checkForUpdate: available, current, incompatible, unpublished', async () => {
  const body = Buffer.from('vsix-bytes');
  for (const [served, current, vscodeVersion, extra, want] of [
    ['0.26.0', '0.25.0', '1.95.0', {}, 'available'],
    ['0.25.0', '0.25.0', '1.95.0', {}, 'current'],
    ['0.24.0', '0.25.0', '1.95.0', {}, 'current'],
    ['0.26.0', '0.25.0', '1.89.0', { minVscode: '1.90.0' }, 'incompatible'],
    ['0.26.0', '0.25.0', '1.96.0-insider', { minVscode: '1.90.0' }, 'available'],
    ['1.0.0-beta.10', '1.0.0-beta.2', '1.95.0', {}, 'available'],
  ] as const) {
    const srv = await serve({ [UPDATE_PATH]: [200, JSON.stringify(release(served, body, extra))] });
    try {
      const r = await checkForUpdate({ ...base(srv.origin + UPDATE_PATH), currentVersion: current, vscodeVersion });
      assert.equal(r.kind, want, `${served} vs ${current}`);
    } finally { await srv.close(); }
  }
  const empty = await serve({});
  try { assert.deepEqual(await checkForUpdate(base(empty.origin + UPDATE_PATH)), { kind: 'unpublished' }, 'a 404 is not an error'); } finally { await empty.close(); }
});

test('checkForUpdate rejects a manifest signed with another key, a server error and bad JSON', async () => {
  const srv = await serve({
    '/bad-sig.json': [200, JSON.stringify(release('9.0.0', Buffer.from('x'), {}, other.privateKey))],
    '/bad.json': [200, '{nope'],
    '/down.json': [503, 'busy'],
  });
  try {
    await assert.rejects(checkForUpdate(base(`${srv.origin}/bad-sig.json`)), /signature is invalid/);
    await assert.rejects(checkForUpdate(base(`${srv.origin}/down.json`)), /HTTP 503/);
    await assert.rejects(checkForUpdate(base(`${srv.origin}/bad.json`)), /not valid JSON/);
  } finally { await srv.close(); }
});

test('no credentials are ever sent to the update server', async () => {
  const body = Buffer.from('pkg');
  const rel = release('0.2.0', body);
  const srv = await serve({ [UPDATE_PATH]: [200, JSON.stringify(rel)], [`/infraon-assistant/updates/${rel.url}`]: [200, body] });
  const dir = tmpDir();
  try {
    const r = await checkForUpdate(base(srv.origin + UPDATE_PATH));
    assert.equal(r.kind, 'available');
    await downloadUpdate((r as { manifest: any }).manifest, { dir, allowSelfSigned: false });
    assert.equal(srv.seen.length, 2);
    for (const h of srv.seen) { assert.equal(h.authorization, undefined); assert.equal(h.cookie, undefined); }
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
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

/* ------------------------------------------------------------------ coordination between windows */

test('install lock: one window at a time; a crashed window\'s lock expires', async () => {
  const dir = tmpDir();
  try {
    let inner: unknown = 'not run';
    const outer = await withInstallLock(dir, async () => {
      inner = await withInstallLock(dir, async () => 'second window ran');
      return 'first';
    });
    assert.equal(outer, 'first');
    assert.equal(inner, undefined, 'the second window is turned away while the first holds the lock');
    assert.equal(await withInstallLock(dir, async () => 'again'), 'again', 'released afterwards');
    await assert.rejects(withInstallLock(dir, async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await withInstallLock(dir, async () => 'after error'), 'after error', 'released after a failure too');

    fs.writeFileSync(path.join(dir, 'install.lock'), 'crashed');
    assert.equal(await withInstallLock(dir, async () => 'x'), undefined, 'a fresh lock is respected');
    const later = () => Date.now() + LOCK_STALE_MS + 1000;
    assert.equal(await withInstallLock(dir, async () => 'took over', later), 'took over', 'a stale lock is taken over');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('install record tells other windows what was installed, for a limited time', async () => {
  const dir = tmpDir();
  try {
    assert.equal(await readInstallRecord(dir), undefined);
    await writeInstallRecord(dir, '0.27.0');
    assert.equal((await readInstallRecord(dir))?.version, '0.27.0');
    assert.equal(await readInstallRecord(dir, () => Date.now() + RECORD_TTL_MS + 1000), undefined, 'expires');
    fs.writeFileSync(path.join(dir, 'installed.json'), '{"version":"junk","at":1}');
    assert.equal(await readInstallRecord(dir), undefined, 'garbage is ignored');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('withTimeout rejects a promise that never settles', async () => {
  await assert.rejects(withTimeout(new Promise(() => undefined), 20, 'stalled'), /stalled/);
  assert.equal(await withTimeout(Promise.resolve(7), 1000, 'x'), 7);
});

/* ------------------------------------------------------------------ policy + signing script */

test('policy: disableAutoUpdate and updateUrl', () => {
  assert.deepEqual(validatePolicy({ disableAutoUpdate: true, updateUrl: 'https://gw/x/latest.json' }).policy, { disableAutoUpdate: true, updateUrl: 'https://gw/x/latest.json' });
  const bad = validatePolicy({ disableAutoUpdate: 'yes', updateUrl: 'ftp://x' });
  assert.equal(bad.policy.disableAutoUpdate, true, 'an unreadable flag fails closed');
  assert.equal(bad.policy.updateUrl, undefined);
  assert.equal(bad.errors.length, 2);
});

test('the host updater never sends the API key and reads its server from user settings only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'host', 'updater.ts'), 'utf8');
  assert.doesNotMatch(src, /secrets\.get|apiKey/, 'no API key in the updater');
  assert.doesNotMatch(src, /getConfiguration\([^)]*\)\.get\(/, 'settings are read with inspect(), not get()');
  assert.match(src, /globalValue \?\? i\?\.defaultValue/);
});

const script = path.join(__dirname, '..', '..', 'scripts', 'sign-update.js');

test('sign-update.js refuses a key that matches none of the shipped public keys', () => {
  const dir = tmpDir();
  try {
    const key = path.join(dir, 'k.pem');
    fs.writeFileSync(key, other.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const vsix = path.join(dir, 'infraon-code-assistant-9.9.9.vsix');
    fs.writeFileSync(vsix, 'pkg');
    assert.throws(() => execFileSync(process.execPath, [script, '--vsix', vsix, '--out', path.join(dir, 'out'), '--key', key], { stdio: 'pipe' }), /does not match any public key/);
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
    assert.ok(manifest && verifySignature(manifest, UPDATE_PUBLIC_KEYS), 'script and client build the same signed bytes');
    assert.equal(manifest.mandatory, true);
    assert.equal(manifest.notes, 'hello');
    assert.ok(!verifySignature({ ...manifest, mandatory: false }, UPDATE_PUBLIC_KEYS), 'the mandatory flag is signed');
    assert.ok(fs.existsSync(path.join(out, 'infraon-code-assistant-9.9.9.vsix')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
