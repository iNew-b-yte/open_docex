// Lockstep version check (LLD Part 1 §1.11).
//
// Fails unless @open-docex/shared, @open-docex/server and @open-docex/client carry the same
// version, and the server and the client both pin @open-docex/shared to exactly that version.
//
// Usage: npm run check:versions
import { readFileSync } from 'node:fs';

const SHARED = '@open-docex/shared';

/** @param {string} folder one of this repository's package folders */
const readManifest = (folder) =>
  JSON.parse(readFileSync(new URL(`../${folder}/package.json`, import.meta.url), 'utf8'));

const shared = readManifest('shared');
const server = readManifest('backend');
const client = readManifest('frontend');

const errors = [];
const version = shared.version;
for (const pkg of [server, client]) {
  if (pkg.version !== version) {
    errors.push(`${pkg.name} is ${pkg.version}, but ${SHARED} is ${version}.`);
  }
  const pin = pkg.dependencies?.[SHARED];
  if (pin !== version) {
    errors.push(`${pkg.name} depends on ${SHARED} "${pin}", but it must pin exactly "${version}".`);
  }
}

if (errors.length > 0) {
  console.error(`Version check failed:\n  ${errors.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log(`Version check passed: all packages are ${version} and pin ${SHARED}@${version}.`);
}
