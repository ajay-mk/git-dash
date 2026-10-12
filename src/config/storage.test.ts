// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from './schema';
import { LEGACY_STORAGE_KEY, STORAGE_KEY, loadConfig } from './storage';

describe('loadConfig', () => {
  beforeEach(() => localStorage.clear());

  it('moves a config saved under the old key', () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ ...defaultConfig(), theme: 'dark' }));

    expect(loadConfig().theme).toBe('dark');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({ theme: 'dark' });
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it('keeps the config under the new key when both exist', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...defaultConfig(), theme: 'light' }));
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ ...defaultConfig(), theme: 'dark' }));

    expect(loadConfig().theme).toBe('light');
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it('falls back to defaults when nothing is saved', () => {
    expect(loadConfig()).toEqual(defaultConfig());
  });
});
