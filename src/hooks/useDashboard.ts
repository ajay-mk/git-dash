import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { repoId, type DashboardConfig, type PinnedRepo } from '../config/schema';
import { inboxBaseline } from '../lib/notify';
import { AppError } from '../lib/transport';
import { providers } from '../providers';
import type { InboxSnapshot, RateLimit, RepoResult } from '../providers/types';

export interface DashboardState {
  repos: Map<string, RepoResult>;
  inbox: InboxSnapshot | null;
  inboxError: string | null;
  error: AppError | null;
  loading: boolean;
  lastUpdated: Date | null;
  rateLimit: RateLimit | null;
}

const INITIAL: DashboardState = {
  repos: new Map(),
  inbox: null,
  inboxError: null,
  error: null,
  loading: false,
  lastUpdated: null,
  rateLimit: null,
};

const CONFIG_DEBOUNCE_MS = 400;

export function isAuthError(err: AppError | null): boolean {
  return err?.kind === 'unauthorized' || err?.kind === 'no_token';
}

/** The pinned repos in a fixed order, so reordering the cards is not a data change. */
function byId(repos: readonly PinnedRepo[]): PinnedRepo[] {
  return [...repos].sort((a, b) => (repoId(a) < repoId(b) ? -1 : repoId(a) > repoId(b) ? 1 : 0));
}

function asAppError(err: unknown): AppError {
  return err instanceof AppError ? err : new AppError('internal', 'Unexpected error');
}

/**
 * Loads dashboard data and keeps it fresh. Refreshes when the config changes,
 * on the configured interval, and when the window regains focus after the
 * data went stale. Polling pauses while the window is hidden, except for
 * "Needs you" while `onInboxChange` is set.
 */
export interface RefreshOptions {
  /** Only fetch "Needs you", leaving the cards as they are. */
  inboxOnly?: boolean;
  /** A token was added or replaced, so the next inbox starts a new baseline. */
  tokensChanged?: boolean;
}

/**
 * Called after a refresh with the previous and new "Needs you" snapshots,
 * when both were fetched with the same settings and tokens. `since` is when
 * `prev` was fetched.
 */
export type InboxChangeHandler = (prev: InboxSnapshot, next: InboxSnapshot, since: number) => void;

export function useDashboard(
  config: DashboardConfig,
  tokenOwners: readonly string[],
  enabled: boolean,
  onInboxChange?: InboxChangeHandler,
) {
  const [state, setState] = useState<DashboardState>(INITIAL);
  const requestId = useRef(0);
  const lastFetch = useRef(0);
  // Settings that produced the data on screen, so a failed refresh after a
  // settings change does not leave data fetched for the old settings.
  const shownKeys = useRef({ repos: '', inbox: '' });

  // Only refetch when data-affecting settings change (not theme, card order
  // etc.).
  const fetchKey = useMemo(
    () => JSON.stringify([byId(config.repos), config.inbox, tokenOwners]),
    [config.repos, config.inbox, tokenOwners],
  );
  const configRef = useRef(config);
  const ownersRef = useRef(tokenOwners);
  const onInboxChangeRef = useRef(onInboxChange);
  // The last inbox fetched, with its settings and time, to compare the next one against.
  const busy = useRef(false);
  const lastInbox = useRef<{ key: string; at: number; snapshot: InboxSnapshot } | null>(null);
  // Declared before the fetch effect so it runs first in the same commit.
  useEffect(() => {
    configRef.current = config;
    ownersRef.current = tokenOwners;
    onInboxChangeRef.current = onInboxChange;
    // Turning notifications off forgets the baseline, so changes made while
    // they were off are not reported once they are back on.
    if (!onInboxChange) lastInbox.current = null;
  }, [config, tokenOwners, onInboxChange]);

  const refresh = useCallback(async (options: RefreshOptions = {}) => {
    const { inboxOnly = false, tokensChanged = false } = options;
    // Data fetched with other tokens is no baseline for notifications.
    if (tokensChanged) lastInbox.current = null;
    const id = ++requestId.current;
    busy.current = true;
    const startedAt = Date.now();
    if (!inboxOnly) lastFetch.current = startedAt;
    // Drop auth errors right away so a freshly saved token leaves the setup
    // screen immediately; other errors stay visible until the reload finishes.
    setState((s) => ({ ...s, loading: true, error: s.error && isAuthError(s.error) ? null : s.error }));
    const { repos, inbox } = configRef.current;
    const owners = ownersRef.current;
    const keys = { repos: JSON.stringify([byId(repos), owners]), inbox: JSON.stringify([inbox, owners]) };
    const provider = providers.github;

    const [repoRes, inboxRes] = await Promise.allSettled([
      inboxOnly
        ? Promise.resolve(null)
        : repos.length > 0
          ? provider.fetchRepos(repos, owners)
          : Promise.resolve({ repos: new Map(), rateLimit: null }),
      inbox.enabled ? provider.fetchInbox(inbox, owners) : Promise.resolve(null),
    ]);
    if (id !== requestId.current) return; // a newer refresh superseded this one
    busy.current = false;

    if (inboxRes.status === 'fulfilled') {
      const prev = lastInbox.current?.key === keys.inbox ? lastInbox.current : null;
      const next = inboxRes.value;
      const onChange = onInboxChangeRef.current;
      // Nothing is kept while nobody watches (notifications or the sidebar
      // off), so turning them back on starts from a fresh baseline.
      // With a token's results missing, its items were last seen at the
      // previous comparison time, which therefore carries over.
      const at = next?.incomplete && prev ? prev.at : startedAt;
      lastInbox.current = next && onChange ? { key: keys.inbox, at, snapshot: inboxBaseline(prev?.snapshot, next) } : null;
      if (next && onChange && prev) onChange(prev.snapshot, next, prev.at);
    }

    setState((s) => {
      // An inbox-only refresh leaves the cards, and any error about them, as they are.
      const next: DashboardState = { ...s, loading: false, error: inboxOnly ? s.error : null };
      if (repoRes.status === 'fulfilled') {
        if (repoRes.value) {
        // Only fresh repository data counts as an update; after a failure the
        // cards still show the previous data and must not look current.
          next.lastUpdated = new Date();
          next.repos = repoRes.value.repos;
          next.rateLimit = repoRes.value.rateLimit ?? s.rateLimit;
          shownKeys.current.repos = keys.repos;
        }
      } else {
        next.error = asAppError(repoRes.reason);
        if (shownKeys.current.repos !== keys.repos) next.repos = new Map();
      }
      if (inboxRes.status === 'fulfilled') {
        next.inbox = inboxRes.value;
        next.inboxError = null;
        shownKeys.current.inbox = keys.inbox;
      } else {
        const err = asAppError(inboxRes.reason);
        next.inboxError = err.message;
        next.error ??= isAuthError(err) ? err : null;
        if (shownKeys.current.inbox !== keys.inbox) next.inbox = null;
      }
      return next;
    });
  }, []);

  // Debounced so that typing in settings (e.g. a label filter) does not
  // fire a request per keystroke.
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => void refresh(), CONFIG_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, fetchKey, refresh]);

  const watchInbox = onInboxChange !== undefined;
  useEffect(() => {
    if (!enabled || config.refreshMinutes <= 0) return;
    const intervalMs = config.refreshMinutes * 60_000;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
      // While hidden, only "Needs you" keeps updating, and only to notify.
      else if (watchInbox && !busy.current) void refresh({ inboxOnly: true });
    }, intervalMs);
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastFetch.current > intervalMs) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, config.refreshMinutes, refresh, watchInbox]);

  return { ...state, refresh };
}
