'use strict';
// Grading script: copied into the repository only after the agent has finished.
// Passes when no handler keeps its own email regex, every handler uses src/validation/email.js, and all tests pass.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const problems = [];
for (const f of ['signup', 'invite', 'profile']) {
  const text = fs.readFileSync(`src/handlers/${f}.js`, 'utf8');
  if (text.includes('[^\\s@]')) { problems.push(`src/handlers/${f}.js still has its own email regex`); }
  if (!/require\(['"]\.\.\/validation\/email(\.js)?['"]\)/.test(text)) { problems.push(`src/handlers/${f}.js does not use ../validation/email`); }
}
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
// A parent 'node --test' (when this grader is itself under test) sets NODE_TEST_CONTEXT, which would make the
// nested run report to it and exit 0 even when tests fail.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const r = spawnSync(process.execPath, ['--test'], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
