import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    root: '.',
  },
  resolve: {
    alias: {
      '@opencode-pr-agent/lib': path.resolve(__dirname, '../lib/src/index.ts'),
    },
  },
});
