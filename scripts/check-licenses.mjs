// Licence allowlist check (LLD Part 1 §1.9, §0 L-1).
//
// Every installed package in the production and peer dependency trees of the workspaces must
// carry an SPDX licence expression that the allowlist satisfies, or be listed in
// licence-exceptions.json. Violations there fail (exit code 1). Violations in dev-only
// dependencies are reported but do not fail (L-1).
//
// Usage: npm run check:licenses
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ALLOWED_LICENCES = Object.freeze([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
]);

const EXCEPTION_FIELDS = ['name', 'version', 'licence', 'reason', 'approvedBy'];

/**
 * Splits an SPDX expression into tokens: "(", ")", operators and identifiers.
 * Returns null when the expression contains characters SPDX does not allow.
 * @param {string} expression
 * @returns {string[] | null}
 */
function tokenize(expression) {
  const tokens = [];
  const re = /\s*(?:([()])|([A-Za-z0-9.:+-]+))/y;
  let index = 0;
  while (index < expression.length) {
    if (/^\s*$/.test(expression.slice(index))) break;
    re.lastIndex = index;
    const match = re.exec(expression);
    if (!match) return null;
    tokens.push(match[1] ?? match[2]);
    index = re.lastIndex;
  }
  return tokens;
}

/**
 * Evaluates an SPDX licence expression against an allowlist.
 *
 * - `A OR B` is allowed when any alternative is allowed.
 * - `A AND B` is allowed only when every part is allowed.
 * - Parentheses group. `WITH` binds tighter than `AND`, which binds tighter than `OR`.
 * - `X WITH exception` is never allowed: an exception changes the licence terms.
 * - Unknown identifiers (including `LicenseRef-…` and `X+`) are not allowed.
 * - Identifiers match case-insensitively; operators must be upper case (SPDX annex D).
 * - Anything that does not parse is not allowed (fail closed).
 *
 * @param {string} expression
 * @param {readonly string[]} [allowed]
 * @returns {boolean}
 */
export function evalSpdx(expression, allowed = ALLOWED_LICENCES) {
  if (typeof expression !== 'string') return false;
  const tokens = tokenize(expression);
  if (!tokens || tokens.length === 0) return false;
  const allowedLower = new Set(allowed.map((id) => id.toLowerCase()));
  const OPERATORS = new Set(['AND', 'OR', 'WITH']);
  let pos = 0;

  const peek = () => tokens[pos];
  const fail = () => {
    throw new SyntaxError(`Invalid SPDX expression: ${expression}`);
  };
  const isIdentifier = (token) =>
    token !== undefined && token !== '(' && token !== ')' && !OPERATORS.has(token);

  // or := and ('OR' and)*
  const parseOr = () => {
    let value = parseAnd();
    while (peek() === 'OR') {
      pos += 1;
      const right = parseAnd();
      value = value || right;
    }
    return value;
  };
  // and := with ('AND' with)*
  const parseAnd = () => {
    let value = parseWith();
    while (peek() === 'AND') {
      pos += 1;
      const right = parseWith();
      value = value && right;
    }
    return value;
  };
  // with := atom ('WITH' exception-id)?
  const parseWith = () => {
    const value = parseAtom();
    if (peek() !== 'WITH') return value;
    pos += 1;
    if (!isIdentifier(peek())) fail();
    pos += 1;
    return false;
  };
  // atom := '(' or ')' | licence-id
  const parseAtom = () => {
    const token = peek();
    if (token === '(') {
      pos += 1;
      const value = parseOr();
      if (peek() !== ')') fail();
      pos += 1;
      return value;
    }
    if (!isIdentifier(token)) fail();
    pos += 1;
    return allowedLower.has(token.toLowerCase());
  };

  try {
    const value = parseOr();
    return pos === tokens.length && value;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/**
 * Validates the parsed content of licence-exceptions.json:
 * an array of `{ name, version, licence, reason, approvedBy }`, every field a non-empty string.
 * @param {unknown} data
 * @returns {{ name: string, version: string, licence: string, reason: string, approvedBy: string }[]}
 */
export function parseExceptions(data) {
  if (!Array.isArray(data)) {
    throw new TypeError('licence-exceptions.json must contain an array');
  }
  data.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TypeError(`licence exception #${index} must be an object`);
    }
    for (const field of EXCEPTION_FIELDS) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        throw new TypeError(`licence exception #${index} needs a non-empty string "${field}"`);
      }
    }
  });
  return data;
}

