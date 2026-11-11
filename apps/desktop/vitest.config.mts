/// <reference types='vitest' />
import { defineConfig } from 'vitest/config';

// Main-process (Node) unit tests. The renderer lives in apps/app and is tested there.
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/desktop',
  test: {
    name: 'desktop',
    watch: false,
    passWithNoTests: true,
    globals: false,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/desktop',
      provider: 'v8' as const,
    },
  },
});
