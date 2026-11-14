import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: { name: 'hdl-fuzz-run', include: ['run/**/*.fuzz.ts'], environment: 'node', testTimeout: 0, hookTimeout: 0 },
});
