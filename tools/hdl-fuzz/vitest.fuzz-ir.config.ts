import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: { name: 'hdl-fuzz-ir', include: ['run-ir/**/*.fuzz.ts'], environment: 'node', testTimeout: 0, hookTimeout: 0 },
});
