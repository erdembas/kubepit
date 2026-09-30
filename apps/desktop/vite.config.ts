import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  // The published browser demo lives beside the website on GitHub Pages.
  // Desktop and local UI development keep Vite's normal root base.
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  clearScreen: false,
  build: {
    // xterm.js v6 is mis-minified by esbuild's identifier mangler (xterm #5800);
    // terser keeps DECRQM-using TUIs (k9s, htop, vim inside pods) working.
    minify: 'terser' as const,
    chunkSizeWarningLimit: 4096,
  },
  server: {
    port: 1430,
    strictPort: true,
    host: host ?? false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
}));
