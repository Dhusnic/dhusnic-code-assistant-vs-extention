'use strict';
// Grading script: copied into the repository only after the agent has finished. Runs every Python test, hidden ones
// included, with the first of python3 / python that really runs (on Windows "python3" can be a Store placeholder).
const { spawnSync } = require('node:child_process');

const exe = ['python3', 'python'].find((e) => {
  const v = spawnSync(e, ['--version'], { encoding: 'utf8' });
  return !v.error && v.status === 0 && /Python 3/.test(`${v.stdout}${v.stderr}`);
});
if (!exe) { console.error('python 3 is not installed'); process.exit(1); }
const r = spawnSync(exe, ['-m', 'unittest', 'discover', '-s', 'tests', '-t', '.', '-v'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
