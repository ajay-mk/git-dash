// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from './schema';
import { STORAGE_KEY, loadConfig } from './storage';

describe('loadConfig', () => {
  beforeEach(() => localStorage.clear());

  it('loads the saved config', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...defaultConfig(), theme: 'dark' }));

    expect(loadConfig().theme).toBe('dark');
  });

  it('falls back to defaults when nothing is saved', () => {
    expect(loadConfig()).toEqual(defaultConfig());
  });
});
