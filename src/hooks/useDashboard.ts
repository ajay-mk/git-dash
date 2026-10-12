import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { repoId, type DashboardConfig, type PinnedRepo } from '../config/schema';
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
 * data went stale. Polling pauses while the window is hidden.
 */
export function useDashboard(config: DashboardConfig, tokenOwners: readonly string[], enabled: boolean) {
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
  // Declared before the fetch effect so it runs first in the same commit.
  useEffect(() => {
    configRef.current = config;
    ownersRef.current = tokenOwners;
  }, [config, tokenOwners]);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    lastFetch.current = Date.now();
    // Drop auth errors right away so a freshly saved token leaves the setup
    // screen immediately; other errors stay visible until the reload finishes.
    setState((s) => ({ ...s, loading: true, error: s.error && isAuthError(s.error) ? null : s.error }));
    const { repos, inbox } = configRef.current;
    const owners = ownersRef.current;
    const keys = { repos: JSON.stringify([byId(repos), owners]), inbox: JSON.stringify([inbox, owners]) };
    const provider = providers.github;

    const [repoRes, inboxRes] = await Promise.allSettled([
      repos.length > 0 ? provider.fetchRepos(repos, owners) : Promise.resolve({ repos: new Map(), rateLimit: null }),
      inbox.enabled ? provider.fetchInbox(inbox, owners) : Promise.resolve(null),
    ]);
    if (id !== requestId.current) return; // a newer refresh superseded this one

    setState((s) => {
      const next: DashboardState = { ...s, loading: false, error: null };
      if (repoRes.status === 'fulfilled') {
        // Only fresh repository data counts as an update; after a failure the
        // cards still show the previous data and must not look current.
        next.lastUpdated = new Date();
        next.repos = repoRes.value.repos;
        next.rateLimit = repoRes.value.rateLimit ?? s.rateLimit;
        shownKeys.current.repos = keys.repos;
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

  useEffect(() => {
    if (!enabled || config.refreshMinutes <= 0) return;
    const intervalMs = config.refreshMinutes * 60_000;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, intervalMs);
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastFetch.current > intervalMs) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, config.refreshMinutes, refresh]);

  return { ...state, refresh };
}
