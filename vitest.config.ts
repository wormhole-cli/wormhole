import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    maxWorkers: 2,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/adapters/types.ts'],
      reporter: ['text', 'html'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 80 },
    },
  },
});
