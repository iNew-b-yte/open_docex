// Bundles the page of the harness once per run: the built client (`frontend/dist/lib`) with its
// dependencies, as one script and one stylesheet, into a folder under `node_modules/.cache`.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

/** Where the bundled page is written; `server.mjs` serves it. */
export const pageDir = path.join(root, 'node_modules', '.cache', 'open-docex-e2e');

export default async function globalSetup() {
  for (const needed of ['frontend/dist/lib/index.js', 'backend/dist/index.js']) {
    if (!existsSync(path.join(root, needed))) throw new Error(`${needed} is missing: run \`npm run build\` before the e2e suite.`);
  }
  await build({
    root: here,
    configFile: false,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: pageDir,
      emptyOutDir: true,
      target: 'es2022',
      minify: false,
      lib: { entry: path.join(here, 'page-entry.mjs'), formats: ['iife'], name: 'odxPage', fileName: () => 'page.js', cssFileName: 'page' },
    },
  });
}
