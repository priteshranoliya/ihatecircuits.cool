import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'hdl-fuzz', include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 120_000 },
});
