import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Unit tests and benchmarks of pure frontend logic. Node environment (no DOM):
// components are tested through their pure helpers or `react-dom/server`.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    benchmark: {
      include: ['src/**/*.bench.ts'],
    },
  },
});
