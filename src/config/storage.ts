import { defaultConfig, parseConfig, type DashboardConfig } from './schema';

export const STORAGE_KEY = 'gitdash.config.v1';
/** Key used before the rename to GitDash; moved to `STORAGE_KEY` on load. */
export const LEGACY_STORAGE_KEY = 'git-dash.config.v1';

/** Moves a config saved under the old key, unless one exists under the new key. */
function migrateLegacyKey(): void {
  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacy === null) return;
  if (localStorage.getItem(STORAGE_KEY) === null) localStorage.setItem(STORAGE_KEY, legacy);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

/** Loads the saved config, falling back to defaults if missing or invalid. */
export function loadConfig(): DashboardConfig {
  try {
    migrateLegacyKey();
  } catch (err) {
    console.warn('Could not move the saved config to its new key:', err instanceof Error ? err.message : err);
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw) return parseConfig(JSON.parse(raw));
  } catch (err) {
    console.warn('Ignoring invalid saved config:', err instanceof Error ? err.message : err);
  }
  return defaultConfig();
}

export function saveConfig(config: DashboardConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (err) {
    console.error('Could not save config:', err instanceof Error ? err.message : err);
  }
}
