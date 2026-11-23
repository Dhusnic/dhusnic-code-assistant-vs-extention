#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { validate } = require('../src/schema');

// Exit codes: 0 valid, 1 invalid content, 2 usage or read error. Errors go to stderr only.
function main(argv) {
  const file = argv[0];
  if (!file) { console.error('usage: validate-config <file>'); return 2; }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { console.error(`cannot read ${file}: ${e.message}`); return 2; }
  let cfg;
  try { cfg = JSON.parse(text); } catch (e) { console.error(`${file}: not valid JSON (${e.message})`); return 1; }
  const problems = validate(cfg);
  if (problems.length) { for (const p of problems) { console.error(p); } return 1; }
  console.log('OK');
  return 0;
}

process.exitCode = main(process.argv.slice(2));
