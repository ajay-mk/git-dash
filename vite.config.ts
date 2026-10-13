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
    // Pure logic tests run in plain Node; component tests get a DOM. Keeping
    // them apart keeps the pure tests fast.
    projects: [
      {
        extends: true,
        test: { name: 'unit', environment: 'node', include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'] },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'happy-dom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['src/test/setup.ts'],
        },
      },
    ],
  },
});
