import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// LLD Part 1 §1.7. Tests that need a real LibreOffice (`*.lo.test.ts`) are always collected
// and use `describe.skipIf(process.env.OPEN_DOCEX_LO_TESTS !== '1')`, so without
// OPEN_DOCEX_LO_TESTS=1 (CI sets it) they are listed as skipped. `@open-docex/source` makes `@open-docex/shared`
// resolve to its `src`, so tests run without a build (LLD Part 1 §1.3).
const conditions = ['@open-docex/source', ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    name: 'backend',
    environment: 'node',
    pool: 'forks',
    include: ['test/**/*.test.ts'],
  },
});
