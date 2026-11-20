'use strict';
// Grading script: copied into the repository only after the agent has finished.
// Passes when every test passes AND the old name is gone from the project.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const leftovers = [];
function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '__grade__.js') { continue; }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { scan(p); continue; }
    if (!/\.(c|m)?js$/.test(e.name)) { continue; }
    fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/\bcalcTotal\b/.test(line)) { leftovers.push(`${path.relative(process.cwd(), p)}:${i + 1}: ${line.trim()}`); }
    });
  }
}
scan(process.cwd());
if (leftovers.length) {
  console.log(`The old name calcTotal is still used:\n${leftovers.join('\n')}`);
  process.exit(1);
}
// A parent 'node --test' (when this grader is itself under test) sets NODE_TEST_CONTEXT, which would make the
// nested run report to it and exit 0 even when tests fail.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const r = spawnSync(process.execPath, ['--test'], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
