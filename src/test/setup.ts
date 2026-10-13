/**
 * Setup for component tests. The Tauri bridge is mocked at the module
 * boundary for every DOM test, so no test can reach the real keychain or
 * network. Each test configures the mocks it needs; the defaults below fail
 * closed.
 */

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { setGitLabHost } from '../lib/url';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.reject(new Error('invoke must not be called in tests'))),
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(() => Promise.resolve(false)),
  requestPermission: vi.fn(() => Promise.resolve('denied')),
  sendNotification: vi.fn(),
}));

vi.mock('../lib/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/transport')>();
  const notMocked = () => Promise.reject(new actual.AppError('internal', 'not mocked in this test'));
  return {
    ...actual,
    tokens: {
      list: vi.fn(() => Promise.resolve({ hasDefault: false, defaultLogin: null, owners: [], host: null })),
      set: vi.fn(notMocked),
      clear: vi.fn(() => Promise.resolve()),
    },
    githubGraphql: vi.fn(notMocked),
    gitlabGraphql: vi.fn(notMocked),
    openExternalUrl: vi.fn(() => Promise.resolve()),
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  setGitLabHost(null);
  delete document.documentElement.dataset.theme;
  // Restores each mock to the default implementation given above.
  vi.resetAllMocks();
});
