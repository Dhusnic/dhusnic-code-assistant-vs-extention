'use strict';
// Grading script: copied into the repository only after the agent has finished. Runs every test, hidden ones included.
const { spawnSync } = require('node:child_process');

// A parent 'node --test' (when this grader is itself under test) sets NODE_TEST_CONTEXT, which would make the
// nested run report to it and exit 0 even when tests fail.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const r = spawnSync(process.execPath, ['--test'], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
