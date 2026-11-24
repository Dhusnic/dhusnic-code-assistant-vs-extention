import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { BAD_BASE_URL, NO_UPDATE_URL, UPDATE_SETTINGS, explainUpdateError, incompatibleProblem } from '../core/updateStatus';
import { buildSidebarHtml } from '../core/html';

const fixes = (raw: string) => explainUpdateError(raw).fixes.map((f) => `${f.action}${f.setting ? `:${f.setting}` : ''}`);

test('explainUpdateError: missing or broken configuration opens the exact setting', () => {
  const missing = explainUpdateError(`${NO_UPDATE_URL}: set infraonAssistant.baseUrl or infraonAssistant.updateUrl in your user settings`);
  assert.equal(missing.title, 'Update server is not configured');
  assert.deepEqual(fixes(missing.raw), ['openSetting:infraonAssistant.baseUrl', 'openSetting:infraonAssistant.updateUrl']);
  assert.equal(explainUpdateError(`${BAD_BASE_URL}: llm.local`).title, 'Update address is not valid');
  assert.equal(explainUpdateError('Invalid URL').title, 'Update address is not valid');
});

test('explainUpdateError: each kind of failure gets its own explanation and fixes', () => {
  const cases: Array<[string, RegExp, string[]]> = [
    ['getaddrinfo ENOTFOUND llm.internal', /not found/, ['retry', 'openSetting:infraonAssistant.baseUrl', 'openSetting:infraonAssistant.updateUrl']],
    ['self-signed certificate in certificate chain', /certificate is not trusted/, ['openSetting:infraonAssistant.allowSelfSignedTls', 'retry']],
    ['connect ECONNREFUSED 10.0.0.1:443', /Cannot reach/, ['retry', 'openSetting:infraonAssistant.updateUrl']],
    ['timed out', /did not answer in time/, ['retry']],
    ['update server answered HTTP 403', /refused access \(HTTP 403\)/, ['retry', 'openSetting:infraonAssistant.updateUrl']],
    ['update server answered HTTP 502', /server error \(HTTP 502\)/, ['retry']],
    ['update server answered HTTP 301', /Unexpected answer/, ['openSetting:infraonAssistant.updateUrl', 'retry']],
    ['update manifest signature is invalid; the update was ignored', /signature is not valid/, ['retry']],
    ['downloaded package does not match the signed hash; it was discarded', /damaged/, ['retry']],
    ['update manifest is not valid JSON', /not readable/, ['openSetting:infraonAssistant.updateUrl', 'retry']],
    ['manifest sha256 is missing or invalid', /not readable/, ['openSetting:infraonAssistant.updateUrl', 'retry']],
    ['VS Code did not finish installing the update in 5 minutes', /took too long/, ['retry']],
    ['ENOSPC: no space left on device', /Could not save/, ['retry']],
    ['something odd', /^Update check failed$/, ['retry']],
  ];
  for (const [raw, title, want] of cases) {
    const p = explainUpdateError(raw);
    assert.match(p.title, title, raw);
    assert.deepEqual(fixes(raw), want, raw);
    assert.equal(p.raw, raw, 'the original message is kept for the details line');
    assert.ok(p.detail.length > 20, raw);
  }
  assert.match(explainUpdateError('ENOSPC: no space left on device').detail, /disk is full/);
});

test('explainUpdateError: every setting a fix opens is one the host allows', () => {
  for (const raw of ['no update URL', 'getaddrinfo ENOTFOUND x', 'certificate has expired', 'HTTP 404', 'Invalid URL']) {
    for (const f of explainUpdateError(raw).fixes) {
      if (f.setting) { assert.ok((UPDATE_SETTINGS as readonly string[]).includes(f.setting), f.setting); }
    }
  }
});

test('incompatibleProblem: offers to update VS Code', () => {
  const p = incompatibleProblem('0.40.0', '1.99.0', '1.90.0');
  assert.match(p.detail, /1\.99\.0 or later; you have 1\.90\.0/);
  assert.deepEqual(p.fixes.map((f) => f.action), ['updateVscode', 'retry']);
});

test('sidebar: the Updates section exists and its script renders status and posts actions', () => {
  const html = buildSidebarHtml({ nonce: 'n', cspSource: 'c', logoSvg: '', cssUri: 'a', jsUri: 'b', mdUri: 'c', probeUri: 'd' });
  assert.match(html, /id="updSec"[\s\S]*id="updates"/);
  const js = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'sidebar.js'), 'utf8');
  assert.match(js, /m\.type === 'updates'/);
  assert.match(js, /type: 'updateAction'/);
  const host = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'host', 'extension.ts'), 'utf8');
  for (const c of ['infraonAssistant.updates.status', 'infraonAssistant.updates.act']) { assert.ok(host.includes(`'${c}'`), c); }
});
