import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Library build of @open-docex/client (LLD Part 1 §1.5). Minimal V1-00 settings;
// V1-30 completes this file (LLD Part 3 §1).

interface Manifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as Manifest;

// Every dependency and peer dependency, and their subpaths, stays external to the bundle.
const externalNames = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
];
const isExternal = (id: string): boolean =>
  externalNames.some((name) => id === name || id.startsWith(`${name}/`));

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
