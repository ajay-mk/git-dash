/**
 * Setup for component tests. The Tauri bridge is mocked at the module
 * boundary for every DOM test, so no test can reach the real keychain or
 * network. Each test configures the mocks it needs; the defaults below fail
 * closed.
 */

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.reject(new Error('invoke must not be called in tests'))),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lib/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/transport')>();
  const notMocked = () => Promise.reject(new actual.AppError('internal', 'not mocked in this test'));
  return {
    ...actual,
    tokens: {
      status: vi.fn(() => Promise.resolve(false)),
      set: vi.fn(notMocked),
      clear: vi.fn(() => Promise.resolve()),
    },
    githubGraphql: vi.fn(notMocked),
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  // Restores each mock to the default implementation given above.
  vi.resetAllMocks();
});
