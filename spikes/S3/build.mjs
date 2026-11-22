// Bundles the spike into dist/bundle.js (classic script, so index.html works from file://).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  outfile: 'dist/bundle.js',
  absWorkingDir: import.meta.dirname,
});
