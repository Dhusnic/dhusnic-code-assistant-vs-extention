'use strict';
// Grading script: copied into the repository only after the agent has finished.
// Passes when the module lives only at its new path, nothing requires the old path, and every test passes.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const problems = [];
if (fs.existsSync('src/utils/strings.js')) { problems.push('src/utils/strings.js still exists'); }
if (!fs.existsSync('src/text/strings.js')) { problems.push('src/text/strings.js does not exist'); }
(function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '__grade__.js') { continue; }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { scan(p); continue; }
    if (/\.js$/.test(e.name) && /utils\/strings/.test(fs.readFileSync(p, 'utf8'))) { problems.push(`${p} still refers to utils/strings`); }
  }
})('.');
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
// A parent 'node --test' (when this grader is itself under test) sets NODE_TEST_CONTEXT, which would make the
// nested run report to it and exit 0 even when tests fail.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const r = spawnSync(process.execPath, ['--test'], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
