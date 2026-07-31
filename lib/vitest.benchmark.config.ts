import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/benchmarks/**/*.bench.ts'],
    root: '.',
    execArgv: ['--expose-gc'],
    benchmark: {
      reporters: ['default'],
      outputJson: './bench-results.json',
    },
  },
});
