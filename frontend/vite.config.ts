import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Library build of @open-docex/client (LLD Part 1 §1.5, Part 3 §1): ESM only, declarations
// from `tsc -b` (dist/types), CSS as dist/lib/style.css for the adopter to import. No <style>
// tag is injected at runtime, so the adopter's CSP stays theirs.

interface Manifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as Manifest;

// Every dependency and peer dependency, and their subpaths, stays external to the bundle
// (P1 §1.5). P3 §1 also names rxjs, prosemirror-* and @univerjs/*, which are listed here too so
// they stay external as soon as V2 adds them.
const externalNames = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
  'react',
  'react-dom',
  'rxjs',
  '@open-docex/shared',
];
const externalPrefixes = ['prosemirror-', '@univerjs/'];
const isExternal = (id: string): boolean =>
  externalNames.some((name) => id === name || id.startsWith(`${name}/`)) ||
  externalPrefixes.some((prefix) => id.startsWith(prefix));

export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist/lib',
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
      cssFileName: 'style',
    },
    rolldownOptions: {
      external: isExternal,
    },
  },
});
