import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The Content-Security-Policy lives in src-tauri/tauri.conf.json, where Tauri
// applies it to the bundled app (with hashes for its own injected scripts).

export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed dev server port and handles its own console output.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: 'localhost',
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_'],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
