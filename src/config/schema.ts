/**
 * Dashboard configuration: which repositories are pinned and what each one
 * shows. The config is not secret (tokens live in the OS keychain), but it can
 * be imported from a file, so everything is validated before use.
 */

import type { ProviderId } from '../providers/types';

export const CONFIG_VERSION = 1;

export const WIDGET_TYPES = ['ci', 'pullRequests', 'issues'] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const WIDGET_LABELS: Record<WidgetType, string> = {
  ci: 'CI status',
  pullRequests: 'Pull requests',
  issues: 'Issues',
};

export const MIN_ITEMS = 1;
export const MAX_ITEMS = 20;
export const MAX_REPOS = 50;
export const REFRESH_CHOICES = [0, 1, 2, 5, 10, 15, 30, 60] as const;
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export type WidgetConfig =
  | { type: 'ci' }
  | { type: 'pullRequests'; limit: number; hideDrafts: boolean }
  | { type: 'issues'; limit: number; label: string | null };

export interface PinnedRepo {
  provider: ProviderId;
  owner: string;
  name: string;
  /** Ordered list; order is the display order on the card. */
  widgets: WidgetConfig[];
}

export interface InboxConfig {
  enabled: boolean;
  reviewRequests: boolean;
  myPullRequests: boolean;
  assigned: boolean;
  limit: number;
}

export interface DashboardConfig {
  version: typeof CONFIG_VERSION;
  repos: PinnedRepo[];
  inbox: InboxConfig;
  /** Auto-refresh interval in minutes; 0 disables it. */
  refreshMinutes: number;
  theme: Theme;
}

// GitHub's rules: owners are 1-39 alphanumerics/hyphens, repo names are up to
// 100 characters of alphanumerics, '.', '-' and '_'.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
// Label names are free text on GitHub; we only bound the length and strip
// control characters.
const MAX_LABEL_LEN = 50;

export function defaultWidget(type: WidgetType): WidgetConfig {
  switch (type) {
    case 'ci':
      return { type: 'ci' };
    case 'pullRequests':
      return { type: 'pullRequests', limit: 5, hideDrafts: false };
    case 'issues':
      return { type: 'issues', limit: 5, label: null };
  }
}

export function defaultWidgets(): WidgetConfig[] {
  return WIDGET_TYPES.map(defaultWidget);
}

export function defaultConfig(): DashboardConfig {
  return {
    version: CONFIG_VERSION,
    repos: [],
    inbox: { enabled: true, reviewRequests: true, myPullRequests: true, assigned: true, limit: 10 },
    refreshMinutes: 5,
    theme: 'system',
  };
}

export function repoId(repo: Pick<PinnedRepo, 'provider' | 'owner' | 'name'>): string {
  return `${repo.provider}:${repo.owner}/${repo.name}`.toLowerCase();
}

/** Parses "owner/name" or a github.com URL. Returns null if invalid. */
export function parseRepoInput(input: string): { owner: string; name: string } | null {
  let value = input.trim();
  const urlMatch = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(value);
  if (urlMatch?.[1]) value = urlMatch[1];
  value = value.replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = value.split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name) || name === '.' || name === '..') return null;
  return { owner, name };
}

// ---------------------------------------------------------------------------
// Validation of untrusted input (localStorage, imported files)
// ---------------------------------------------------------------------------

export class ConfigError extends Error {}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function cleanLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_LABEL_LEN);
  return cleaned.length > 0 ? cleaned : null;
}

function parseWidget(raw: unknown): WidgetConfig | null {
  if (!isObj(raw) || typeof raw.type !== 'string') return null;
  switch (raw.type) {
    case 'ci':
      return { type: 'ci' };
    case 'pullRequests':
      return {
        type: 'pullRequests',
        limit: clampInt(raw.limit, MIN_ITEMS, MAX_ITEMS, 5),
        hideDrafts: bool(raw.hideDrafts, false),
      };
    case 'issues':
      return {
        type: 'issues',
        limit: clampInt(raw.limit, MIN_ITEMS, MAX_ITEMS, 5),
        label: cleanLabel(raw.label),
      };
    default:
      return null;
  }
}

function parseRepo(raw: unknown): PinnedRepo {
  if (!isObj(raw)) throw new ConfigError('Repository entry must be an object');
  if (raw.provider !== 'github') throw new ConfigError('Unsupported provider');
  if (typeof raw.owner !== 'string' || typeof raw.name !== 'string') {
    throw new ConfigError('Repository entry is missing owner/name');
  }
  const parsed = parseRepoInput(`${raw.owner}/${raw.name}`);
  if (!parsed) throw new ConfigError(`Invalid repository name: ${raw.owner}/${raw.name}`.slice(0, 200));

  const widgets: WidgetConfig[] = [];
  const seen = new Set<WidgetType>();
  if (Array.isArray(raw.widgets)) {
    for (const w of raw.widgets) {
      const widget = parseWidget(w);
      if (widget && !seen.has(widget.type)) {
        seen.add(widget.type);
        widgets.push(widget);
      }
    }
  }
  return { provider: 'github', ...parsed, widgets };
}

/** Validates an untrusted value and returns a well-formed config or throws. */
export function parseConfig(raw: unknown): DashboardConfig {
  if (!isObj(raw)) throw new ConfigError('Config must be a JSON object');
  if (raw.version !== CONFIG_VERSION) throw new ConfigError('Unsupported config version');
  if (!Array.isArray(raw.repos)) throw new ConfigError('Config is missing "repos"');
  if (raw.repos.length > MAX_REPOS) throw new ConfigError(`At most ${MAX_REPOS} repositories are supported`);

  const defaults = defaultConfig();
  const repos: PinnedRepo[] = [];
  const ids = new Set<string>();
  for (const entry of raw.repos) {
    const repo = parseRepo(entry);
    const id = repoId(repo);
    if (!ids.has(id)) {
      ids.add(id);
      repos.push(repo);
    }
  }

  const inboxRaw = isObj(raw.inbox) ? raw.inbox : {};
  const inbox: InboxConfig = {
    enabled: bool(inboxRaw.enabled, defaults.inbox.enabled),
    reviewRequests: bool(inboxRaw.reviewRequests, defaults.inbox.reviewRequests),
    myPullRequests: bool(inboxRaw.myPullRequests, defaults.inbox.myPullRequests),
    assigned: bool(inboxRaw.assigned, defaults.inbox.assigned),
    limit: clampInt(inboxRaw.limit, MIN_ITEMS, MAX_ITEMS, defaults.inbox.limit),
  };

  const refresh = (REFRESH_CHOICES as readonly number[]).includes(raw.refreshMinutes as number)
    ? (raw.refreshMinutes as number)
    : defaults.refreshMinutes;

  const theme = (THEMES as readonly unknown[]).includes(raw.theme) ? (raw.theme as Theme) : defaults.theme;

  return { version: CONFIG_VERSION, repos, inbox, refreshMinutes: refresh, theme };
}
