import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  test: { name: 'web', include: ['tests/**/*.test.ts'], environment: 'node' },
});
