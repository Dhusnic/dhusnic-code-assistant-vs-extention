'use strict';
// Grading script: copied into the repository only after the agent has finished.
// Passes when every test passes AND src/config.js still uses CRLF line endings throughout.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const text = fs.readFileSync('src/config.js', 'utf8');
const crlf = (text.match(/\r\n/g) || []).length;
const lf = (text.match(/\n/g) || []).length;
if (!crlf || crlf !== lf) {
  console.log(`src/config.js no longer uses CRLF line endings throughout (${crlf} CRLF of ${lf} line breaks).`);
  process.exit(1);
}
// A parent 'node --test' (when this grader is itself under test) sets NODE_TEST_CONTEXT, which would make the
// nested run report to it and exit 0 even when tests fail.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const r = spawnSync(process.execPath, ['--test'], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
