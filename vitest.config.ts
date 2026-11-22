import { defineConfig } from 'vitest/config';

// One Vitest project per package (LLD Part 1 §1.7). Each package has its own vitest.config.ts.
export default defineConfig({
  test: {
    projects: ['shared', 'backend', 'frontend'],
  },
});
