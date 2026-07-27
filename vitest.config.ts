import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts'],
      exclude: ['src/core/**/*.test.ts', 'src/core/templates/**'],
      // A regression ratchet set just below what the suite currently achieves,
      // not an aspiration. Branch coverage sits lower than line coverage because
      // much of the kernel is defensive error handling for provider and network
      // failures that are not worth simulating exhaustively.
      thresholds: { lines: 75, statements: 72, functions: 68, branches: 58 },
    },
  },
});
