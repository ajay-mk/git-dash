import { defaultConfig, parseConfig, type DashboardConfig } from './schema';

export const STORAGE_KEY = 'isitgreen.config.v1';

/** Loads the saved config, falling back to defaults if missing or invalid. */
export function loadConfig(): DashboardConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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
