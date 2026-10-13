/**
 * Dashboard configuration: which repositories are pinned and what each one
 * shows. The config is not secret (tokens live in the OS keychain), but it can
 * be imported from a file, so everything is validated before use.
 */

import { PROVIDER_IDS, type ProviderId } from '../providers/types';

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
/** Widest a repo card can be, in grid columns. */
export const MAX_CARD_SPAN = 3;
/**
 * Card heights are kept in grid rows (see `.grid` in styles.css) so they
 * snap; these bound a saved height. A resize stops sooner, at the card's
 * header and its folded lists.
 */
export const MIN_CARD_ROWS = 6;
export const MAX_CARD_ROWS = 200;
export const REFRESH_CHOICES = [0, 1, 2, 5, 10, 15, 30, 60] as const;
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export type WidgetConfig =
  | { type: 'ci' }
  | { type: 'pullRequests'; limit: number; hideDrafts: boolean }
  | { type: 'issues'; limit: number; label: string | null };

export interface PinnedRepo {
  provider: ProviderId;
  /** GitHub account or organization, or GitLab namespace (`group/subgroup`). */
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

export const INBOX_SECTIONS = ['reviewRequests', 'myPullRequests', 'assigned'] as const;
export type InboxSection = (typeof INBOX_SECTIONS)[number];

export const PR_GROUPINGS = ['none', 'repo', 'status'] as const;
export type PrGrouping = (typeof PR_GROUPINGS)[number];

export const PR_GROUPING_LABELS: Record<PrGrouping, string> = {
  none: 'No grouping',
  repo: 'By repository',
  status: 'By status',
};

/**
 * How the sidebar and repo cards are laid out. Kept apart from the repo and
 * inbox settings because changing it should not refetch anything.
 */
export interface LayoutConfig {
  /** Sections the user has collapsed. */
  collapsedInbox: InboxSection[];
  /** How "Your pull requests" is grouped. */
  groupMyPullRequests: PrGrouping;
  /** Repo card widgets the user has collapsed, as `widgetKey()` values. */
  collapsedWidgets: string[];
  /** Repo cards wider than one grid column, by `repoId()`. */
  cardSpans: Record<string, number>;
  /** Repo cards with a height the user set, in grid rows, by `repoId()`. Others fit their content. */
  cardRows: Record<string, number>;
}

/**
 * The entries of `keys` that name a widget still on a pinned repo, in display
 * order, so removed repos and widgets do not linger.
 */
export function pinnedWidgetKeys(repos: readonly PinnedRepo[], keys: readonly unknown[]): string[] {
  return repos.flatMap((repo) =>
    repo.widgets.map((w) => widgetKey(repo, w.type)).filter((key) => keys.includes(key)),
  );
}

/** The card sizes in `raw` that are whole numbers in [min, max] and belong to a pinned repo. */
function pinnedCardSizes(repos: readonly PinnedRepo[], raw: unknown, min: number, max: number): Record<string, number> {
  const sizes: Record<string, number> = {};
  if (!isObj(raw)) return sizes;
  for (const repo of repos) {
    const id = repoId(repo);
    const size = Object.hasOwn(raw, id) ? raw[id] : undefined;
    if (typeof size === 'number' && Number.isInteger(size) && size >= min && size <= max) sizes[id] = size;
  }
  return sizes;
}

/** The card widths in `raw` that are valid and belong to a pinned repo. */
export function pinnedCardSpans(repos: readonly PinnedRepo[], raw: unknown): Record<string, number> {
  return pinnedCardSizes(repos, raw, 2, MAX_CARD_SPAN);
}

/** The card heights in `raw` that are valid and belong to a pinned repo. */
export function pinnedCardRows(repos: readonly PinnedRepo[], raw: unknown): Record<string, number> {
  return pinnedCardSizes(repos, raw, MIN_CARD_ROWS, MAX_CARD_ROWS);
}

/** Drops layout entries for repos and widgets that are no longer pinned. */
export function pruneLayout(config: DashboardConfig): DashboardConfig {
  const { layout } = config;
  const collapsedWidgets = pinnedWidgetKeys(config.repos, layout.collapsedWidgets);
  const cardSpans = pinnedCardSpans(config.repos, layout.cardSpans);
  const cardRows = pinnedCardRows(config.repos, layout.cardRows);
  if (
    collapsedWidgets.length === layout.collapsedWidgets.length &&
    Object.keys(cardSpans).length === Object.keys(layout.cardSpans).length &&
    Object.keys(cardRows).length === Object.keys(layout.cardRows).length
  ) {
    return config;
  }
  return { ...config, layout: { ...layout, collapsedWidgets, cardSpans, cardRows } };
}

/** Identifies one widget on one repo card. */
export function widgetKey(repo: Pick<PinnedRepo, 'provider' | 'owner' | 'name'>, type: WidgetType): string {
  return `${repoId(repo)}#${type}`;
}

export interface DashboardConfig {
  version: typeof CONFIG_VERSION;
  repos: PinnedRepo[];
  inbox: InboxConfig;
  layout: LayoutConfig;
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

/** Whether `owner` is a valid GitHub account or organization login. */
export function isValidOwner(owner: string): boolean {
  return OWNER_RE.test(owner);
}

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

/**
 * Grows or shrinks every list widget (pull requests, issues) by `delta`
 * entries, within the allowed range, keeping their differences. Widgets in
 * `skip` (such as collapsed ones) are left alone.
 */
export function shiftListLimits(
  widgets: readonly WidgetConfig[],
  delta: number,
  skip: readonly WidgetType[] = [],
): WidgetConfig[] {
  return widgets.map((w) => {
    if (w.type === 'ci' || skip.includes(w.type)) return w;
    const limit = Math.min(MAX_ITEMS, Math.max(MIN_ITEMS, w.limit + delta));
    // Unchanged widgets keep their identity, so callers can tell nothing moved.
    return limit === w.limit ? w : { ...w, limit };
  });
}

export function defaultWidgets(): WidgetConfig[] {
  return WIDGET_TYPES.map(defaultWidget);
}

export function defaultConfig(): DashboardConfig {
  return {
    version: CONFIG_VERSION,
    repos: [],
    inbox: { enabled: true, reviewRequests: true, myPullRequests: true, assigned: true, limit: 10 },
    layout: { collapsedInbox: [], groupMyPullRequests: 'none', collapsedWidgets: [], cardSpans: {}, cardRows: {} },
    refreshMinutes: 5,
    theme: 'system',
  };
}

export function repoId(repo: Pick<PinnedRepo, 'provider' | 'owner' | 'name'>): string {
  return `${repo.provider}:${repo.owner}/${repo.name}`.toLowerCase();
}

// GitLab's rules: a project path is one or more groups plus the project, each
// part letters, digits, '_', '-' and '.', not starting with '-' or '.' and not
// ending in '.', '.git' or '.atom'. Groups nest at most 20 deep.
const GITLAB_PART_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;
const MAX_GITLAB_PARTS = 21;
const MAX_GITLAB_PATH = 500;

function isGitLabPart(part: string): boolean {
  return GITLAB_PART_RE.test(part) && !part.endsWith('.') && !/\.(?:git|atom)$/i.test(part);
}

/** Splits a GitLab project path (`group/subgroup/project`). Returns null if invalid. */
export function parseGitLabPath(path: string): { owner: string; name: string } | null {
  const value = path.replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = value.split('/');
  if (parts.length < 2 || parts.length > MAX_GITLAB_PARTS || value.length > MAX_GITLAB_PATH) return null;
  if (!parts.every(isGitLabPart)) return null;
  return { owner: parts.slice(0, -1).join('/'), name: parts.at(-1)! };
}

/** A URL authority the way GitLab hosts are stored: lowercase, no default port. */
function canonicalHost(authority: string): string | null {
  if (/[@?#\\]/.test(authority)) return null;
  try {
    return new URL(`https://${authority}/`).host;
  } catch {
    return null;
  }
}

/**
 * Parses "group/project", "group/subgroup/project" or a URL of a page on the
 * GitLab instance `host` (such as a merge request). Returns null if invalid.
 */
export function parseGitLabInput(input: string, host: string): { owner: string; name: string } | null {
  let value = input.trim();
  const url = /^(?:https:\/\/)?([^/\s]+)\/(.+)$/i.exec(value);
  if (url?.[1] && canonicalHost(url[1]) === host.toLowerCase()) value = url[2]!;
  // Pages inside a project live under "/-/", e.g. "/-/merge_requests/1".
  value = value.replace(/\/-(?:\/.*)?$/, '').replace(/[?#].*$/, '');
  return parseGitLabPath(value);
}

/**
 * The provider a pasted URL belongs to: github.com, or the connected GitLab
 * instance. `null` for plain paths and other hosts.
 */
export function providerOfInput(input: string, gitlabHost: string | null): ProviderId | null {
  const authority = /^(?:https?:\/\/)?([^/\s]+)\//i.exec(input.trim())?.[1];
  const host = authority ? canonicalHost(authority) : null;
  if (host === 'github.com' || host === 'www.github.com') return 'github';
  if (gitlabHost && host === gitlabHost.toLowerCase()) return 'gitlab';
  return null;
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
  const provider = PROVIDER_IDS.find((p) => p === raw.provider);
  if (!provider) throw new ConfigError('Unsupported provider');
  if (typeof raw.owner !== 'string' || typeof raw.name !== 'string') {
    throw new ConfigError('Repository entry is missing owner/name');
  }
  const path = `${raw.owner}/${raw.name}`;
  const parsed = provider === 'github' ? parseRepoInput(path) : parseGitLabPath(path);
  // GitLab owners may contain '/', so the split must also match what was stored.
  const resplit = provider === 'gitlab' && (parsed?.owner !== raw.owner || parsed?.name !== raw.name);
  if (!parsed || resplit) {
    throw new ConfigError(`Invalid repository name: ${path}`.slice(0, 200));
  }

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
  return { provider, ...parsed, widgets };
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

  const layoutRaw = isObj(raw.layout) ? raw.layout : {};
  const collapsedInboxRaw: unknown[] = Array.isArray(layoutRaw.collapsedInbox) ? layoutRaw.collapsedInbox : [];
  const layout: LayoutConfig = {
    collapsedInbox: INBOX_SECTIONS.filter((section) => collapsedInboxRaw.includes(section)),
    groupMyPullRequests: (PR_GROUPINGS as readonly unknown[]).includes(layoutRaw.groupMyPullRequests)
      ? (layoutRaw.groupMyPullRequests as PrGrouping)
      : defaults.layout.groupMyPullRequests,
    collapsedWidgets: Array.isArray(layoutRaw.collapsedWidgets)
      ? pinnedWidgetKeys(repos, layoutRaw.collapsedWidgets)
      : [],
    cardSpans: pinnedCardSpans(repos, layoutRaw.cardSpans),
    cardRows: pinnedCardRows(repos, layoutRaw.cardRows),
  };

  const refresh = (REFRESH_CHOICES as readonly number[]).includes(raw.refreshMinutes as number)
    ? (raw.refreshMinutes as number)
    : defaults.refreshMinutes;

  const theme = (THEMES as readonly unknown[]).includes(raw.theme) ? (raw.theme as Theme) : defaults.theme;

  return { version: CONFIG_VERSION, repos, inbox, layout, refreshMinutes: refresh, theme };
}
