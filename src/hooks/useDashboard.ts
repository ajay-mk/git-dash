import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardConfig } from '../config/schema';
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

function asAppError(err: unknown): AppError {
  return err instanceof AppError ? err : new AppError('internal', 'Unexpected error');
}

/**
 * Loads dashboard data and keeps it fresh. Refreshes when the config changes,
 * on the configured interval, and when the window regains focus after the
 * data went stale. Polling pauses while the window is hidden.
 */
export function useDashboard(config: DashboardConfig, enabled: boolean) {
  const [state, setState] = useState<DashboardState>(INITIAL);
  const requestId = useRef(0);
  const lastFetch = useRef(0);

  // Only refetch when data-affecting settings change (not theme etc.).
  const fetchKey = useMemo(() => JSON.stringify([config.repos, config.inbox]), [config.repos, config.inbox]);
  const configRef = useRef(config);
  // Declared before the fetch effect so it runs first in the same commit.
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    lastFetch.current = Date.now();
    // Drop auth errors right away so a freshly saved token leaves the setup
    // screen immediately; other errors stay visible until the reload finishes.
    setState((s) => ({ ...s, loading: true, error: s.error && isAuthError(s.error) ? null : s.error }));
    const { repos, inbox } = configRef.current;
    const provider = providers.github;

    const [repoRes, inboxRes] = await Promise.allSettled([
      repos.length > 0 ? provider.fetchRepos(repos) : Promise.resolve({ repos: new Map(), rateLimit: null }),
      inbox.enabled ? provider.fetchInbox(inbox) : Promise.resolve(null),
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
      } else {
        next.error = asAppError(repoRes.reason);
      }
      if (inboxRes.status === 'fulfilled') {
        next.inbox = inboxRes.value;
        next.inboxError = null;
      } else {
        const err = asAppError(inboxRes.reason);
        next.inboxError = err.message;
        next.error ??= isAuthError(err) ? err : null;
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
