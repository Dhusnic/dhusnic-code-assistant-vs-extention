'use strict';
// Grading script: copied into the repository only after the agent has finished. Checks the answer file.
const fs = require('node:fs');

let answer = '';
try { answer = fs.readFileSync('ANSWER.txt', 'utf8'); } catch { console.log('ANSWER.txt is missing'); process.exit(1); }
const numbers = answer.match(/\b\d{3}\b/g) ?? [];
if (numbers.length !== 1 || numbers[0] !== '404') { console.log(`Wrong answer: ${JSON.stringify(answer.trim())}`); process.exit(1); }
console.log('Correct.');
