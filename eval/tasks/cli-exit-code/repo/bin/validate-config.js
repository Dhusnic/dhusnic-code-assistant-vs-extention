#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { validate } = require('../src/schema');

const file = process.argv[2];
if (!file) {
  console.log('usage: validate-config <file>');
} else {
  try {
    const problems = validate(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (problems.length) { for (const p of problems) { console.log(p); } } else { console.log('OK'); }
  } catch (e) {
    console.log(e.message);
  }
}
