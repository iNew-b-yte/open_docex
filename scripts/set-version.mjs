// Sets the lockstep version of all three packages (LLD Part 1 §1.11).
//
// Writes <x.y.z> to the shared, server and client manifests, pins @open-docex/shared to exactly
// <x.y.z> in the server and the client, then refreshes package-lock.json.
//
// Usage: node scripts/set-version.mjs <x.y.z>
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHARED = '@open-docex/shared';
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const version = process.argv[2];
if (process.argv.length !== 3 || !version || !VERSION_RE.test(version)) {
  console.error('Usage: node scripts/set-version.mjs <x.y.z>');
  process.exit(1);
}

const root = fileURLToPath(new URL('..', import.meta.url));

for (const folder of ['shared', 'backend', 'frontend']) {
  const file = new URL(`../${folder}/package.json`, import.meta.url);
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.version = version;
  if (folder !== 'shared') {
    pkg.dependencies = { ...pkg.dependencies, [SHARED]: version };
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${pkg.name} -> ${version}`);
}

// Refresh the lockfile. Under `npm run`, npm's own CLI script runs with this Node binary;
// otherwise npm is started directly. The arguments are fixed strings, never input.
const args = ['install', '--package-lock-only'];
const options = { cwd: root, stdio: 'inherit' };
const npmCli = process.env.npm_execpath;
if (npmCli && /\.[cm]?js$/.test(npmCli)) {
  execFileSync(process.execPath, [npmCli, ...args], options);
} else if (process.platform !== 'win32') {
  execFileSync('npm', args, options);
} else {
  // On Windows npm is a .cmd shim, which only runs through a shell.
  execSync(`npm ${args.join(' ')}`, options);
}
