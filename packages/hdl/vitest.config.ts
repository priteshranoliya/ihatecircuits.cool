import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'hdl', include: ['tests/**/*.test.ts'], environment: 'node' },
});