/**
 * Returns the packages whose licence is not allowed and that have no exception.
 * An exception applies to one exact package name and version.
 * @param {{ name: string, version: string, license?: unknown }[]} nodes
 * @param {{ name: string, version: string }[]} exceptions
 * @returns {{ name: string, version: string, license: unknown }[]}
 */
export function findViolations(nodes, exceptions) {
  const seen = new Set();
  const violations = [];
  for (const node of nodes) {
    const key = `${node.name}@${node.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A legacy object/array licence field, or a missing one, is unknown and therefore not allowed.
    const ok = typeof node.license === 'string' && evalSpdx(node.license);
    const excepted = exceptions.some((e) => e.name === node.name && e.version === node.version);
    if (!ok && !excepted) violations.push({ name: node.name, version: node.version, license: node.license });
  }
  return violations;
}

/**
 * Runs npm with fixed arguments and returns its stdout. Under `npm run`, npm's own CLI script
 * is run with this Node binary, so no shell is involved.
 * @param {string[]} args fixed strings from this script, never input
 * @param {string} cwd
 */
function runNpm(args, cwd) {
  const options = { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 };
  const npmCli = process.env.npm_execpath;
  if (npmCli && /\.[cm]?js$/.test(npmCli)) {
    return execFileSync(process.execPath, [npmCli, ...args], options);
  }
  if (process.platform !== 'win32') return execFileSync('npm', args, options);
  // On Windows npm is a .cmd shim, which only runs through a shell. The arguments are fixed.
  if (!args.every((arg) => /^[\w.:-]+$/.test(arg))) throw new Error('unsafe npm argument');
  return execSync(`npm ${args.join(' ')}`, options);
}

/** @param {string} selector @param {string} cwd */
const query = (selector, cwd) => JSON.parse(runNpm(['query', selector], cwd));

/** @param {{ name: string, version: string, license: unknown }[]} list */
const formatList = (list) =>
  list.map((v) => `  ${v.name}@${v.version}: ${JSON.stringify(v.license ?? null)}`).join('\n');

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const exceptions = parseExceptions(
    JSON.parse(readFileSync(new URL('./licence-exceptions.json', import.meta.url), 'utf8')),
  );

  // The root project and the workspaces are this repository's own MIT packages.
  const ownLocations = new Set(['', ...query('.workspace', root).map((n) => n.location)]);
  const external = (nodes) => nodes.filter((n) => !ownLocations.has(n.location));

  // `.peer` also matches peers of dev tools (and their subtrees). Those carry npm's `dev` flag,
  // and per L-1 dev-only packages are only reported.
  const prodAndPeer = external([...query('.prod', root), ...query('.peer', root)]);
  const enforced = prodAndPeer.filter((n) => n.dev !== true);
  const devOnly = external(query('.dev', root));

  const failures = findViolations(enforced, exceptions);
  const devReports = findViolations(devOnly, exceptions);

  if (devReports.length > 0) {
    console.log(`Dev-only packages outside the licence allowlist (reported, not failed):\n${formatList(devReports)}`);
  }
  if (failures.length > 0) {
    console.error(`Production/peer packages outside the licence allowlist:\n${formatList(failures)}`);
    console.error(`Allowed: ${ALLOWED_LICENCES.join(', ')}. Exceptions: scripts/licence-exceptions.json.`);
    process.exitCode = 1;
    return;
  }
  const checked = new Set(enforced.map((n) => `${n.name}@${n.version}`)).size;
  console.log(`Licence check passed: ${checked} production/peer packages, all allowed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
