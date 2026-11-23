'use strict';
// Grading script: copied into the repository only after the agent has finished. Checks the answer file.
const fs = require('node:fs');

const expected = 'ACME_UPLOAD_ROOT=/var/lib/acme/uploads';
let answer = '';
try { answer = fs.readFileSync('ANSWER.txt', 'utf8'); } catch { console.log('ANSWER.txt is missing'); process.exit(1); }
const line = answer.split(/\r?\n/).map((l) => l.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/\s*=\s*/, '=')).find((l) => l);
if (line !== expected) { console.log(`Wrong answer: "${line ?? ''}"`); process.exit(1); }
console.log('Correct.');
