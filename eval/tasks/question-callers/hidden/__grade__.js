'use strict';
// Grading script: copied into the repository only after the agent has finished. Checks the answer file.
const fs = require('node:fs');

const expected = ['src/billing/subscriptions.js', 'src/jobs/retryFailed.js', 'src/payments/index.js'];
let answer = '';
try { answer = fs.readFileSync('ANSWER.txt', 'utf8'); } catch { console.log('ANSWER.txt is missing'); process.exit(1); }
const got = [...new Set(answer.split(/\r?\n/)
  .map((l) => l.trim().replace(/^[-*]\s+/, '').replace(/[`'"]/g, '').replace(/\\/g, '/').replace(/^\.\//, ''))
  .filter(Boolean))].sort();
if (JSON.stringify(got) !== JSON.stringify(expected)) {
  console.log(`Wrong answer: ${JSON.stringify(got)}`);
  process.exit(1);
}
console.log('Correct.');
