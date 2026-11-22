import { defaultServerConditions } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';

// LLD Part 1 §1.7. Tests that need a real LibreOffice (`*.lo.test.ts`) run only when
// OPEN_DOCEX_LO_TESTS=1 (CI sets it). `@open-docex/source` makes `@open-docex/shared`
// resolve to its `src`, so tests run without a build (LLD Part 1 §1.3).
const runLibreOfficeTests = process.env['OPEN_DOCEX_LO_TESTS'] === '1';
const conditions = ['@open-docex/source', ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    name: 'backend',
    environment: 'node',
    pool: 'forks',
    include: ['test/**/*.test.ts'],
    exclude: runLibreOfficeTests
      ? configDefaults.exclude
      : [...configDefaults.exclude, '**/*.lo.test.ts'],
  },
});
