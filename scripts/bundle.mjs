// Bundles the extension host code into dist/extension.js with esbuild.
//
//   node scripts/bundle.mjs              development build (source map, readable output)
//   node scripts/bundle.mjs --production minified build used by `vsce package` (vscode:prepublish)
//   node scripts/bundle.mjs --watch      rebuild on change
//
// `tsc` still runs separately (npm run compile) for type checking and for the tests, which execute from out/.
// `vscode` is provided by the editor. ssh2 is bundled too; its optional native add-ons are left out
// (it falls back to its pure-JavaScript crypto), so the package ships no node_modules at all.
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/host/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // ssh2's two native add-ons are optional (loaded in try/catch) and are not shipped, exactly as before bundling.
  external: ['vscode', 'cpu-features', '*.node'],
  sourcemap: production ? false : 'linked',
  minify: production,
  keepNames: true, // readable stack traces in the output channel and error reports
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('esbuild: watching src/ for changes');
} else {
  const result = await esbuild.build(options);
  const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
  console.log(`esbuild: dist/extension.js ${(bytes / 1024).toFixed(0)} KB${production ? ' (production)' : ''}`);
}
