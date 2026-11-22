import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// LLD Part 1 §1.7. `@open-docex/source` makes `@open-docex/shared` resolve to its `src`,
// so tests run without a build.
const conditions = ['@open-docex/source', ...defaultClientConditions];

export default defineConfig({
  resolve: { conditions },
  test: {
    name: 'frontend',
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
