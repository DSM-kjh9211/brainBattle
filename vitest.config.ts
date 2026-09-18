import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@brainbattle/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/server/test/**/*.test.ts', 'apps/web/src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
