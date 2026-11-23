'use strict';

const ITEMS = [
  { name: 'apple', count: 3 },
  { name: 'banana', count: 5 },
  { name: 'cherry', count: 0 },
];

/**
 * Runs the CLI with the given arguments and returns what it prints.
 *   list          items in stock, one "name count" per line
 *   list --all    every item, including those with count 0
 */
function run(args, items = ITEMS) {
  const [command, ...rest] = args;
  if (command === 'list') {
    const shown = rest.includes('--all') ? items : items.filter((i) => i.count > 0);
    if (rest.includes('--json')) { return JSON.stringify(shown.map((i) => ({ name: i.name, count: i.count })), null, 2); }
    return shown.map((i) => `${i.name} ${i.count}`).join('\n');
  }
  return `Unknown command: ${command ?? '(none)'}`;
}

module.exports = { run, ITEMS };

if (require.main === module) {
  console.log(run(process.argv.slice(2)));
}
