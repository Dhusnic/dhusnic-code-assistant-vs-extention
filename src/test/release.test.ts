/**
 * Static checks of the release script (deploy.ps1): the live gateway check gates packaging when INFRAON_LIVE_API_KEY
 * is set, is skipped with a warning otherwise, and never prints the key. The script itself is never run here.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';

const read = (rel: string) => fs.readFile(path.join(__dirname, '..', '..', rel), 'utf8');

test('deploy.ps1: live gateway check runs before packaging, aborts on failure, warns when skipped', async () => {
  const ps = await read('deploy.ps1');
  const live = ps.indexOf('npm run test:live\n') >= 0 ? ps.indexOf('npm run test:live\n') : ps.indexOf('npm run test:live\r\n');
  assert.ok(live > 0, 'runs npm run test:live');
  assert.ok(live > ps.indexOf('out/test/*.test.js'), 'after the unit tests');
  assert.ok(live < ps.indexOf('vsce package'), 'before packaging');
  assert.ok(live < ps.indexOf('sign-update.js'), 'before signing');
  assert.match(ps.slice(live), /^npm run test:live\r?\n\s*if \(\$LASTEXITCODE -ne 0\) \{ throw '[^']*live gateway check failed[^']*' \}/);
  assert.match(ps, /IsNullOrWhiteSpace\(\$env:INFRAON_LIVE_API_KEY\)\)\s*\{\s*Write-Warning '[^']*SKIPPED/);
  const uses = ps.split(/\r?\n/).filter((l) => l.includes('$env:INFRAON_LIVE_API_KEY'));
  assert.equal(uses.length, 1, 'the key is only tested for presence');
  assert.ok(!/Write-(Host|Output|Warning)[^\n]*\$env:INFRAON_LIVE_API_KEY/.test(ps), 'the key is never printed');
});

test('package.json: the live tests have their own script and stay out of test:unit', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.match(pkg.scripts['test:live'], /out\/test\/live\//);
  assert.doesNotMatch(pkg.scripts['test:unit'], /live/);
});
