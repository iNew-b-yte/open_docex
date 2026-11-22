// ESLint flat config (LLD Part 1 §1.6): typescript-eslint `recommendedTypeChecked`, plus
// `no-restricted-imports` rules that enforce the HLD §5 dependency rule (client → shared ← server).
import { builtinModules } from 'node:module';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/** @param {string} name */
const escapeRegex = (name) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Forbids a package and every subpath of it.
 * @param {string[]} names
 * @param {string} message
 */
const packages = (names, message) => ({
  regex: `^(${names.map(escapeRegex).join('|')})(/.*)?$`,
  message,
});

const NODE_PREFIXED = { regex: '^node:', message: 'No Node.js built-ins here (HLD §5).' };
const NODE_BARE = packages(
  builtinModules.filter((name) => !name.startsWith('node:')),
  'No Node.js built-ins here (HLD §5).',
);
const REACT = { regex: '^react', message: 'React is used by @open-docex/client only.' };
const CLIENT = packages(['@open-docex/client'], 'Only adopters import @open-docex/client.');
const SERVER = packages(['@open-docex/server'], 'Only adopters import @open-docex/server.');

const SHARED_FORBIDDEN = [
  NODE_PREFIXED,
  NODE_BARE,
  REACT,
  packages(['ws'], 'shared is isomorphic: no server libraries (HLD §5).'),
  packages(['prosemirror-view', 'prosemirror-state'], 'shared has no editor view or state (HLD §5).'),
  { regex: '^@univerjs/', message: 'shared has no Univer code (HLD §5).' },
  SERVER,
  CLIENT,
];

const BACKEND_FORBIDDEN = [
  CLIENT,
  REACT,
  packages(['prosemirror-view'], 'The server has no editor view.'),
];

// Main-process modules (LLD Part 2 §1: api/, gateway/, supervisor/, channel/) may import only
// the protocol, errors and ids subpaths of shared, so ProseMirror stays out of the adopter's
// main process (N4).
const MAIN_PROCESS_FORBIDDEN = [
  ...BACKEND_FORBIDDEN,
  {
    regex: '^@open-docex/shared(?!/(protocol|errors|ids)$)',
    message: 'Main-process modules import only @open-docex/shared/{protocol,errors,ids} (N4).',
  },
];

const FRONTEND_FORBIDDEN = [SERVER, NODE_PREFIXED];

/** @param {object[]} patterns */
const restrict = (patterns) => ({ 'no-restricted-imports': ['error', { patterns }] });

export default defineConfig(
  { ignores: ['**/dist/**', 'coverage/**'] },
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Each package's tsconfig.test.json covers both src and test (LLD Part 1 §1.6).
        project: [
          './shared/tsconfig.test.json',
          './backend/tsconfig.test.json',
          './frontend/tsconfig.test.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Repository scripts and tool config files are not part of any package's TypeScript project,
  // so they are linted without type information.
  {
    files: ['**/*.{js,mjs,cjs}', '**/*.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // Ambient globals are declared with `declare var`, the form lib.dom.d.ts and @types/node use,
  // so the declarations merge with theirs instead of clashing.
  { files: ['shared/src/env.d.ts'], rules: { 'no-var': 'off' } },
  { files: ['shared/src/**'], rules: restrict(SHARED_FORBIDDEN) },
  { files: ['backend/src/**'], rules: restrict(BACKEND_FORBIDDEN) },
  {
    files: ['backend/src/{api,gateway,supervisor,channel}/**'],
    rules: restrict(MAIN_PROCESS_FORBIDDEN),
  },
  { files: ['frontend/src/**'], rules: restrict(FRONTEND_FORBIDDEN) },
);
