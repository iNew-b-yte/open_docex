import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// LLD Part 1 §1.7. `@open-docex/source` makes imports of workspace packages resolve to their
// `src`, so tests run without a build. DOM parse/serialize tests opt in to jsdom with a
// `// @vitest-environment jsdom` comment.
const conditions = ['@open-docex/source', ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    name: 'shared',
    environment: 'node',
    // The repository scripts' tests run in this project (LLD Part 1 §1.9).
    include: ['test/**/*.test.ts', '../scripts/test/**/*.test.mjs'],
  },
});
